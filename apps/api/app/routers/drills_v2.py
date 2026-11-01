"""Drill router for OxBlood v2.

Provides endpoints for drill management, lifecycle, participants, teams, and announcements.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Role, TokenData, current_token, require_role
from app.db import models as catalog_models
from app.db.models import User
from app.db.models import AssetStatus, AuditAction, RunStatus
from app.db.models_oxblood import (
    Drill,
    DrillEvent,
    DrillFlag,
    DrillObjective,
    DrillParticipant,
    DrillStatus,
)
from app.db.session import get_session, get_sessionmaker
from app.modules.drills.lifecycle import (
    drill_to_dict,
    lifecycle_snapshot as _drill_lifecycle,
    needs_provision_cleanup as _drill_needs_provision_cleanup,
    provision_phase as _provision_phase,
    provision_run_id as _drill_provision_run_id,
)
from app.modules.drills.lock import (
    acquire_environment_lock,
    assert_environment_owner,
    bind_environment_lock,
    environment_lock_status,
    release_environment_lock,
    release_unbound_environment_lock,
    set_environment_lock_status,
)
from app.runners.runner import RunnerError, RunRequest, build_runner
from app.services.drill_service import (
    add_participant,
    cancel_drill,
    create_announcement,
    create_drill,
    create_drill_flag,
    create_drill_objective,
    delete_drill_flag,
    get_drill,
    link_scenario,
    list_drill_announcements,
    list_drill_events,
    list_drill_flags,
    list_drill_objectives,
    list_drill_participants,
    list_drill_scenarios,
    list_drills,
    pause_drill,
    record_drill_event,
    remove_participant,
    resume_drill,
    set_objective_status,
    start_drill,
    stop_drill,
    timeout_drill,
    timeout_overdue_drills,
    update_drill,
)
from app.services.proxmox import ProxmoxAPIError
from app.services.pve_sdn import SdnPermissionError
from app.services.submission_service import record_milestone_score

router = APIRouter(prefix="/api/v2/drills", tags=["Drills v2"])
log = logging.getLogger(__name__)


@dataclass
class ProvisionJob:
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None


_PROVISION_JOBS: dict[int, ProvisionJob] = {}


_RED_ROLE_HINTS = ("red", "attacker", "kali", "operator")
_BLUE_ROLE_HINTS = ("blue", "analyst", "soc", "siem", "log", "defender")


def _asset_side(role: str, scenario_access: dict | None = None) -> str:
    role_l = str(role or "").lower()
    access = scenario_access or {}
    for side in ("red", "blue"):
        assets = access.get(side) or {}
        allowed = assets.get("assets") if isinstance(assets, dict) else assets
        if isinstance(allowed, list) and role in allowed:
            return side
    if any(hint in role_l for hint in _RED_ROLE_HINTS):
        return "red"
    if any(hint in role_l for hint in _BLUE_ROLE_HINTS):
        return "blue"
    return "shared"


def _asset_credentials(role: str, asset_spec: dict | None = None) -> dict | None:
    spec_access = (asset_spec or {}).get("access") or {}
    role_l = str(role or "").lower()
    if role_l.startswith("red") or "attacker" in role_l or "kali" in role_l:
        return {
            "username": str(spec_access.get("user") or "red"),
            "password": str(spec_access.get("password") or "red-team"),
        }
    if role_l.startswith("blue") or "analyst" in role_l or "soc" in role_l:
        return {
            "username": str(spec_access.get("user") or "blue"),
            "password": str(spec_access.get("password") or "blue-team"),
        }
    if spec_access.get("user") or spec_access.get("password"):
        return {
            "username": str(spec_access.get("user") or "divide"),
            "password": str(spec_access.get("password") or "divide"),
        }
    return None


def _can_view_asset(side: str, token: TokenData | None) -> bool:
    if token is None:
        return True
    role = str(token.role or "").lower()
    if role in {"admin", "lead", "observer"}:
        return True
    if role == "red":
        return side == "red"
    if role == "blue":
        return side == "blue"
    return False


def _can_view_credentials(side: str, token: TokenData | None) -> bool:
    if token is None:
        return False
    role = str(token.role or "").lower()
    if role in {"admin", "lead"}:
        return True
    return role == side and side in {"red", "blue"}


async def _participant_can_access(
    db: AsyncSession, drill_id: int, token: TokenData | None, side: str
) -> bool:
    """Apply roster access after the broad role/side check.

    Operators and observers can inspect every console. For red/blue users,
    a populated roster becomes the source of truth: an account must be on
    this drill, and an explicitly assigned side must match the asset side.
    The empty-roster fallback keeps the LAN bootstrap usable while an
    operator is still assembling a drill.
    """
    if token is None:
        return False
    role = str(token.role or "").lower()
    if role in {"admin", "lead", "observer"}:
        return True
    if role not in {"red", "blue"}:
        return False
    roster = (
        await db.execute(select(DrillParticipant).where(DrillParticipant.drill_id == drill_id))
    ).scalars().all()
    if not roster:
        return False
    user = (
        await db.execute(select(User).where(User.sub == token.sub))
    ).scalar_one_or_none()
    if user is None:
        return False
    participant = next((item for item in roster if item.user_id == user.id), None)
    if participant is None or str(participant.status or "").lower() in {"removed", "left"}:
        return False
    assigned_role = str(participant.role or "").lower()
    return assigned_role not in {"red", "blue"} or assigned_role == side


async def _participant_is_enrolled(
    db: AsyncSession, drill_id: int, token: TokenData | None
) -> bool:
    """Return whether a player account is enrolled in this drill."""
    if token is None or str(token.role or "").lower() not in {"red", "blue"}:
        return False
    user = (
        await db.execute(select(User).where(User.sub == token.sub))
    ).scalar_one_or_none()
    if user is None:
        return False
    participant = (
        await db.execute(
            select(DrillParticipant).where(
                DrillParticipant.drill_id == drill_id,
                DrillParticipant.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    return participant is not None and str(participant.status or "").lower() not in {
        "removed",
        "left",
    }


async def _require_participant_workspace_access(
    db: AsyncSession, drill, token: TokenData | None
) -> None:
    """Keep the live workspace closed until a player is enrolled and started."""
    role = str(token.role or "").lower() if token else ""
    if role not in {"red", "blue"}:
        return
    if not await _participant_is_enrolled(db, drill.id, token):
        raise HTTPException(
            status_code=403,
            detail="You are not enrolled in this drill.",
        )
    status = drill.status.value if hasattr(drill.status, "value") else str(drill.status)
    if status not in {DrillStatus.ACTIVE.value, DrillStatus.PAUSED.value}:
        raise HTTPException(
            status_code=409,
            detail="The drill workspace opens when the drill starts.",
        )


def _get_runner():
    return build_runner()


def _queue_drill_provision(
    background_tasks: BackgroundTasks,
    drill_id: int,
    scenario_id: int,
) -> None:
    job = ProvisionJob()
    _PROVISION_JOBS[drill_id] = job
    background_tasks.add_task(
        _provision_drill_background,
        drill_id,
        scenario_id,
        job,
    )


def _provision_error_message(exc: Exception) -> str:
    if isinstance(exc, SdnPermissionError):
        return str(exc)
    if isinstance(exc, ProxmoxAPIError):
        return f"PVE unreachable: {exc}"
    return str(exc)


async def _set_drill_provision_status(
    drill_id: int,
    status: str,
    *,
    provision_run_id: int | None = None,
    error: str | None = None,
) -> None:
    sm = get_sessionmaker()
    async with sm() as db:
        drill = (
            await db.execute(
                select(Drill).where(Drill.id == drill_id).with_for_update()
            )
        ).scalar_one_or_none()
        if not drill:
            return
        env = dict(drill.environment_config or {})
        terminal_or_cleaning = (
            drill.status in {DrillStatus.COMPLETED, DrillStatus.CANCELLED}
            or env.get("cleanup_status") in {"stopping", "stopped"}
        )
        changed = False
        if provision_run_id is not None and env.get("provision_run_id") != provision_run_id:
            env["provision_run_id"] = provision_run_id
            changed = True
        if terminal_or_cleaning:
            if changed:
                drill.environment_config = env
                await db.commit()
            return
        env["provision_status"] = status
        if error:
            env["provision_error"] = error
        else:
            env.pop("provision_error", None)
        drill.environment_config = env
        changed = True
        db.add(
            DrillEvent(
                drill_id=drill_id,
                kind="lifecycle",
                title={
                    "failed": "Provisioning failed",
                    "waiting": "Provisioning queued",
                    "starting": "Provisioning started",
                    "started": "Provisioning completed",
                    "validating": "Range validation started",
                    "validation_failed": "Range validation needs attention",
                }.get(status, f"Provisioning {status}"),
                detail=error,
            )
        )
        await db.commit()
        lock_status = {
            "starting": "provisioning",
            "waiting": "provisioning",
            "failed": "cleanup_required",
            "validating": "validating",
            "validation_failed": "validating",
            "started": "ready" if drill.status == DrillStatus.SCHEDULED else "active",
        }.get(status)
        if lock_status:
            async with sm() as lock_db:
                await set_environment_lock_status(
                    lock_db,
                    drill_id=drill_id,
                    status=lock_status,
                )


async def _provision_drill_background(
    drill_id: int,
    scenario_id: int,
    job: ProvisionJob | None = None,
) -> None:
    sm = get_sessionmaker()
    job = job or ProvisionJob()
    _PROVISION_JOBS[drill_id] = job
    try:
        if job.cancel_event.is_set():
            return
        runner = _get_runner()
        lifecycle_busy = getattr(runner, "pve_lifecycle_busy", lambda: False)
        if lifecycle_busy():
            await _set_drill_provision_status(
                drill_id,
                "waiting",
                error="Waiting for another VM provision or cleanup task to finish.",
            )
        await _set_drill_provision_status(drill_id, "starting")
        async with sm() as db:
            drill = await get_drill(db, drill_id)
            if not drill:
                return
            run_task = asyncio.create_task(
                runner.start_run(
                    RunRequest(
                        scenario_id=scenario_id,
                        started_by="oxblood",
                        # The v2 drill lifecycle owns the exercise timer.
                        timeout_min=-1,
                        cancel_event=job.cancel_event,
                    ),
                    db,
                )
            )
            job.task = run_task
            published_run_id = None
            while not run_task.done():
                async with sm() as probe:
                    live_run = (
                        await probe.execute(
                            select(catalog_models.Run)
                            .where(catalog_models.Run.scenario_id == scenario_id)
                            .where(catalog_models.Run.status.in_([RunStatus.PENDING, RunStatus.RUNNING]))
                            .order_by(catalog_models.Run.id.desc())
                            .limit(1)
                        )
                    ).scalar_one_or_none()
                    if live_run is not None and live_run.id != published_run_id:
                        published_run_id = live_run.id
                        await _set_drill_provision_status(
                            drill_id, "starting", provision_run_id=live_run.id
                        )
                await asyncio.sleep(0.5)
            result = await run_task
        if result.status == RunStatus.CANCELLED:
            await _set_drill_provision_status(drill_id, "cancelled", provision_run_id=result.run_id)
        else:
            await _set_drill_provision_status(drill_id, "validating", provision_run_id=result.run_id)
            async with sm() as db:
                drill = await get_drill(db, drill_id)
                if drill is not None:
                    health = await _range_health(db, drill)
                    prepared = _provision_checks_ready(health)
                    await _set_drill_provision_status(
                        drill_id, "started" if prepared else "validation_failed",
                        error=None if prepared else "Range validation failed. Review readiness checks before starting.",
                    )
    except (RunnerError, SdnPermissionError, ProxmoxAPIError, ValueError) as exc:
        await _set_drill_provision_status(
            drill_id,
            "failed",
            error=_provision_error_message(exc),
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("oxblood.provision_background_failed drill_id=%s", drill_id)
        await _set_drill_provision_status(
            drill_id,
            "failed",
            error=f"{type(exc).__name__}: {exc}",
        )
    finally:
        if _PROVISION_JOBS.get(drill_id) is job:
            _PROVISION_JOBS.pop(drill_id, None)


async def _stop_drill_provision_run(db: AsyncSession, drill) -> str | None:
    drill = (
        await db.execute(
            select(Drill)
            .where(Drill.id == drill.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if drill is None:
        return None
    job = _PROVISION_JOBS.get(drill.id)
    run_id = _drill_provision_run_id(drill)
    env = dict(drill.environment_config or {})
    env["cleanup_status"] = "stopping"
    env.pop("cleanup_error", None)
    drill.environment_config = env
    db.add(
        DrillEvent(
            drill_id=drill.id,
            kind="lifecycle",
            title="Provisioned VMs cleanup started",
            detail=(
                f"Stopping provision run {run_id}"
                if run_id is not None
                else "Stopping in-flight provisioning"
            ),
        )
    )
    await db.commit()

    if job is not None:
        job.cancel_event.set()
        if job.task is not None:
            try:
                await job.task
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "oxblood.provision_cancel_wait_failed drill_id=%s err=%s",
                    drill.id,
                    exc,
                )

    await db.refresh(drill)
    run_id = _drill_provision_run_id(drill)
    if drill.scenario_id is not None and drill.actual_start_at is not None:
        newest_run = (
            await db.execute(
                select(catalog_models.Run)
                .where(catalog_models.Run.scenario_id == drill.scenario_id)
                .where(catalog_models.Run.started_at >= drill.actual_start_at)
                .order_by(catalog_models.Run.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        recorded_run = await db.get(catalog_models.Run, run_id) if run_id else None
        if newest_run is not None and (
            recorded_run is None or newest_run.id > recorded_run.id
        ):
            run_id = newest_run.id
            env = dict(drill.environment_config or {})
            env["provision_run_id"] = run_id
            drill.environment_config = env
            await db.commit()

    if run_id is None:
        env = dict(drill.environment_config or {})
        env["cleanup_status"] = "stopped"
        drill.environment_config = env
        await db.commit()
        await release_environment_lock(db, drill_id=drill.id)
        return "stopped"

    try:
        await _get_runner().stop_run(
            run_id,
            reason=f"OxBlood drill {drill.id} stopped",
            session=db,
            actor="oxblood",
        )
    except RunnerError as exc:
        env = dict(drill.environment_config or {})
        env["cleanup_status"] = "failed"
        env["cleanup_error"] = str(exc)
        drill.environment_config = env
        db.add(
            DrillEvent(
                drill_id=drill.id,
                kind="lifecycle",
                title="Provisioned VMs cleanup failed",
                detail=str(exc),
            )
        )
        await db.commit()
        return "failed"

    orphaned_assets = (
        await db.execute(
            select(catalog_models.Asset)
            .where(catalog_models.Asset.run_id == run_id)
            .where(catalog_models.Asset.status == AssetStatus.ORPHANED)
        )
    ).scalars().all()
    if orphaned_assets:
        details = "; ".join(
            f"{asset.role} VM {asset.pve_vmid}: {asset.error or 'destroy failed'}"
            for asset in orphaned_assets
        )
        env = dict(drill.environment_config or {})
        env["cleanup_status"] = "failed"
        env["cleanup_error"] = details
        drill.environment_config = env
        db.add(
            DrillEvent(
                drill_id=drill.id,
                kind="lifecycle",
                title="Provisioned VMs cleanup failed",
                detail=details,
            )
        )
        await db.commit()
        return "failed"

    run = await db.get(catalog_models.Run, run_id)
    if (
        drill.status == DrillStatus.CANCELLED
        and run is not None
        and run.status == RunStatus.SUCCEEDED
        and run.ended_at is None
    ):
        reason = f"OxBlood drill {drill.id} was cancelled during provisioning"
        run.status = RunStatus.CANCELLED
        run.ended_at = datetime.now(timezone.utc)
        run.error = reason
        db.add(
            catalog_models.AuditLog(
                action=AuditAction.RUN_CANCELLED,
                actor="oxblood",
                scenario_id=run.scenario_id,
                run_id=run.id,
                details={"reason": reason, "actor": "oxblood"},
            )
        )

    env = dict(drill.environment_config or {})
    env["cleanup_status"] = "stopped"
    env["cleanup_run_id"] = run_id
    env.pop("cleanup_error", None)
    drill.environment_config = env
    db.add(
        DrillEvent(
            drill_id=drill.id,
            kind="lifecycle",
            title="Provisioned VMs cleaned up",
            detail=f"Stopped and destroyed VMs for provision run {run_id}",
        )
    )
    await db.commit()
    await db.refresh(drill)
    await release_environment_lock(db, drill_id=drill.id)
    return "stopped"


# ============================================================================
# Pydantic Models
# ============================================================================

class DrillCreate(BaseModel):
    title: str
    description: Optional[str] = None
    lab_id: Optional[int] = None  # read-only Learn ref (no FK)
    scenario_id: Optional[int] = None  # Drill catalog (scenarios table)
    drill_type: str = "individual"
    scheduled_start_at: Optional[datetime] = None
    scheduled_end_at: Optional[datetime] = None
    duration_limit_minutes: Optional[int] = None
    max_participants: Optional[int] = 10
    rules: Optional[dict] = None
    environment_config: Optional[dict] = None


class DrillUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    drill_type: Optional[str] = None
    scenario_id: Optional[int] = None
    scheduled_start_at: Optional[datetime] = None
    scheduled_end_at: Optional[datetime] = None
    duration_limit_minutes: Optional[int] = None
    max_participants: Optional[int] = None
    rules: Optional[dict] = None
    environment_config: Optional[dict] = None


class ParticipantAdd(BaseModel):
    user_id: int
    team_id: Optional[int] = None
    role: str = "participant"


class AnnouncementCreate(BaseModel):
    title: str
    content: str
    priority: str = "normal"


class ObjectiveCreate(BaseModel):
    title: str
    description: Optional[str] = None
    points: int = 0
    side: Optional[str] = None
    sort_order: int = 0


class ScenarioLink(BaseModel):
    lab_id: Optional[int] = None  # read-only Learn ref (no FK)
    scenario_id: Optional[int] = None  # Drill catalog (scenarios table)
    scenario_config: Optional[dict] = None


class ConsoleRequest(BaseModel):
    resize: str = "scale"


class ScenarioStartRequest(BaseModel):
    scenario_id: int
    duration_limit_minutes: Optional[int] = None
    max_participants: Optional[int] = 10


async def _refresh_drill_provision_state(db: AsyncSession, drill) -> dict:
    """Refresh asset VM state from PVE and return a role-by-role snapshot."""
    env = dict(drill.environment_config or {})
    run_id = _drill_provision_run_id(drill)
    preparation_at = env.get("preparation_started_at")
    if run_id is None and (preparation_at or drill.actual_start_at):
        # A background task can be interrupted after the runner commits its
        # Run but before it publishes provision_run_id to the drill. Recover
        # that association from the run created for this drill, including a
        # terminal run, so the UI never remains stuck at "preparing".
        run_query = (
            select(catalog_models.Run)
            .where(catalog_models.Run.scenario_id == drill.scenario_id)
            .order_by(catalog_models.Run.id.desc())
            .limit(1)
        )
        since = datetime.fromisoformat(preparation_at) if preparation_at else drill.actual_start_at
        if since is not None:
            run_query = run_query.where(
                catalog_models.Run.started_at >= since
            )
        active_run = (
            await db.execute(
                run_query
            )
        ).scalar_one_or_none()
        if active_run is not None:
            run_id = active_run.id
            env["provision_run_id"] = run_id
            if active_run.status == RunStatus.FAILED:
                env["provision_status"] = "failed"
                env["provision_error"] = active_run.error or "Provisioning failed."
            drill.environment_config = env
            await db.commit()
    if run_id is None:
        return {
            "run_id": None,
            "provision_phase": _provision_phase(env),
            "assets": [],
            "errors": [],
        }

    # Keep the drill lifecycle aligned with the authoritative runner state.
    # A prior readiness check may have marked the drill started before a
    # later asset failed, so terminal run state must always win.
    changed = False
    live_run = await db.get(catalog_models.Run, run_id)
    if live_run is not None and live_run.status == RunStatus.FAILED:
        env["provision_status"] = "failed"
        env["provision_error"] = live_run.error or "Provisioning failed."
        drill.environment_config = env
        changed = True

    assets = (
        await db.execute(
            select(catalog_models.Asset)
            .where(catalog_models.Asset.run_id == run_id)
            .order_by(catalog_models.Asset.role, catalog_models.Asset.id)
        )
    ).scalars().all()

    adapter = _get_runner()._adapter  # noqa: SLF001
    errors: list[dict] = []
    rows = []
    for asset in assets:
        # The runner commits each asset progressively, but recover from an
        # older/in-flight transaction by discovering the clone directly in
        # PVE. This keeps the live monitor accurate even during long seeds.
        if not asset.pve_vmid:
            vm_name = f"divide-{run_id}-{asset.role.replace('_', '')}"
            try:
                discovered = await adapter.find_vm(vm_name)
            except ProxmoxAPIError:
                discovered = None
            if discovered is not None:
                asset.pve_vmid = discovered.vmid
                asset.pve_node = discovered.node
                asset.pve_ip = discovered.ip or asset.pve_ip
                asset.status = (
                    AssetStatus.RUNNING
                    if discovered.status == "running"
                    else AssetStatus.BOOTING
                )
                changed = True
        status_value = asset.status.value if hasattr(asset.status, "value") else str(asset.status)
        if asset.pve_vmid and asset.pve_node and status_value not in {"planned", "cloning"}:
            try:
                state = await adapter.get_vm_state(int(asset.pve_vmid), asset.pve_node)
                next_status = (
                    AssetStatus.RUNNING
                    if state.status == "running"
                    else AssetStatus.STOPPED
                    if state.status == "stopped"
                    else AssetStatus.BOOTING
                )
                if asset.status != next_status:
                    asset.status = next_status
                    changed = True
                if state.ip and state.ip != asset.pve_ip:
                    asset.pve_ip = state.ip
                    changed = True
            except KeyError:
                if asset.status != AssetStatus.STOPPED:
                    asset.status = AssetStatus.STOPPED
                    changed = True
            except ProxmoxAPIError as exc:
                errors.append({"asset_id": asset.id, "role": asset.role, "error": str(exc)})
        rows.append(
            {
                "id": asset.id,
                "role": asset.role,
                "status": asset.status.value if hasattr(asset.status, "value") else str(asset.status),
                "pve_vmid": asset.pve_vmid,
                "pve_node": asset.pve_node,
                "ip": asset.pve_ip,
                "error": asset.error,
            }
        )

    ready_count = sum(1 for row in rows if row["status"] == "running")
    current = next(
        (row for row in rows if row["status"] not in {"running", "stopped"}),
        None,
    )
    # Power state is not evidence that guest seeding or validation completed.
    if changed:
        await db.commit()
        await db.refresh(drill)
    return {
        "run_id": run_id,
        "provision_phase": _provision_phase(drill.environment_config or {}),
        "progress": {
            "ready": ready_count,
            "total": len(rows),
            "current_role": current["role"] if current else None,
            "current_status": current["status"] if current else None,
        },
        "lifecycle": _drill_lifecycle(drill),
        "assets": rows,
        "errors": errors,
    }


def _role_base(role: str) -> str:
    parts = str(role or "").rsplit("_", 1)
    if len(parts) == 2 and parts[1].isdigit():
        return parts[0]
    return str(role or "")


def _human_role(role: str) -> str:
    text = _role_base(role).replace("_", " ")
    return " ".join(part.capitalize() for part in text.split()) or "Machine"


async def _tcp_connect_ok(host: str, port: int, timeout_s: float = 1.5) -> tuple[bool, str]:
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=timeout_s,
        )
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        _ = reader
        return True, f"Port {port} is reachable."
    except TimeoutError:
        return False, f"Port {port} did not answer before timeout."
    except OSError as exc:
        return False, f"Port {port} is not reachable: {exc.strerror or exc}"


async def _http_status_ok(
    host: str,
    port: int,
    path: str,
    expected_status: int,
    timeout_s: float = 2.0,
) -> tuple[bool, str]:
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=timeout_s,
        )
        req = (
            f"GET {path or '/'} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            "Connection: close\r\n\r\n"
        )
        writer.write(req.encode("ascii", errors="ignore"))
        await asyncio.wait_for(writer.drain(), timeout=timeout_s)
        line = await asyncio.wait_for(reader.readline(), timeout=timeout_s)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        text = line.decode("iso-8859-1", errors="ignore").strip()
        parts = text.split()
        status = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0
        if status == expected_status:
            return True, f"HTTP {expected_status} answered on {path or '/'}."
        return False, f"Expected HTTP {expected_status}, got {status or 'no status'}."
    except TimeoutError:
        return False, f"HTTP service did not answer before timeout."
    except OSError as exc:
        return False, f"HTTP service is not reachable: {exc.strerror or exc}"


def _asset_visible_for_probe(side: str, token: TokenData | None) -> bool:
    if token is None:
        return True
    role = str(token.role or "").lower()
    if role in {"admin", "lead", "observer"}:
        return True
    if side in {"shared", role}:
        return True
    return False


def _provision_checks_ready(health: dict) -> bool:
    """Team enrollment gates exercise start, not VM preparation."""
    return all(
        check.get("state") == "ready"
        for check in health.get("checks", [])
        if check.get("required") and check.get("id") != "mission-roster"
    )


async def _range_health(db: AsyncSession, drill, token: TokenData | None = None) -> dict:
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
    run_id = _drill_provision_run_id(drill)
    assets = []
    if run_id is not None:
        assets = (
            await db.execute(
                select(catalog_models.Asset)
                .where(catalog_models.Asset.run_id == run_id)
                .order_by(catalog_models.Asset.role, catalog_models.Asset.id)
            )
        ).scalars().all()
    assets_by_base: dict[str, list] = {}
    for asset in assets:
        assets_by_base.setdefault(_role_base(asset.role), []).append(asset)

    flags_expected = len(scenario_spec.get("flags") or [])
    flags_loaded = (
        await db.execute(
            select(DrillFlag).where(DrillFlag.drill_id == drill.id)
        )
    ).scalars().all()
    objectives_expected = sum(
        len((scenario_spec.get("objectives") or {}).get(side) or [])
        for side in ("red", "blue")
    )
    objectives_loaded = (
        await db.execute(
            select(DrillObjective).where(DrillObjective.drill_id == drill.id)
        )
    ).scalars().all()

    declared = (scenario_spec.get("validation") or {}).get("probes") or []
    if not declared:
        declared = [
            {
                "id": f"{asset.get('role')}-ready",
                "label": f"{_human_role(asset.get('role'))} is ready",
                "type": "role_running",
                "role": asset.get("role"),
                "side": _asset_side(str(asset.get("role") or "")),
            }
            for asset in scenario_spec.get("assets") or []
            if isinstance(asset, dict) and asset.get("role")
        ]
        declared.extend(
            [
                {
                    "id": "flags-loaded",
                    "label": "Scenario flags are loaded",
                    "type": "flag_seeded",
                    "side": "shared",
                },
                {
                    "id": "objectives-loaded",
                    "label": "Mission objectives are loaded",
                    "type": "objectives_seeded",
                    "side": "shared",
                },
            ]
        )

    async def check_probe(probe: dict) -> dict:
        kind = str(probe.get("type") or "")
        side = str(probe.get("side") or "shared")
        label = str(probe.get("label") or probe.get("id") or kind)
        role = str(probe.get("role") or "")
        state = "starting"
        detail = "Waiting for the range to finish preparing."
        if kind == "role_running":
            matches = assets_by_base.get(role, [])
            running = [
                asset for asset in matches
                if (asset.status.value if hasattr(asset.status, "value") else str(asset.status)) == "running"
            ]
            if matches and len(running) == len(matches):
                state = "ready"
                detail = f"{_human_role(role)} is running."
            elif matches and any(asset.error for asset in matches):
                state = "needs_attention"
                detail = next((asset.error for asset in matches if asset.error), "This machine needs an operator check.")
            elif not matches and run_id is not None:
                state = "needs_attention"
                detail = f"{_human_role(role)} was not created for this run."
        elif kind == "role_address":
            target_roles = [role] if role else list(assets_by_base.keys())
            target_assets = [asset for r in target_roles for asset in assets_by_base.get(r, [])]
            addressed = [asset for asset in target_assets if asset.pve_ip]
            if target_assets and len(addressed) == len(target_assets):
                state = "ready"
                detail = "Connection addresses are available."
            elif target_assets:
                detail = "Waiting for network addresses."
            elif run_id is not None:
                state = "needs_attention"
                detail = "No matching machines found."
        elif kind == "flag_seeded":
            if flags_expected == 0:
                state = "ready"
                detail = "This scenario has no flags."
            elif len(flags_loaded) >= flags_expected:
                state = "ready"
                detail = f"{len(flags_loaded)}/{flags_expected} flags are loaded."
            else:
                state = "needs_attention"
                detail = f"{len(flags_loaded)}/{flags_expected} flags are loaded."
        elif kind == "objectives_seeded":
            if objectives_expected == 0:
                state = "ready"
                detail = "This scenario has no mission objectives."
            elif len(objectives_loaded) >= objectives_expected:
                state = "ready"
                detail = f"{len(objectives_loaded)}/{objectives_expected} objectives are loaded."
            else:
                state = "needs_attention"
                detail = f"{len(objectives_loaded)}/{objectives_expected} objectives are loaded."
        elif kind == "telemetry_declared":
            sinks = (scenario_spec.get("telemetry") or {}).get("sinks") or []
            if sinks:
                state = "ready"
                detail = f"{len(sinks)} telemetry path{'s' if len(sinks) != 1 else ''} declared."
            else:
                state = "needs_attention"
                detail = "No telemetry path is declared."
        elif kind == "artifacts_declared":
            artifacts = scenario_spec.get("artifacts") or {}
            if artifacts.get("sink_to"):
                state = "ready"
                detail = "Evidence collection path is declared."
            else:
                state = "needs_attention"
                detail = "No evidence collection path is declared."
        elif kind in {"tcp_connect", "http_status"}:
            matches = assets_by_base.get(role, [])
            addressed = [asset for asset in matches if asset.pve_ip]
            port = int(probe.get("port") or (80 if kind == "http_status" else 22))
            timeout_s = max(0.2, min(float(probe.get("timeout_ms") or 1500) / 1000.0, 5.0))
            if not matches and run_id is not None:
                state = "needs_attention"
                detail = f"{_human_role(role)} was not created for this run."
            elif not addressed:
                detail = f"Waiting for {_human_role(role)} address."
            else:
                results = []
                for asset in addressed:
                    if kind == "http_status":
                        ok, msg = await _http_status_ok(
                            str(asset.pve_ip),
                            port,
                            str(probe.get("path") or "/"),
                            int(probe.get("expected_status") or 200),
                            timeout_s,
                        )
                    else:
                        ok, msg = await _tcp_connect_ok(
                            str(asset.pve_ip),
                            port,
                            timeout_s,
                        )
                    results.append((ok, msg))
                if len(addressed) != len(matches):
                    state = "starting"
                    detail = "Waiting for addresses on all matching machines."
                elif results and all(ok for ok, _msg in results):
                    state = "ready"
                    detail = results[0][1]
                elif results:
                    state = "needs_attention"
                    detail = next(msg for ok, msg in results if not ok)
        return {
            "id": str(probe.get("id") or kind),
            "label": label,
            "state": state,
            "detail": detail,
            "side": side,
            "required": bool(probe.get("required", True)) and kind not in {"telemetry_declared", "artifacts_declared"},
        }

    visible_probes = [
        probe
        for probe in declared
        if isinstance(probe, dict)
        and _asset_visible_for_probe(str(probe.get("side") or "shared"), token)
    ]
    checks = list(await asyncio.gather(*(check_probe(probe) for probe in visible_probes)))
    provision = str((drill.environment_config or {}).get("provision_status") or "")
    checks.insert(0, {
        "id": "guest-setup", "label": "Guest setup completed", "side": "shared", "required": True,
        "state": "ready" if provision in {"validating", "validation_failed", "started"} else "needs_attention" if provision == "failed" else "starting",
        "detail": "Guest configuration must finish before the exercise can start.",
    })
    expected_assets = sum(int(asset.get("count") or 1) for asset in scenario_spec.get("assets", []))
    healthy_assets = [asset for asset in assets if asset.status == AssetStatus.RUNNING and not asset.error]
    checks.insert(1, {
        "id": "range-machines", "label": "All range machines are running", "side": "shared", "required": True,
        "state": "ready" if expected_assets > 0 and len(healthy_assets) == expected_assets and len(assets) == expected_assets else "needs_attention",
        "detail": f"{len(healthy_assets)}/{expected_assets} machines running without provisioning errors.",
    })
    required_sides = [
        side for side in ("red", "blue")
        if (scenario_spec.get("objectives") or {}).get(side)
    ]
    if required_sides:
        roster = (
            await db.execute(
                select(DrillParticipant).where(
                    DrillParticipant.drill_id == drill.id,
                    DrillParticipant.status.notin_(["removed", "left"]),
                )
            )
        ).scalars().all()
        assigned = {str(item.role or "").lower() for item in roster}
        missing_sides = [side for side in required_sides if side not in assigned]
        checks.insert(2, {
            "id": "mission-roster",
            "label": "Required teams are enrolled",
            "side": "shared",
            "required": True,
            "state": "ready" if not missing_sides else "needs_attention",
            "detail": (
                "Red and Blue teams are enrolled."
                if not missing_sides
                else "Enroll at least one " + " and ".join(side.title() for side in missing_sides) + " participant."
            ),
        })
    required = [check for check in checks if check["required"]]
    ready_count = sum(1 for check in checks if check["state"] == "ready")
    issue_count = sum(1 for check in checks if check["state"] == "needs_attention")
    blocking_issue_count = sum(
        1 for check in required if check["state"] == "needs_attention"
    )
    starting_count = sum(1 for check in checks if check["state"] == "starting")
    if required and all(check["state"] == "ready" for check in required):
        mood = "ready"
        summary = "The range is ready for play."
    elif blocking_issue_count:
        mood = "needs_attention"
        summary = "The range needs an operator check."
    else:
        mood = "starting"
        summary = "The range is still preparing."
    return {
        "drill_id": drill.id,
        "run_id": run_id,
        "scenario": {
            "id": scenario.id if scenario else None,
            "name": scenario.name if scenario else None,
            "title": scenario.title if scenario else None,
        },
        "mood": mood,
        "summary": summary,
        "counts": {
            "ready": ready_count,
            "starting": starting_count,
            "needs_attention": issue_count,
            "total": len(checks),
        },
        "checks": checks,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


# ============================================================================
# Drill CRUD
# ============================================================================

@router.get("")
async def get_drills(
    status: Optional[DrillStatus] = Query(None),
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
        user = (
            await db.execute(select(User).where(User.sub == token.sub))
        ).scalar_one_or_none()
        if user is None:
            drills = []
        else:
            enrolled = (
                await db.execute(
                    select(DrillParticipant.drill_id).where(
                        DrillParticipant.user_id == user.id,
                        DrillParticipant.status.notin_(["removed", "left"]),
                    )
                )
            ).scalars().all()
            enrolled_ids = {int(drill_id) for drill_id in enrolled}
            drills = [
                drill
                for drill in drills
                if drill.id in enrolled_ids
                and drill.status in {
                    DrillStatus.SCHEDULED,
                    DrillStatus.ACTIVE,
                    DrillStatus.PAUSED,
                }
            ]
    return {"drills": [drill_to_dict(drill) for drill in drills]}


@router.get("/environment-lock")
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
        actor = (
            await db.execute(select(User).where(User.sub == token.sub))
        ).scalar_one_or_none()
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


@router.get("/{drill_id}")
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


@router.get("/{drill_id}/status")
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


@router.get("/{drill_id}/range-health")
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
        await db.execute(
            select(catalog_models.Run).where(catalog_models.Run.id == run_id)
        )
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
        await db.execute(
            select(catalog_models.Asset)
            .where(catalog_models.Asset.run_id == run_id)
            .order_by(catalog_models.Asset.role, catalog_models.Asset.id)
        )
    ).scalars().all()

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
                "seed_status": "Seeded" if env.get("provision_status") == "started" else "Pending seed",
                "credentials": credentials if _can_view_credentials(side, token) else None,
                "console_available": bool(asset.pve_vmid and asset.pve_node and status_value == "running"),
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
            visible_roles = {
                str(asset.get("role") or "") for asset in assets
            }
            scenario_assets = [
                asset
                for asset in scenario_assets
                if str(asset.get("role") or "") in visible_roles
            ]
            visible_networks = {
                str(network)
                for asset in assets
                for network in (asset.get("networks") or [])
            }
            networks = [
                network for network in networks
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
    operator_preparing = token.role in {Role.ADMIN, Role.LEAD} and drill_status == "scheduled" and (
        drill.environment_config or {}).get("provision_status") in {"starting", "waiting", "validating", "validation_failed", "started"}
    if operator_preparing:
        await assert_environment_owner(db, drill=drill, owner_sub=token.sub, is_admin=token.role == Role.ADMIN)
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
        await assert_environment_owner(db, drill=drill, owner_sub=token.sub, is_admin=token.role == Role.ADMIN)
        if scenario_id is None:
            raise HTTPException(status_code=409, detail="This drill has no scenario to prepare.")
        if drill.status == DrillStatus.SCHEDULED and env.get("provision_status") in {"starting", "waiting", "validating", "validation_failed", "started"}:
            return {"message": "Range already prepared or preparing", "status": drill.status.value,
                    "provision_status": env["provision_status"], "provision_run_id": env.get("provision_run_id")}
        if drill.status in {DrillStatus.ACTIVE, DrillStatus.SCHEDULED} and env.get("provision_status") == "failed":
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
                drill = (await db.execute(select(Drill).where(Drill.id == drill_id)
                         .with_for_update().execution_options(populate_existing=True))).scalar_one()
                env = dict(drill.environment_config or {})
                if env.get("provision_status") != "failed":
                    raise HTTPException(status_code=409, detail="Preparation state changed. Refresh before retrying.")
                env["provision_status"] = "starting"
                env.pop("provision_error", None)
                env.pop("cleanup_status", None)
                env.pop("provision_run_id", None)
                env["preparation_started_at"] = datetime.now(timezone.utc).isoformat()
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
        drill = (await db.execute(select(Drill).where(Drill.id == drill_id)
                 .with_for_update().execution_options(populate_existing=True))).scalar_one()
        env = dict(drill.environment_config or {})
        if drill.status != DrillStatus.SCHEDULED or env.get("provision_status") in {"starting", "waiting", "validating", "validation_failed", "started"}:
            raise HTTPException(status_code=409, detail="Preparation state changed. Refresh before retrying.")
        env["provision_status"] = "starting"
        env.pop("provision_error", None)
        env["preparation_started_at"] = datetime.now(timezone.utc).isoformat()
        env["run_owner_sub"] = token.sub
        env["run_owner_role"] = token.role
        drill.environment_config = env
        await db.commit()
        _queue_drill_provision(background_tasks, drill_id, scenario_id)
        return {
            "message": "Range preparation started; exercise timer has not started",
            "status": drill.status.value,
            "provision_run_id": (
                drill.environment_config or {}
            ).get("provision_run_id"),
            "provision_status": (
                drill.environment_config or {}
            ).get("provision_status"),
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
    await assert_environment_owner(db, drill=drill, owner_sub=token.sub, is_admin=token.role == Role.ADMIN)
    if drill.status != DrillStatus.SCHEDULED:
        raise HTTPException(status_code=409, detail="Only a scheduled, prepared drill can start.")
    if drill.scenario_id is not None:
        if (drill.environment_config or {}).get("provision_status") not in {"started", "validation_failed"}:
            raise HTTPException(status_code=409, detail="Prepare the range and finish validation before starting the exercise.")
        snapshot = await _refresh_drill_provision_state(db, drill)
        health = await _range_health(db, drill)
        if snapshot.get("errors") or health["mood"] != "ready":
            raise HTTPException(status_code=409, detail={
                "code": "range_not_ready", "message": "Range checks failed. Resolve readiness issues before starting.",
                "checks": health["checks"], "errors": snapshot.get("errors", []),
            })
    await acquire_environment_lock(db, owner_sub=token.sub, owner_role=token.role, drill_id=drill_id, commit=False)
    drill = (await db.execute(select(Drill).where(Drill.id == drill_id).with_for_update()
                             .execution_options(populate_existing=True))).scalar_one()
    if drill.status != DrillStatus.SCHEDULED:
        raise HTTPException(status_code=409, detail="The drill state changed. Refresh before starting.")
    env = dict(drill.environment_config or {})
    if drill.scenario_id is not None:
        if env.get("provision_status") not in {"started", "validation_failed"} or env.get("cleanup_status"):
            raise HTTPException(status_code=409, detail="The range changed during validation. Refresh before starting.")
        env["provision_status"] = "started"
        env["readiness_checked_at"] = health["checked_at"]
        env.pop("provision_error", None)
    env["run_owner_sub"] = token.sub
    env["run_owner_role"] = token.role
    drill.environment_config = env
    drill = await start_drill(db, drill_id)
    await set_environment_lock_status(db, drill_id=drill_id, status="active")
    return {"message": "Exercise started", "status": drill.status.value,
            "provision_status": env.get("provision_status"), "provision_run_id": env.get("provision_run_id")}


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
    return {"ready": bool(checks) and all(check["ready"] for check in checks), "node": node,
            "checks": checks, "checked_at": datetime.now(timezone.utc).isoformat()}


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
        actor = (
            await db.execute(select(User).where(User.sub == token.sub))
        ).scalar_one_or_none()
        created = await create_drill(
            db,
            title=scenario.title,
            description=f"Operator run of {scenario.title}",
            scenario_id=scenario.id,
            drill_type="individual",
            duration_limit_minutes=(
                data.duration_limit_minutes or scenario.duration_min
            ),
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
        env["preparation_started_at"] = datetime.now(timezone.utc).isoformat()
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
            current.actual_end_at = datetime.now(timezone.utc)
            db.add(DrillEvent(drill_id=drill_id, kind="lifecycle", title="Range preparation cancelled"))
            await db.commit()
            await db.refresh(current)
            drill = current
        else:
            drill = await stop_drill(db, drill_id)
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


# ============================================================================
# Participants
# ============================================================================

@router.get("/{drill_id}/participants")
async def get_participants(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Get all participants in a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    participants = await list_drill_participants(db, drill_id)
    user_ids = [p.user_id for p in participants]
    users_by_id = {}
    if user_ids:
        result = await db.execute(select(User).where(User.id.in_(user_ids)))
        users_by_id = {u.id: u for u in result.scalars().all()}
    return {
        "participants": [
            {
                "id": p.id,
                "user_id": p.user_id,
                "sub": users_by_id[p.user_id].sub if p.user_id in users_by_id else None,
                "username": users_by_id[p.user_id].sub if p.user_id in users_by_id else None,
                "team_id": p.team_id,
                "role": p.role,
                "status": p.status,
                "joined_at": p.joined_at.isoformat() if p.joined_at else None,
                "last_login_at": (
                    users_by_id[p.user_id].last_login_at.isoformat()
                    if p.user_id in users_by_id and users_by_id[p.user_id].last_login_at
                    else None
                ),
            }
            for p in participants
        ]
    }


@router.get("/{drill_id}/roster-candidates")
async def get_roster_candidates(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Return eligible Red/Blue accounts for the operator roster."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    enrolled_ids = (
        await db.execute(
            select(DrillParticipant.user_id).where(DrillParticipant.drill_id == drill_id)
        )
    ).scalars().all()
    users = (
        await db.execute(
            select(User)
            .where(User.role.in_([Role.RED.value, Role.BLUE.value]), User.disabled.is_(False))
            .order_by(User.role, User.sub)
        )
    ).scalars().all()
    enrolled = {int(user_id) for user_id in enrolled_ids}
    return {
        "drill_id": drill.id,
        "drill_status": drill.status.value,
        "candidates": [
            {
                "id": user.id,
                "sub": user.sub,
                "role": user.role,
                "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
            }
            for user in users
            if user.id not in enrolled
        ],
    }


@router.post("/{drill_id}/participants")
async def post_participant(
    drill_id: int,
    data: ParticipantAdd,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Add a participant to a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    if drill.status != DrillStatus.SCHEDULED:
        raise HTTPException(status_code=409, detail="Roster is locked after the drill starts.")
    side = str(data.role or "").lower()
    if side not in {"red", "blue"}:
        raise HTTPException(status_code=422, detail="Participant side must be red or blue.")
    user = await db.get(User, data.user_id)
    if user is None or user.disabled:
        raise HTTPException(status_code=404, detail="Eligible participant account not found")
    if str(user.role or "").lower() != side:
        raise HTTPException(
            status_code=422,
            detail=f"Account {user.sub!r} has role {user.role!r}; enroll it on the matching side.",
        )
    try:
        participant = await add_participant(
            db, drill_id, data.user_id, data.team_id, side
        )
        db.add(
            DrillEvent(
                drill_id=drill_id,
                kind="roster",
                title=f"{side.title()} participant enrolled",
                detail=user.sub,
                side=side,
                actor=token.sub,
            )
        )
        await db.commit()
        return {"message": "Participant added", "participant_id": participant.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/{drill_id}/participants/{user_id}")
async def delete_participant(
    drill_id: int,
    user_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Remove a participant from a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    if drill.status != DrillStatus.SCHEDULED:
        raise HTTPException(status_code=409, detail="Roster is locked after the drill starts.")
    participant = (
        await db.execute(
            select(DrillParticipant).where(
                DrillParticipant.drill_id == drill_id,
                DrillParticipant.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    removed = await remove_participant(db, drill_id, user_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Participant not found")
    db.add(
        DrillEvent(
            drill_id=drill_id,
            kind="roster",
            title="Participant removed from roster",
            detail=str(user_id),
            side=participant.role if participant else None,
            actor=token.sub,
        )
    )
    await db.commit()
    return {"message": "Participant removed"}


# ============================================================================
# Announcements
# ============================================================================

@router.get("/{drill_id}/announcements")
async def get_announcements(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Get all announcements for a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    announcements = await list_drill_announcements(db, drill_id)
    return {
        "announcements": [
            {
                "id": a.id,
                "title": a.title,
                "content": a.content,
                "priority": a.priority,
                "published_by": a.published_by,
                "published_at": a.published_at.isoformat() if a.published_at else None,
            }
            for a in announcements
        ]
    }


@router.post("/{drill_id}/announcements")
async def post_announcement(
    drill_id: int,
    data: AnnouncementCreate,
    db: AsyncSession = Depends(get_session),
):
    """Create a drill announcement."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        announcement = await create_announcement(
            db, drill_id, data.title, data.content, data.priority
        )
        return {"message": "Announcement created", "announcement_id": announcement.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# ============================================================================
# Objectives
# ============================================================================

@router.get("/{drill_id}/objectives")
async def get_objectives(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Get all objectives for a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    objectives = await list_drill_objectives(db, drill_id)
    return {
        "objectives": [
            {
                "id": o.id,
                "title": o.title,
                "description": o.description,
                "points": o.points,
                "side": o.side,
                "status": getattr(o, "status", "pending") or "pending",
                "sort_order": o.sort_order,
            }
            for o in objectives
        ]
    }


@router.post("/{drill_id}/objectives")
async def post_objective(
    drill_id: int,
    data: ObjectiveCreate,
    db: AsyncSession = Depends(get_session),
):
    """Create a drill objective."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        objective = await create_drill_objective(
            db, drill_id, data.title, data.description, data.points, data.side, data.sort_order
        )
        return {"message": "Objective created", "objective_id": objective.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# ============================================================================
# Flags (Drill-native; values never returned by list)
# ============================================================================

class FlagCreate(BaseModel):
    value: str
    name: str = "flag"
    points: int = 100
    objective_id: Optional[int] = None
    decay_window_seconds: int = 1800
    sort_order: int = 0


@router.get("/{drill_id}/flags")
async def get_flags(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
):
    """List flags for a drill (metadata only — values are secret)."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    flags = await list_drill_flags(db, drill_id)
    return {
        "flags": [
            {
                "id": f.id,
                "name": f.name,
                "points": f.points,
                "objective_id": f.objective_id,
                "sort_order": f.sort_order,
            }
            for f in flags
        ]
    }


@router.post("/{drill_id}/flags")
async def post_flag(
    drill_id: int,
    data: FlagCreate,
    db: AsyncSession = Depends(get_session),
):
    """Create a Drill-native flag."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        flag = await create_drill_flag(
            db, drill_id, data.value, data.name, data.points,
            data.objective_id, data.decay_window_seconds, data.sort_order,
        )
        return {"message": "Flag created", "flag_id": flag.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/{drill_id}/flags/{flag_id}")
async def remove_flag(
    drill_id: int,
    flag_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Delete a Drill flag."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    ok = await delete_drill_flag(db, drill_id, flag_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Flag not found")
    return {"message": "Flag deleted"}


# ============================================================================
# Scenarios
# ============================================================================

@router.get("/{drill_id}/scenarios")
async def get_scenarios(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Get all scenarios linked to a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    scenarios = await list_drill_scenarios(db, drill_id)
    scenario_ids = [s.scenario_id for s in scenarios if s.scenario_id is not None]
    catalog_by_id = {}
    if scenario_ids:
        catalog_rows = (
            await db.execute(
                select(catalog_models.Scenario).where(
                    catalog_models.Scenario.id.in_(scenario_ids)
                )
            )
        ).scalars().all()
        catalog_by_id = {row.id: row for row in catalog_rows}
    return {
        "scenarios": [
            {
                "id": s.id,
                "lab_id": s.lab_id,
                "scenario_id": s.scenario_id,
                "name": catalog_by_id[s.scenario_id].name if s.scenario_id in catalog_by_id else None,
                "title": catalog_by_id[s.scenario_id].title if s.scenario_id in catalog_by_id else None,
                "scenario_config": s.scenario_config,
                "is_active": s.is_active,
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
            for s in scenarios
        ]
    }


@router.post("/{drill_id}/scenarios")
async def post_scenario(
    drill_id: int,
    data: ScenarioLink,
    db: AsyncSession = Depends(get_session),
):
    """Link a lab scenario to a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        scenario = await link_scenario(db, drill_id, data.lab_id, data.scenario_id, data.scenario_config)
        return {
            "message": "Scenario linked",
            "link_id": scenario.id,
            "scenario_id": scenario.scenario_id,
            "lab_id": scenario.lab_id,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# ============================================================================
# Objective status (exercise flow: pending/in-progress/completed)
# ============================================================================

class ObjectiveStatusUpdate(BaseModel):
    status: str


@router.patch("/{drill_id}/objectives/{objective_id}")
async def patch_objective_status(
    drill_id: int,
    objective_id: int,
    data: ObjectiveStatusUpdate,
    db: AsyncSession = Depends(get_session),
):
    """Lead marks an objective pending / in-progress / completed."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        objective = await set_objective_status(db, drill_id, objective_id, data.status)
        try:
            await record_drill_event(
                db, drill_id, "objective",
                "Objective %s: %s" % (objective.status, objective.title),
            )
        except ValueError:
            pass
        return {"message": "Objective updated", "objective_id": objective.id, "status": objective.status}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# ============================================================================
# Exercise timeline (unified per-drill event feed)
# ============================================================================

class TimelineNote(BaseModel):
    title: str
    detail: Optional[str] = None
    side: Optional[str] = None


class MilestoneCreate(BaseModel):
    milestone: str
    detail: Optional[str] = None


@router.get("/{drill_id}/timeline")
async def get_timeline(
    drill_id: int,
    limit: int = 100,
    db: AsyncSession = Depends(get_session),
):
    """Chronological exercise timeline for one drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    events = await list_drill_events(db, drill_id, limit)
    return {
        "events": [
            {
                "id": e.id,
                "kind": e.kind,
                "title": e.title,
                "detail": e.detail,
                "side": e.side,
                "actor": e.actor,
                "created_at": e.created_at.isoformat() if e.created_at else None,
            }
            for e in events
        ]
    }


@router.post("/{drill_id}/timeline")
async def post_timeline_note(
    drill_id: int,
    data: TimelineNote,
    db: AsyncSession = Depends(get_session),
):
    """Lead appends an exercise note to the drill timeline."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        event = await record_drill_event(
            db, drill_id, "note", data.title, data.detail, data.side,
        )
        return {"message": "Note recorded", "event_id": event.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/{drill_id}/milestones")
async def post_milestone(
    drill_id: int,
    data: MilestoneCreate,
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    """Record a detection or containment milestone with elapsed time."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    milestone = data.milestone.strip().lower()
    if milestone not in {"detection", "containment"}:
        raise HTTPException(
            status_code=422,
            detail="milestone must be detection or containment",
        )
    elapsed_seconds = None
    if drill.actual_start_at:
        elapsed_seconds = max(
            0,
            int((datetime.now(drill.actual_start_at.tzinfo) - drill.actual_start_at).total_seconds()),
        )
    score_result = {"points_awarded": 0, "already_recorded": False}
    if elapsed_seconds is not None and token and token.sub:
        user_result = await db.execute(
            select(catalog_models.User).where(catalog_models.User.sub == token.sub)
        )
        user = user_result.scalar_one_or_none()
        if user:
            score_result = await record_milestone_score(
                db, user.id, drill_id, milestone, elapsed_seconds,
            )
    try:
        event = await record_drill_event(
            db,
            drill_id,
            "milestone",
            milestone.title() + " milestone recorded",
            detail=data.detail,
            side="blue",
            actor=(token.sub if token else None),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {
        "event_id": event.id,
        "milestone": milestone,
        "elapsed_seconds": elapsed_seconds,
        **score_result,
    }
