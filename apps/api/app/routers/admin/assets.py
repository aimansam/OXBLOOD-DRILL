"""Orphan asset listing and cleanup."""

from __future__ import annotations

from typing import Annotated, Any

import structlog
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    status,
)
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Role, TokenData, require_role
from app.db.session import get_session
from app.runners.runner import build_runner
from app.services import orphan_cleanup as orphan_svc
from app.services.proxmox import (
    ProxmoxAPIError,
)

log = structlog.get_logger()

# Router-level gate: every endpoint requires an admin token.
router = APIRouter(dependencies=[Depends(require_role(Role.ADMIN))])


# -- orphan-asset janitor (Q22) -------------------------------------------
#
# Iterates Asset rows where status == ORPHANED (set by the Q17 teardown
# loop when destroy_vm failed) and retries the destroy. Two flavours:
#
#   * GET  /assets/orphans   -- dry-run preview, used by the UI's modal
#   * POST /assets/cleanup   -- actually calls destroy_vm. Idempotent.
#
# Both honour the same skip rules (grace period, live runs, missing
# VMID). The runner gives us the same adapter that started the drill,
# so credentials + node config match.


class OrphanCandidate(BaseModel):
    """One asset row that's a cleanup candidate."""

    source: str = "db_orphan"
    asset_id: int
    run_id: int
    run_status: str
    role: str
    pve_vmid: int | None
    pve_node: str | None
    pve_name: str | None = None
    reason: str | None = None
    error: str | None
    age_seconds: int


class OrphanListResponse(BaseModel):
    items: list[OrphanCandidate]
    total: int


class CleanupFailureItem(BaseModel):
    asset_id: int
    run_id: int
    pve_vmid: int | None
    error: str


class CleanupRequest(BaseModel):
    """Body for POST /assets/cleanup.

    ``asset_ids``: when set, only these ids are considered; ``null``
    means "every orphan" (subject to grace + run-status filters).
    ``grace_minutes``: skip orphans younger than this; default 5.
    """

    asset_ids: list[int] | None = None
    pve_vms: list[dict[str, Any]] | None = None
    grace_minutes: int = Field(default=5, ge=0, le=1440)


class CleanupResponse(BaseModel):
    scanned: int
    destroyed: int
    destroyed_pve: int = 0
    failed: list[CleanupFailureItem]
    skipped_running: list[int]


@router.get(
    "/assets/orphans",
    summary="List Asset rows in ORPHANED state (dry-run cleanup preview)",
)
async def list_orphan_assets(
    db: Annotated[AsyncSession, Depends(get_session)],
    grace_minutes: int = 5,
    asset_ids: str | None = None,
    token: Annotated[TokenData | None, Depends(require_role(Role.ADMIN))] = None,
) -> OrphanListResponse:
    """Preview what ``POST /assets/cleanup`` would do.

    ``asset_ids`` is a comma-separated list (query string), ``null``
    means every orphan.
    """
    ids: list[int] | None = None
    if asset_ids:
        try:
            ids = [int(s) for s in asset_ids.split(",") if s.strip()]
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"asset_ids must be comma-separated ints: {exc}",
            ) from exc
    candidates = await orphan_svc.list_orphans(db, grace_minutes=grace_minutes, asset_ids=ids)
    try:
        pve_candidates = (
            []
            if ids is not None
            else await orphan_svc.list_pve_unused_vms(db, grace_minutes=grace_minutes)
        )
    except ProxmoxAPIError as exc:
        # Same mapping as the cleanup endpoint: PVE down is a 502, not a crash.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PVE unreachable: {exc}",
        ) from exc
    return OrphanListResponse(
        items=[
            OrphanCandidate(
                source="db_orphan",
                asset_id=c.asset_id,
                run_id=c.run_id,
                run_status=c.run_status,
                role=c.role,
                pve_vmid=c.pve_vmid,
                pve_node=c.pve_node,
                reason="DB asset status is orphaned",
                error=c.error,
                age_seconds=c.age_seconds,
            )
            for c in candidates
        ]
        + [
            OrphanCandidate(
                source="pve_unused",
                asset_id=c.asset_id or 0,
                run_id=c.run_id or 0,
                run_status="unused",
                role=c.role or "unknown",
                pve_vmid=c.vmid,
                pve_node=c.node,
                pve_name=c.name,
                reason=c.reason,
                error=None,
                age_seconds=c.age_seconds,
            )
            for c in pve_candidates
        ],
        total=len(candidates) + len(pve_candidates),
    )


@router.post(
    "/assets/cleanup",
    summary="Retry destroy_vm on ORPHANED assets (idempotent)",
)
async def cleanup_orphan_assets(
    body: CleanupRequest,
    db: Annotated[AsyncSession, Depends(get_session)],
    token: Annotated[TokenData | None, Depends(require_role(Role.ADMIN))] = None,
) -> CleanupResponse:
    """Best-effort destroy every orphan matching the request body.

    Successful releases flip ``Asset.status`` to STOPPED and stamp
    ``cleaned_at``; failed retries stay ORPHANED with a fresh error.
    Each success writes one ``asset.cleaned`` audit row with
    ``actor = token.sub``.
    """
    actor = getattr(token, "sub", "unknown") if token else "unknown"
    runner = build_runner()
    adapter = runner._adapter  # noqa: SLF001 -- janitor uses the same
    # adapter that runs drills, so credentials + node match.
    try:
        result = await orphan_svc.cleanup_orphans(
            db,
            adapter,
            actor,
            grace_minutes=body.grace_minutes,
            asset_ids=body.asset_ids,
        )
        if body.pve_vms:
            pve_result = await orphan_svc.cleanup_pve_unused_vms(
                db,
                adapter,
                actor,
                targets=body.pve_vms,
            )
            result.scanned += pve_result.scanned
            result.destroyed += pve_result.destroyed
            result.destroyed_pve += pve_result.destroyed_pve
            result.failed.extend(pve_result.failed)
            result.skipped_running.extend(pve_result.skipped_running)
    except ProxmoxAPIError as exc:
        # PVE-side failure: return 502 rather than crashing 500.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PVE unreachable: {exc}",
        ) from exc
    return CleanupResponse(
        scanned=result.scanned,
        destroyed=result.destroyed,
        destroyed_pve=result.destroyed_pve,
        failed=[
            CleanupFailureItem(
                asset_id=f.asset_id,
                run_id=f.run_id,
                pve_vmid=f.pve_vmid,
                error=f.error,
            )
            for f in result.failed
        ],
        skipped_running=result.skipped_running,
    )
