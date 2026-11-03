"""Background range provisioning jobs and runner access."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

from fastapi import BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import models as catalog_models
from app.db.models import AssetStatus, AuditAction, RunStatus
from app.db.models_drill import (
    Drill,
    DrillEvent,
    DrillStatus,
    DrillTeam,
)
from app.db.session import get_sessionmaker
from app.modules.drills.lifecycle import (
    provision_run_id as _drill_provision_run_id,
)
from app.modules.drills.lock import (
    release_environment_lock,
    set_environment_lock_status,
)
from app.runners.runner import RunnerError, RunRequest
from app.services import matches
from app.services.drill_service import (
    get_drill,
)
from app.services.proxmox import ProxmoxAPIError
from app.services.pve_sdn import SdnPermissionError

from .access import _get_runner
from .health import _provision_checks_ready, _range_health

log = logging.getLogger("app.routers.drills_v2")


@dataclass
class ProvisionJob:
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None


_PROVISION_JOBS: dict[int, ProvisionJob] = {}


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
            await db.execute(select(Drill).where(Drill.id == drill_id).with_for_update())
        ).scalar_one_or_none()
        if not drill:
            return
        env = dict(drill.environment_config or {})
        terminal_or_cleaning = drill.status in {
            DrillStatus.COMPLETED,
            DrillStatus.CANCELLED,
        } or env.get("cleanup_status") in {"stopping", "stopped"}
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
            scenario = await db.get(catalog_models.Scenario, scenario_id)
            doc = (scenario.spec if scenario else None) or {}
            copies = await _match_count(db, drill)
            if ((doc.get("spec") or doc).get("provisioning") or {}).get("auto_baseline"):
                await _set_drill_provision_status(
                    drill_id,
                    "starting",
                    error="Checking clean snapshots; building them on the first prepare.",
                )
                for copy in range(1, copies + 1):
                    await runner.build_snapshot_baselines(
                        scenario_id, db, actor="oxblood", instance=copy
                    )
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
                            .where(
                                catalog_models.Run.status.in_(
                                    [RunStatus.PENDING, RunStatus.RUNNING]
                                )
                            )
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
            for copy in range(2, copies + 1):
                if job.cancel_event.is_set():
                    break
                await _set_drill_provision_status(
                    drill_id,
                    "starting",
                    provision_run_id=result.run_id,
                    error=f"Preparing the range for match {copy} of {copies}.",
                )
                extra = await runner.start_run(
                    RunRequest(
                        scenario_id=scenario_id,
                        started_by="oxblood",
                        timeout_min=-1,
                        cancel_event=job.cancel_event,
                        instance=copy,
                    ),
                    db,
                )
                await _record_match_run(drill_id, copy, extra.run_id)
        if result.status == RunStatus.CANCELLED:
            await _set_drill_provision_status(drill_id, "cancelled", provision_run_id=result.run_id)
        else:
            await _set_drill_provision_status(
                drill_id, "validating", provision_run_id=result.run_id
            )
            async with sm() as db:
                drill = await get_drill(db, drill_id)
                if drill is not None:
                    health = await _range_health(db, drill)
                    prepared = _provision_checks_ready(health)
                    await _set_drill_provision_status(
                        drill_id,
                        "started" if prepared else "validation_failed",
                        error=None
                        if prepared
                        else "Range validation failed. Review readiness checks before starting.",
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
        if newest_run is not None and (recorded_run is None or newest_run.id > recorded_run.id):
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

    all_run_ids = [run_id, *(r for n, r in sorted(matches.run_ids(drill).items()) if r != run_id)]
    try:
        for each in all_run_ids:
            await _get_runner().stop_run(
                each,
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
        (
            await db.execute(
                select(catalog_models.Asset)
                .where(catalog_models.Asset.run_id.in_(all_run_ids))
                .where(catalog_models.Asset.status == AssetStatus.ORPHANED)
            )
        )
        .scalars()
        .all()
    )
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
        run.ended_at = datetime.now(UTC)
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


async def _set_range_reset(drill_id: int, status: str, error: str | None = None) -> None:
    async with get_sessionmaker()() as db:
        drill = (
            await db.execute(select(Drill).where(Drill.id == drill_id).with_for_update())
        ).scalar_one_or_none()
        if drill is None:
            return
        env = dict(drill.environment_config or {})
        env["range_reset"] = {
            "status": status,
            "error": error,
            "at": datetime.now(UTC).isoformat(),
        }
        drill.environment_config = env
        db.add(
            DrillEvent(
                drill_id=drill_id,
                kind="lifecycle",
                title={
                    "resetting": "Range reset started",
                    "ready": "Range reset completed",
                    "failed": "Range reset failed",
                }[status],
                detail=error,
            )
        )
        await db.commit()


async def _reset_range_background(drill_id: int, run_ids: int | list[int]) -> None:
    ids = [run_ids] if isinstance(run_ids, int) else list(run_ids)
    try:
        for run_id in ids:
            async with get_sessionmaker()() as db:
                await _get_runner().reset_run_to_baselines(run_id, db, actor="oxblood")
        await _set_range_reset(drill_id, "ready")
    except Exception as exc:  # noqa: BLE001
        log.exception("oxblood.range_reset_failed drill_id=%s", drill_id)
        await _set_range_reset(drill_id, "failed", _provision_error_message(exc))


async def _match_count(db: AsyncSession, drill) -> int:
    """How many range copies this drill needs: 1 unless matches are separate."""
    if not matches.is_separate(drill):
        return 1
    teams = (await db.execute(select(DrillTeam).where(DrillTeam.drill_id == drill.id))).scalars()
    return matches.match_count(list(teams))


async def _record_match_run(drill_id: int, copy: int, run_id: int) -> None:
    async with get_sessionmaker()() as db:
        drill = (
            await db.execute(select(Drill).where(Drill.id == drill_id).with_for_update())
        ).scalar_one_or_none()
        if drill is None:
            return
        env = dict(drill.environment_config or {})
        env[matches.RUNS_KEY] = {**(env.get(matches.RUNS_KEY) or {}), str(copy): run_id}
        drill.environment_config = env
        await db.commit()
