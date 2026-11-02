"""Drill CRUD, status, access and console endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Role, TokenData, current_token, require_role
from app.db import models as catalog_models
from app.db.models import User
from app.db.models_drill import (
    DrillParticipant,
    DrillStatus,
)
from app.db.session import get_session
from app.modules.drills.lifecycle import (
    drill_to_dict,
)
from app.modules.drills.lifecycle import (
    lifecycle_snapshot as _drill_lifecycle,
)
from app.modules.drills.lifecycle import (
    needs_provision_cleanup as _drill_needs_provision_cleanup,
)
from app.modules.drills.lifecycle import (
    provision_phase as _provision_phase,
)
from app.modules.drills.lifecycle import (
    provision_run_id as _drill_provision_run_id,
)
from app.modules.drills.lock import (
    assert_environment_owner,
    environment_lock_status,
)
from app.services.drill_service import (
    cancel_drill,
    create_drill,
    get_drill,
    list_drills,
    timeout_drill,
    timeout_overdue_drills,
    update_drill,
)
from app.services.proxmox import ProxmoxAPIError

from .access import (
    _asset_credentials,
    _asset_side,
    _can_view_asset,
    _can_view_credentials,
    _get_runner,
    _participant_can_access,
    _participant_is_enrolled,
    _require_participant_workspace_access,
)
from .health import _range_health, _refresh_drill_provision_state
from .provisioning import _stop_drill_provision_run
from .schemas import (
    ConsoleRequest,
    DrillCreate,
    DrillListOut,
    DrillOut,
    DrillStatusOut,
    DrillUpdate,
    EnvironmentLockOut,
    RangeHealthOut,
)

router = APIRouter()
log = logging.getLogger("app.routers.drills_v2")


# ============================================================================
# Drill CRUD
# ============================================================================


@router.get("", response_model=DrillListOut)
async def get_drills(
    status: DrillStatus | None = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    """List drills with optional status filter."""
    if status in (None, DrillStatus.ACTIVE):
        timed_out = await timeout_overdue_drills(db)
        for drill in timed_out:
            await _stop_drill_provision_run(db, drill)
    drills = await list_drills(db, status=status, skip=skip, limit=limit)
    if token and str(token.role or "").lower() in {"red", "blue"}:
        user = (await db.execute(select(User).where(User.sub == token.sub))).scalar_one_or_none()
        if user is None:
            drills = []
        else:
            enrolled = (
                (
                    await db.execute(
                        select(DrillParticipant.drill_id).where(
                            DrillParticipant.user_id == user.id,
                            DrillParticipant.status.notin_(["removed", "left"]),
                        )
                    )
                )
                .scalars()
                .all()
            )
            enrolled_ids = {int(drill_id) for drill_id in enrolled}
            drills = [
                drill
                for drill in drills
                if drill.id in enrolled_ids
                and drill.status
                in {
                    DrillStatus.SCHEDULED,
                    DrillStatus.ACTIVE,
                    DrillStatus.PAUSED,
                }
            ]
    return {"drills": [drill_to_dict(drill) for drill in drills]}


@router.get(
    "/environment-lock", response_model=EnvironmentLockOut, response_model_exclude_unset=True
)
async def get_environment_lock(
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Return the owner of the single shared drill environment."""
    return await environment_lock_status(db)


@router.post("")
async def post_drill(
    data: DrillCreate,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN)),
):
    """Create a scheduled drill for Admin-managed scheduling workflows."""
    try:
        actor = (await db.execute(select(User).where(User.sub == token.sub))).scalar_one_or_none()
        drill = await create_drill(
            db,
            **data.model_dump(),
            created_by=actor.id if actor else None,
        )
        return {"message": "Drill created", "drill_id": drill.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/{drill_id}/announcements/{announcement_id}")
async def remove_announcement(
    drill_id: int,
    announcement_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Delete a drill announcement."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    from app.services.drill_service import delete_announcement as svc_delete_announcement

    deleted = await svc_delete_announcement(db, announcement_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Announcement not found")
    return {"message": "Announcement deleted"}


@router.get("/{drill_id}", response_model=DrillOut)
async def get_drill_endpoint(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    """Get drill details."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    if drill.status == DrillStatus.ACTIVE:
        timed = await timeout_drill(db, drill.id)
        if timed and timed.status != DrillStatus.ACTIVE:
            await _stop_drill_provision_run(db, timed)
            drill = timed
    elif (
        drill.status == DrillStatus.COMPLETED
        and (drill.environment_config or {}).get("timeout_status") == "reached"
        and _drill_needs_provision_cleanup(drill)
    ):
        await _stop_drill_provision_run(db, drill)
    await _require_participant_workspace_access(db, drill, token)
    await db.refresh(drill)
    return drill_to_dict(drill)


@router.get("/{drill_id}/status", response_model=DrillStatusOut, response_model_exclude_unset=True)
async def get_drill_status(
    drill_id: int,
    refresh: bool = Query(True),
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    """Return drill lifecycle status and optionally refresh VM states from PVE."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    if token and str(token.role or "").lower() in {"red", "blue"}:
        if not await _participant_is_enrolled(db, drill.id, token):
            raise HTTPException(status_code=403, detail="You are not enrolled in this drill.")
    if refresh:
        provision = await _refresh_drill_provision_state(db, drill)
    else:
        provision = {
            "run_id": _drill_provision_run_id(drill),
            "provision_phase": _provision_phase(drill.environment_config or {}),
            "lifecycle": _drill_lifecycle(drill),
            "assets": [],
            "errors": [],
        }
    return {
        "drill_id": drill.id,
        "status": drill.status.value if hasattr(drill.status, "value") else str(drill.status),
        "lifecycle": _drill_lifecycle(drill),
        "environment_config": drill.environment_config or {},
        "provision": provision,
    }


@router.get(
    "/{drill_id}/range-health", response_model=RangeHealthOut, response_model_exclude_unset=True
)
async def get_drill_range_health(
    drill_id: int,
    refresh: bool = Query(True),
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    """Human-facing readiness checks for the drill's cyber range."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    if refresh:
        try:
            await _refresh_drill_provision_state(db, drill)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "oxblood.range_health_refresh_failed drill_id=%s err=%s",
                drill_id,
                exc,
            )
            drill = await get_drill(db, drill_id)
            if not drill:
                raise HTTPException(status_code=404, detail="Drill not found")
    return await _range_health(db, drill, token)


@router.get("/{drill_id}/access")
async def get_drill_access(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    """Role-aware VM access inventory for the active drill UI."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    env = drill.environment_config or {}
    run_id = _drill_provision_run_id(drill)
    if run_id is None:
        return {
            "run_id": None,
            "role": token.role if token else "anonymous",
            "assets": [],
            "message": "No provision run has been recorded for this drill yet.",
        }

    run = (
        await db.execute(select(catalog_models.Run).where(catalog_models.Run.id == run_id))
    ).scalar_one_or_none()
    if run is None:
        return {
            "run_id": run_id,
            "role": token.role if token else "anonymous",
            "assets": [],
            "message": f"Provision run {run_id} was not found.",
        }

    scenario = None
    if drill.scenario_id:
        scenario = (
            await db.execute(
                select(catalog_models.Scenario).where(
                    catalog_models.Scenario.id == drill.scenario_id
                )
            )
        ).scalar_one_or_none()
    scenario_spec = ((scenario.spec if scenario else None) or {}).get("spec") or (
        (scenario.spec if scenario else None) or {}
    )
    scenario_access = scenario_spec.get("access") or {}
    assets_spec = scenario_spec.get("assets") or []
    specs_by_role = {
        str(spec.get("role")): spec
        for spec in assets_spec
        if isinstance(spec, dict) and spec.get("role")
    }

    assets = (
        (
            await db.execute(
                select(catalog_models.Asset)
                .where(catalog_models.Asset.run_id == run_id)
                .order_by(catalog_models.Asset.role, catalog_models.Asset.id)
            )
        )
        .scalars()
        .all()
    )

    rows = []
    for asset in assets:
        role_text = str(asset.role or "")
        role_parts = role_text.rsplit("_", 1)
        base_role = role_parts[0] if len(role_parts) == 2 and role_parts[1].isdigit() else role_text
        asset_spec = specs_by_role.get(asset.role) or specs_by_role.get(base_role) or {}
        side = _asset_side(asset.role, scenario_access)
        if not _can_view_asset(side, token):
            continue
        if not await _participant_can_access(db, drill_id, token, side):
            continue
        credentials = _asset_credentials(asset.role, asset_spec)
        status_value = asset.status.value if hasattr(asset.status, "value") else str(asset.status)
        rows.append(
            {
                "id": asset.id,
                "run_id": asset.run_id,
                "role": asset.role,
                "side": side,
                "kind": asset.kind,
                "template": asset.template,
                "networks": asset_spec.get("networks") or [],
                "status": status_value,
                "pve_vmid": asset.pve_vmid,
                "pve_node": asset.pve_node,
                "ip": asset.pve_ip,
                "error": asset.error,
                "seeded": env.get("provision_status") == "started",
                "seed_status": "Seeded"
                if env.get("provision_status") == "started"
                else "Pending seed",
                "credentials": credentials if _can_view_credentials(side, token) else None,
                "console_available": bool(
                    asset.pve_vmid and asset.pve_node and status_value == "running"
                ),
                "console_message": (
                    "Open the assigned workstation console."
                    if status_value == "running"
                    else "Console opens when this workstation is running."
                ),
            }
        )

    return {
        "run_id": run_id,
        "provision_status": env.get("provision_status"),
        "cleanup_status": env.get("cleanup_status"),
        "role": token.role if token else "anonymous",
        "assets": rows,
    }


@router.get("/{drill_id}/threat-map")
async def get_drill_threat_map(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    """Return the live, role-filtered graph used by the active drill map."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    await _require_participant_workspace_access(db, drill, token)

    access = await get_drill_access(drill_id, db, token)
    scenario = None
    if drill.scenario_id:
        scenario = (
            await db.execute(
                select(catalog_models.Scenario).where(
                    catalog_models.Scenario.id == drill.scenario_id
                )
            )
        ).scalar_one_or_none()
    scenario_payload = None
    runtime = ((scenario.spec if scenario else None) or {}).get("spec") or (
        (scenario.spec if scenario else None) or {}
    )
    networks = runtime.get("networks") or []
    scenario_assets = runtime.get("assets") or []
    assets = access.get("assets") or []
    if scenario:
        role = str(token.role or "").lower() if token else ""
        if role in {"red", "blue"}:
            visible_roles = {str(asset.get("role") or "") for asset in assets}
            scenario_assets = [
                asset for asset in scenario_assets if str(asset.get("role") or "") in visible_roles
            ]
            visible_networks = {
                str(network) for asset in assets for network in (asset.get("networks") or [])
            }
            networks = [
                network
                for network in networks
                if str(network.get("name") or "") in visible_networks
            ]
        scenario_assets = [
            {
                key: asset.get(key)
                for key in ("role", "kind", "template", "networks")
                if key in asset
            }
            for asset in scenario_assets
        ]
        scenario_payload = {
            "id": scenario.id,
            "name": scenario.name,
            "title": scenario.title,
            "difficulty": scenario.difficulty,
            "spec": {"spec": {"assets": scenario_assets, "networks": networks}},
        }
    return {
        "drill_id": drill.id,
        "status": drill.status.value if hasattr(drill.status, "value") else str(drill.status),
        "scenario": scenario_payload,
        "networks": networks,
        "assets": assets,
        "role": access.get("role"),
        "provision_status": access.get("provision_status"),
    }


@router.post("/{drill_id}/access/{asset_id}/console")
async def create_drill_console(
    drill_id: int,
    asset_id: int,
    _data: ConsoleRequest | None = None,
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    """Create a short-lived Proxmox console ticket for an allowed VM."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    run_id = _drill_provision_run_id(drill)
    if run_id is None:
        raise HTTPException(status_code=409, detail="Drill has no provision run")

    asset = (
        await db.execute(
            select(catalog_models.Asset).where(
                catalog_models.Asset.id == asset_id,
                catalog_models.Asset.run_id == run_id,
            )
        )
    ).scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found for this drill")
    if token is None:
        raise HTTPException(status_code=401, detail="Console access requires login")

    scenario = None
    if drill.scenario_id:
        scenario = (
            await db.execute(
                select(catalog_models.Scenario).where(
                    catalog_models.Scenario.id == drill.scenario_id
                )
            )
        ).scalar_one_or_none()
    scenario_spec = ((scenario.spec if scenario else None) or {}).get("spec") or (
        (scenario.spec if scenario else None) or {}
    )
    side = _asset_side(asset.role, scenario_spec.get("access") or {})
    if not _can_view_asset(side, token):
        raise HTTPException(status_code=403, detail="Asset is not visible to your role")
    if not await _participant_can_access(db, drill_id, token, side):
        raise HTTPException(status_code=403, detail="You are not assigned to this drill")
    drill_status = drill.status.value if hasattr(drill.status, "value") else str(drill.status)
    operator_preparing = (
        token.role in {Role.ADMIN, Role.LEAD}
        and drill_status == "scheduled"
        and (drill.environment_config or {}).get("provision_status")
        in {"starting", "waiting", "validating", "validation_failed", "started"}
    )
    if operator_preparing:
        await assert_environment_owner(
            db, drill=drill, owner_sub=token.sub, is_admin=token.role == Role.ADMIN
        )
    if drill_status not in {"active", "paused"} and not operator_preparing:
        raise HTTPException(status_code=409, detail="Console access is closed for this drill")
    status_value = asset.status.value if hasattr(asset.status, "value") else str(asset.status)
    if status_value != "running":
        raise HTTPException(
            status_code=409,
            detail=f"Asset is {status_value}; console is available only when running",
        )
    if not asset.pve_vmid or not asset.pve_node:
        raise HTTPException(status_code=409, detail="Asset has no PVE VM binding")

    try:
        ticket = await _get_runner()._adapter.create_console_ticket(  # noqa: SLF001
            int(asset.pve_vmid),
            asset.pve_node,
        )
    except ProxmoxAPIError as exc:
        raise HTTPException(status_code=502, detail=f"PVE console unavailable: {exc}") from exc

    return {
        "asset_id": asset.id,
        "role": asset.role,
        "side": side,
        "vmid": ticket.vmid,
        "node": ticket.node,
        "ticket": ticket.ticket,
        "port": ticket.port,
        "cert": ticket.cert,
        "user": ticket.user,
        "launch_url": ticket.launch_url,
        "viewer": "novnc",
        "message": "Console ticket created. Opening the Proxmox noVNC console.",
    }


@router.put("/{drill_id}")
async def put_drill(
    drill_id: int,
    data: DrillUpdate,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN)),
):
    """Update a drill."""
    try:
        drill = await update_drill(db, drill_id, **data.model_dump(exclude_none=True))
        if not drill:
            raise HTTPException(status_code=404, detail="Drill not found")
        return {"message": "Drill updated"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/{drill_id}")
async def delete_drill(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN)),
):
    """Cancel a drill (soft delete)."""
    current = await get_drill(db, drill_id)
    if current and current.status in {DrillStatus.ACTIVE, DrillStatus.PAUSED}:
        raise HTTPException(
            status_code=409,
            detail="Stop the active drill and complete VM cleanup before deleting it.",
        )
    if current and _drill_needs_provision_cleanup(current):
        raise HTTPException(
            status_code=409,
            detail="VM cleanup is still required before deleting this drill.",
        )
    drill = await cancel_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    return {"message": "Drill cancelled"}
