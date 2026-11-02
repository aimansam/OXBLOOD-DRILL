"""Drill prepare/start/pause/resume/stop endpoints."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Role, TokenData, require_role
from app.db import models as catalog_models
from app.db.models import User
from app.db.models_drill import (
    Drill,
    DrillEvent,
    DrillStatus,
)
from app.db.session import get_session, get_sessionmaker
from app.modules.drills.lifecycle import (
    needs_provision_cleanup as _drill_needs_provision_cleanup,
)
from app.modules.drills.lock import (
    acquire_environment_lock,
    assert_environment_owner,
    bind_environment_lock,
    release_environment_lock,
    release_unbound_environment_lock,
    set_environment_lock_status,
)
from app.runners.runner import RunnerError
from app.services.drill_service import (
    create_drill,
    get_drill,
    pause_drill,
    resume_drill,
    start_drill,
    stop_drill,
)
from app.services.proxmox import ProxmoxAPIError
from app.services.pve_sdn import SdnPermissionError

from .access import _get_runner
from .health import _range_health, _refresh_drill_provision_state
from .provisioning import _queue_drill_provision, _stop_drill_provision_run
from .schemas import ScenarioStartRequest

router = APIRouter()
log = logging.getLogger("app.routers.drills_v2")


# ============================================================================
# Drill Lifecycle
# ============================================================================


@router.post("/{drill_id}/prepare")
async def prepare_drill_endpoint(
    drill_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Prepare the range without starting the participant exercise or timer."""
    try:
        drill = await get_drill(db, drill_id)
        if not drill:
            raise HTTPException(status_code=404, detail="Drill not found")
        scenario_id = drill.scenario_id
        env = dict(drill.environment_config or {})
        await assert_environment_owner(
            db, drill=drill, owner_sub=token.sub, is_admin=token.role == Role.ADMIN
        )
        if scenario_id is None:
            raise HTTPException(status_code=409, detail="This drill has no scenario to prepare.")
        if drill.status == DrillStatus.SCHEDULED and env.get("provision_status") in {
            "starting",
            "waiting",
            "validating",
            "validation_failed",
            "started",
        }:
            return {
                "message": "Range already prepared or preparing",
                "status": drill.status.value,
                "provision_status": env["provision_status"],
                "provision_run_id": env.get("provision_run_id"),
            }
        if (
            drill.status in {DrillStatus.ACTIVE, DrillStatus.SCHEDULED}
            and env.get("provision_status") == "failed"
        ):
            provision_status = str(env.get("provision_status") or "")
            if provision_status == "failed":
                if _drill_needs_provision_cleanup(drill):
                    cleanup_status = await _stop_drill_provision_run(db, drill)
                    if cleanup_status == "failed":
                        raise HTTPException(
                            status_code=409,
                            detail="Cleanup is required before provisioning can be retried.",
                        )
                    drill = await get_drill(db, drill_id)
                    if not drill:
                        raise HTTPException(status_code=404, detail="Drill not found")
                    env = dict(drill.environment_config or {})
                await acquire_environment_lock(
                    db,
                    owner_sub=token.sub,
                    owner_role=token.role,
                    drill_id=drill.id,
                    commit=False,
                )
                drill = (
                    await db.execute(
                        select(Drill)
                        .where(Drill.id == drill_id)
                        .with_for_update()
                        .execution_options(populate_existing=True)
                    )
                ).scalar_one()
                env = dict(drill.environment_config or {})
                if env.get("provision_status") != "failed":
                    raise HTTPException(
                        status_code=409,
                        detail="Preparation state changed. Refresh before retrying.",
                    )
                env["provision_status"] = "starting"
                env.pop("provision_error", None)
                env.pop("cleanup_status", None)
                env.pop("provision_run_id", None)
                env["preparation_started_at"] = datetime.now(UTC).isoformat()
                env["run_owner_sub"] = token.sub
                env["run_owner_role"] = token.role
                drill.environment_config = env
                drill.status = DrillStatus.SCHEDULED
                drill.actual_start_at = None
                db.add(
                    DrillEvent(
                        drill_id=drill.id,
                        kind="lifecycle",
                        title="Provisioning retry started",
                    )
                )
                await db.commit()
                _queue_drill_provision(background_tasks, drill_id, scenario_id)
                return {
                    "message": "Provision retry started",
                    "status": drill.status.value,
                    "provision_run_id": env.get("provision_run_id"),
                    "provision_status": env.get("provision_status"),
                }
            raise ValueError(f"Cannot start drill in {drill.status} state")
        if drill.status != DrillStatus.SCHEDULED:
            raise ValueError(f"Cannot start drill in {drill.status} state")
        await acquire_environment_lock(
            db,
            owner_sub=token.sub,
            owner_role=token.role,
            drill_id=drill.id,
            commit=False,
        )
        drill = (
            await db.execute(
                select(Drill)
                .where(Drill.id == drill_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one()
        env = dict(drill.environment_config or {})
        if drill.status != DrillStatus.SCHEDULED or env.get("provision_status") in {
            "starting",
            "waiting",
            "validating",
            "validation_failed",
            "started",
        }:
            raise HTTPException(
                status_code=409, detail="Preparation state changed. Refresh before retrying."
            )
        env["provision_status"] = "starting"
        env.pop("provision_error", None)
        env["preparation_started_at"] = datetime.now(UTC).isoformat()
        env["run_owner_sub"] = token.sub
        env["run_owner_role"] = token.role
        drill.environment_config = env
        await db.commit()
        _queue_drill_provision(background_tasks, drill_id, scenario_id)
        return {
            "message": "Range preparation started; exercise timer has not started",
            "status": drill.status.value,
            "provision_run_id": (drill.environment_config or {}).get("provision_run_id"),
            "provision_status": (drill.environment_config or {}).get("provision_status"),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RunnerError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except SdnPermissionError as e:
        raise HTTPException(
            status_code=403,
            detail={
                "message": str(e),
                "required_role": getattr(e, "required_role", None),
                "pveum_hint": getattr(e, "pveum_hint", None),
                "pve_path": getattr(e, "pve_path", None),
            },
        ) from e
    except ProxmoxAPIError as e:
        raise HTTPException(status_code=502, detail=f"PVE unreachable: {e}") from e


@router.post("/{drill_id}/start")
async def start_drill_endpoint(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Start the exercise only after preparation and fresh readiness checks."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    await assert_environment_owner(
        db, drill=drill, owner_sub=token.sub, is_admin=token.role == Role.ADMIN
    )
    if drill.status != DrillStatus.SCHEDULED:
        raise HTTPException(status_code=409, detail="Only a scheduled, prepared drill can start.")
    if drill.scenario_id is not None:
        if (drill.environment_config or {}).get("provision_status") not in {
            "started",
            "validation_failed",
        }:
            raise HTTPException(
                status_code=409,
                detail="Prepare the range and finish validation before starting the exercise.",
            )
        snapshot = await _refresh_drill_provision_state(db, drill)
        health = await _range_health(db, drill)
        if snapshot.get("errors") or health["mood"] != "ready":
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "range_not_ready",
                    "message": "Range checks failed. Resolve readiness issues before starting.",
                    "checks": health["checks"],
                    "errors": snapshot.get("errors", []),
                },
            )
    await acquire_environment_lock(
        db, owner_sub=token.sub, owner_role=token.role, drill_id=drill_id, commit=False
    )
    drill = (
        await db.execute(
            select(Drill)
            .where(Drill.id == drill_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    if drill.status != DrillStatus.SCHEDULED:
        raise HTTPException(
            status_code=409, detail="The drill state changed. Refresh before starting."
        )
    env = dict(drill.environment_config or {})
    if drill.scenario_id is not None:
        if env.get("provision_status") not in {"started", "validation_failed"} or env.get(
            "cleanup_status"
        ):
            raise HTTPException(
                status_code=409,
                detail="The range changed during validation. Refresh before starting.",
            )
        env["provision_status"] = "started"
        env["readiness_checked_at"] = health["checked_at"]
        env.pop("provision_error", None)
    env["run_owner_sub"] = token.sub
    env["run_owner_role"] = token.role
    drill.environment_config = env
    drill = await start_drill(db, drill_id)
    await set_environment_lock_status(db, drill_id=drill_id, status="active")
    return {
        "message": "Exercise started",
        "status": drill.status.value,  # type: ignore[union-attr]
        "provision_status": env.get("provision_status"),
        "provision_run_id": env.get("provision_run_id"),
    }


@router.get("/scenario-preflight/{scenario_id}")
async def scenario_preflight(
    scenario_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    scenario = await db.get(catalog_models.Scenario, scenario_id)
    if scenario is None or scenario.archived_at is not None:
        raise HTTPException(status_code=404, detail="Scenario not found or archived")
    adapter = _get_runner()._adapter
    try:
        nodes = await adapter.list_nodes()
        node = getattr(adapter, "_node", None) or (nodes[0] if nodes else None)
        if not node or node not in nodes:
            raise RunnerError("The configured Proxmox node is unavailable.")
        checks = await adapter.preflight(scenario.spec.get("spec") or scenario.spec, node)
    except (ProxmoxAPIError, RunnerError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "ready": bool(checks) and all(check["ready"] for check in checks),
        "node": node,
        "checks": checks,
        "checked_at": datetime.now(UTC).isoformat(),
    }


@router.post("/start-from-scenario")
async def start_from_scenario(
    data: ScenarioStartRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Create a lobby and prepare its range; the operator starts play separately."""
    scenario = (
        await db.execute(
            select(catalog_models.Scenario).where(
                catalog_models.Scenario.id == data.scenario_id,
                catalog_models.Scenario.archived_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if scenario is None:
        raise HTTPException(status_code=404, detail="Scenario not found or archived")

    await acquire_environment_lock(
        db,
        owner_sub=token.sub,
        owner_role=token.role,
    )
    created = None
    try:
        actor = (await db.execute(select(User).where(User.sub == token.sub))).scalar_one_or_none()
        created = await create_drill(
            db,
            title=scenario.title,
            description=f"Operator run of {scenario.title}",
            scenario_id=scenario.id,
            drill_type="individual",
            duration_limit_minutes=(data.duration_limit_minutes or scenario.duration_min),
            max_participants=data.max_participants or 10,
            created_by=actor.id if actor else None,
        )
        await bind_environment_lock(
            db,
            drill_id=created.id,
            owner_sub=token.sub,
            owner_role=token.role,
        )
        env = dict(created.environment_config or {})
        env["provision_status"] = "starting"
        env["preparation_started_at"] = datetime.now(UTC).isoformat()
        env["run_owner_sub"] = token.sub
        env["run_owner_role"] = token.role
        created.environment_config = env
        await db.commit()
        _queue_drill_provision(background_tasks, created.id, scenario.id)
        async with get_sessionmaker()() as lock_db:
            await set_environment_lock_status(
                lock_db,
                drill_id=created.id,
                status="provisioning",
            )
        return {
            "message": "Drill lobby created and range preparation started",
            "drill_id": created.id,
            "status": created.status.value,
            "owner_sub": token.sub,
        }
    except HTTPException:
        if created is not None:
            await release_environment_lock(db, drill_id=created.id)
        else:
            await release_unbound_environment_lock(db, owner_sub=token.sub)
        raise
    except Exception:
        if created is not None:
            await release_environment_lock(db, drill_id=created.id)
        else:
            await release_unbound_environment_lock(db, owner_sub=token.sub)
        raise


@router.post("/{drill_id}/pause")
async def pause_drill_endpoint(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Pause a drill."""
    try:
        current = await get_drill(db, drill_id)
        if not current:
            raise HTTPException(status_code=404, detail="Drill not found")
        await assert_environment_owner(
            db,
            drill=current,
            owner_sub=token.sub,
            is_admin=token.role == Role.ADMIN.value,
        )
        drill = await pause_drill(db, drill_id)
        if not drill:
            raise HTTPException(status_code=404, detail="Drill not found")
        return {"message": "Drill paused", "status": drill.status.value}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/{drill_id}/resume")
async def resume_drill_endpoint(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Resume a paused drill."""
    try:
        current = await get_drill(db, drill_id)
        if not current:
            raise HTTPException(status_code=404, detail="Drill not found")
        await assert_environment_owner(
            db,
            drill=current,
            owner_sub=token.sub,
            is_admin=token.role == Role.ADMIN.value,
        )
        drill = await resume_drill(db, drill_id)
        if not drill:
            raise HTTPException(status_code=404, detail="Drill not found")
        return {"message": "Drill resumed", "status": drill.status.value}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/{drill_id}/stop")
async def stop_drill_endpoint(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Stop a drill."""
    try:
        current = await get_drill(db, drill_id)
        if not current:
            raise HTTPException(status_code=404, detail="Drill not found")
        await assert_environment_owner(
            db,
            drill=current,
            owner_sub=token.sub,
            is_admin=token.role == Role.ADMIN.value,
        )
        if current.status == DrillStatus.SCHEDULED:
            current.status = DrillStatus.CANCELLED
            current.actual_end_at = datetime.now(UTC)
            db.add(
                DrillEvent(drill_id=drill_id, kind="lifecycle", title="Range preparation cancelled")
            )
            await db.commit()
            await db.refresh(current)
            drill = current
        else:
            drill = await stop_drill(db, drill_id)  # type: ignore[assignment]
        if not drill:
            raise HTTPException(status_code=404, detail="Drill not found")
        cleanup_status = await _stop_drill_provision_run(db, drill)
        return {
            "message": "Drill stopped",
            "status": drill.status.value,
            "cleanup_status": cleanup_status,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
