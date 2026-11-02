"""Stored Proxmox connection config endpoints."""

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
from app.services import pve_config as pve_config_svc
from app.services.proxmox import (
    ProxmoxAPIError,
    ProxmoxNotConfiguredError,
    list_storage,
)

log = structlog.get_logger()

# Router-level gate: every endpoint requires an admin token.
router = APIRouter(dependencies=[Depends(require_role(Role.ADMIN))])


# ---------------------------------------------------------------------------
# PVE runtime config (day-1 web setup; precedes Step0 in the wizard)
# ---------------------------------------------------------------------------
#
# These three endpoints let the onboarding wizard collect the PVE host /
# user / token from the browser instead of requiring ``deploy/.env``
# edits + container restart. ``POST`` probes PVE first (so a typo is
# surfaced before commit), then writes the singleton row in
# ``pve_config``. The very next PVE call (admin probe, run start,
# template upload, etc.) honors the new credentials because the
# admin router calls ``set_db_overlay`` after the commit, which
# drops both ``get_proxmox_client``'s LRU cache and the TTL cache.
#
# ``GET`` returns either the DB row (token_secret masked) or the env-var
# fallback if no row exists, with ``source`` set accordingly so the
# wizard can render a banner.
#
# ``DELETE`` drops the DB row and reverts to env-var resolution. Useful
# as an escape hatch: an operator who wants to "go back to .env" can do
# it from the admin UI without touching the host.


class PveConfigPayload(BaseModel):
    """Request body for ``POST /api/v1/admin/pve-config``.

    The token_secret is in the clear because we need to hand it to
    proxmoxer; the response always masks it. We never log it.
    """

    host: str = Field(..., min_length=1, max_length=255, description="e.g. https://192.168.0.10")
    port: int = Field(default=8006, ge=1, le=65535)
    user: str = Field(..., min_length=1, max_length=255, description="e.g. divide@pve@pam")
    token_id: str = Field(
        ..., min_length=1, max_length=255, description="e.g. divide@pve@pam!drill-token"
    )
    token_secret: str = Field(..., min_length=1, max_length=255)
    verify_ssl: bool = Field(
        default=False, description="False for self-signed certs (default for home/lab PVE)"
    )
    node: str | None = Field(
        default=None, max_length=64, description="Optional node name; auto-detected when omitted"
    )
    clone_storage: str = Field(default="", max_length=64)
    seed_snippet_storage: str = Field(default="", max_length=64)


def _storage_check(
    storages: list[dict[str, Any]],
    storage_name: str,
    required_content: str,
) -> dict[str, Any]:
    match = next(
        (
            item
            for item in storages
            if str(item.get("storage") or item.get("name") or "") == storage_name
        ),
        None,
    )
    if match is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"storage {storage_name!r} does not exist on PVE",
        )
    content = match.get("content") or []
    if isinstance(content, str):
        content = [part.strip() for part in content.split(",") if part.strip()]
    active = bool(match.get("active", True))
    if not active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"storage {storage_name!r} is not active",
        )
    if required_content not in content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"storage {storage_name!r} must allow {required_content!r} "
                f"content; current content={content}"
            ),
        )
    free_bytes = match.get("free_bytes")
    total_bytes = match.get("total_bytes")
    warn_low_space = (
        isinstance(free_bytes, int)
        and isinstance(total_bytes, int)
        and total_bytes > 0
        and free_bytes / total_bytes < 0.15
    )
    return {
        "storage": storage_name,
        "required_content": required_content,
        "content": content,
        "active": active,
        "free_bytes": free_bytes,
        "total_bytes": total_bytes,
        "warn_low_space": warn_low_space,
    }


@router.get(
    "/pve-config",
    summary="Get the active PVE connection config (DB or env).",
    description=(
        "Returns the singleton PVE config the API is currently using. "
        "If a row exists in `pve_config`, that's returned with "
        "`source=db` and `token_secret` masked as `***`. If no row "
        "exists, the env-var fallback is returned with `source=env` "
        "and `token_secret=***` (we don't have the env value here)."
    ),
)
async def get_pve_config(
    db: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    row = await pve_config_svc.get_config(db)
    if row is not None:
        return row.to_public_dict()
    return pve_config_svc.env_source_dict()


@router.post(
    "/pve-config",
    summary="Write (or replace) the PVE runtime config.",
    description=(
        "Probes PVE with the supplied credentials first; commits only "
        "if the probe succeeds. After commit, the in-process overlay "
        "is refreshed so the next PVE call picks up the new creds -- "
        "no container restart required. Use `DELETE` to revert to the "
        "env-var fallback."
    ),
)
async def post_pve_config(
    body: PveConfigPayload,
    db: Annotated[AsyncSession, Depends(get_session)],
    token: Annotated[TokenData, Depends(require_role(Role.ADMIN))],
) -> dict[str, Any]:
    """Validate, probe, persist, hydrate.

    Status codes:
      * 200 -- creds accepted, row written
      * 400 -- validation failed (Pydantic or service-level)
      * 502 -- PVE rejected the creds (probe-before-commit caught it)
    """
    # Write the new creds into the overlay so the probe uses them
    # (without committing to the DB yet). If the probe fails the
    # operator sees the actual PVE error and we abort -- no DB churn.
    from app.core.config import settings as _settings
    from app.services.proxmox import set_db_overlay

    clone_storage = (
        (body.clone_storage or "").strip() or _settings.proxmox.clone_storage or "local-lvm"
    )
    seed_snippet_storage = (
        (body.seed_snippet_storage or "").strip()
        or _settings.proxmox.seed_snippet_storage
        or "local"
    )

    set_db_overlay(
        {
            "host": body.host,
            "port": body.port,
            "user": body.user,
            "token_id": body.token_id,
            "token_secret": body.token_secret,
            "verify_ssl": body.verify_ssl,
            "node": body.node,
            "clone_storage": clone_storage,
            "seed_snippet_storage": seed_snippet_storage,
        }
    )
    from app.services.proxmox import get_version

    try:
        get_version()
        storages = list_storage()
    except (ProxmoxNotConfiguredError, ProxmoxAPIError) as exc:
        # Probe failed. Roll overlay back to None so the next call
        # goes to env vars (whichever was active before). Better than
        # leaving a partial overlay hanging around.
        set_db_overlay(None)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PVE rejected the supplied credentials: {exc}",
        ) from exc
    try:
        storage_checks = {
            "clone_storage": _storage_check(storages, clone_storage, "images"),
            "seed_snippet_storage": _storage_check(storages, seed_snippet_storage, "snippets"),
        }
    except HTTPException:
        set_db_overlay(None)
        raise
    # Probe ok. Persist.
    try:
        row = await pve_config_svc.upsert_config(
            db,
            host=body.host,
            port=body.port,
            user=body.user,
            token_id=body.token_id,
            token_secret=body.token_secret,
            verify_ssl=body.verify_ssl,
            node=body.node,
            updated_by=token.sub,
            clone_storage=clone_storage,
            seed_snippet_storage=seed_snippet_storage,
        )
    except pve_config_svc.PveConfigError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    log.info(
        "pve_config.upsert",
        host=body.host,
        user=body.user,
        token_id=body.token_id,
        updated_by=token.sub,
    )
    return {
        **row.to_public_dict(),
        "probed": True,
        "storage_checks": storage_checks,
        "message": "PVE accepted the credentials. Wizard can advance.",
    }


@router.delete(
    "/pve-config",
    summary="Drop the PVE config row; revert to env-var resolution.",
    description=(
        "Useful for operators who want to 'go back to deploy/.env' "
        "without touching the host. After delete, the API falls back "
        "to the `PROXMOX_*` env vars on the next PVE call. No-op if "
        "no row exists."
    ),
)
async def delete_pve_config(
    db: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    deleted = await pve_config_svc.delete_config(db)
    # Refresh overlay so the next PVE call goes back to env.
    from app.services.proxmox import set_db_overlay

    set_db_overlay(None)
    log.info("pve_config.delete", deleted=deleted)
    return {
        "deleted": deleted,
        "message": (
            "DB row deleted; API now resolves PVE creds from PROXMOX_* env vars."
            if deleted
            else "No DB row to delete; API is already on env-var fallback."
        ),
    }
