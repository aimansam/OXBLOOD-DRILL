"""Run timeout watchdog: deadlines, rescheduling after restart, extension, firing."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.db import models
from app.db.models import AssetStatus, AuditAction, RunStatus
from app.observability import (
    inc_run_terminal,
)
from app.runners.runner_base import (
    RunnerBase,
    RunnerError,
    _adapter_label,
    _sessionmaker,
)

log = logging.getLogger("app.runners.runner")


class WatchdogMixin(RunnerBase):
    """Run timeout watchdog: deadlines, rescheduling after restart, extension, firing."""

    def _schedule_watchdog(
        self,
        run_id: int,
        node: str,
        asset_count: int,
        timeout_min: int | None = None,
    ) -> None:
        """Spawn the timeout watchdog as a background asyncio task.

        Idempotent: if the timeout is disabled (env override) or
        non-positive, no task is scheduled. Otherwise the task sleeps
        for the resolved timeout * 60 seconds and then invokes
        :meth:`_watchdog_timeout_fire`. The task owns its own session,
        so it survives the request-response cycle that started the run.
        """
        enabled = getattr(settings, "drill_timeout_enabled", True)
        timeout_min = self._resolve_timeout_min(
            timeout_min, getattr(settings, "drill_timeout_min", 0)
        )
        if not enabled or timeout_min <= 0:
            return

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No loop (e.g. synchronous test). Watchdog is a safety net;
            # skip and rely on manual cancel.
            logging.getLogger(__name__).info("runner.watchdog.no_loop run_id=%s (skipping)", run_id)
            return

        now = datetime.now(UTC)
        self._active_deadlines[run_id] = now + timedelta(minutes=timeout_min)
        task = loop.create_task(
            self._watchdog_timeout_fire(
                run_id=run_id,
                node=node,
                timeout_min=timeout_min,
                asset_count=asset_count,
            )
        )
        self._active_tasks[run_id] = task

    @staticmethod
    def _resolve_timeout_min(
        requested_min: int | None,
        fallback_min: int | None,
    ) -> int:
        """Return the first valid lifecycle limit.

        ``0`` and negative values intentionally disable the watchdog when
        supplied as the final fallback, preserving the existing operator
        override. Positive drill/scenario values always take precedence over
        the legacy global default.
        """
        for value in (requested_min, fallback_min):
            if value is None:
                continue
            try:
                value_int = int(value)
            except (TypeError, ValueError):
                continue
            if value_int != 0:
                return value_int
        return 0

    @classmethod
    def get_timeout_sec(
        cls,
        run_id: int,
        started_at: datetime | None = None,
        timeout_min: int | None = None,
    ) -> int | None:
        """Return remaining seconds until auto-timeout for a run.

        If the in-memory deadline is lost (e.g. server restart), reconstructs it
        from started_at and default drill_timeout_min.
        """
        now = datetime.now(UTC)
        if timeout_min is not None and timeout_min < 0:
            return None
        deadline = cls._active_deadlines.get(run_id)

        if deadline is None and started_at is not None:
            timeout_min = cls._resolve_timeout_min(
                timeout_min, getattr(settings, "drill_timeout_min", 30)
            )
            # Ensure started_at is timezone-aware
            if started_at.tzinfo is None:
                started_at = started_at.replace(tzinfo=UTC)
            deadline = started_at + timedelta(minutes=timeout_min)
            cls._active_deadlines[run_id] = deadline

        if deadline is None:
            timeout_min = cls._resolve_timeout_min(
                timeout_min, getattr(settings, "drill_timeout_min", 30)
            )
            return timeout_min * 60

        remaining = int((deadline - now).total_seconds())
        return max(0, remaining)

    @classmethod
    async def recover_watchdogs(cls, session: AsyncSession) -> int:
        """Reschedule watchdogs for any RUNNING drills after API restart.

        Returns the number of watchdogs rescheduled.
        """
        if not getattr(settings, "drill_timeout_enabled", True):
            return 0

        runs = (
            (
                await session.execute(
                    select(models.Run)
                    .where(models.Run.status == RunStatus.RUNNING)
                    .options(
                        selectinload(models.Run.assets),
                        selectinload(models.Run.scenario),
                    )
                )
            )
            .scalars()
            .all()
        )

        # Late import: runner.py imports this module.
        from app.runners.runner import _default_adapter

        rescheduled = 0
        for run in runs:
            if run.id in cls._active_tasks:
                continue  # Already scheduled
            if run.timeout_min is not None and run.timeout_min < 0:
                # V2 drills own their timer; preparation must not consume it.
                continue

            scenario_timeout_min = run.timeout_min or getattr(run.scenario, "duration_min", None)
            remaining = cls.get_timeout_sec(
                run.id,
                run.started_at,
                timeout_min=scenario_timeout_min,
            )
            if remaining is None:
                continue  # no deadline can be derived
            if remaining <= 0:
                log.warning(
                    "runner.recover_watchdog.already_expired run_id=%s remaining=%s - firing timeout immediately",
                    run.id,
                    remaining,
                )
                # Get node from first asset
                node = run.assets[0].pve_node if run.assets else None
                if node:
                    # Create a Runner instance to fire the timeout
                    runner = cls(adapter=_default_adapter())
                    # Fire timeout immediately (sleep for 0 seconds)
                    task = asyncio.get_running_loop().create_task(
                        runner._watchdog_timeout_fire(
                            run_id=run.id,
                            node=node,
                            timeout_min=0,  # Fire immediately
                            asset_count=len(run.assets),
                        )
                    )
                    cls._active_tasks[run.id] = task
                continue

            # Get node from first asset (watchdog needs it for teardown)
            node = None
            if run.assets:
                node = run.assets[0].pve_node

            if not node:
                log.warning(
                    "runner.recover_watchdog.no_node run_id=%s",
                    run.id,
                )
                continue

            runner = cls(adapter=_default_adapter())
            runner._schedule_watchdog(
                run.id,
                node,
                len(run.assets),
                timeout_min=scenario_timeout_min,
            )
            log.info(
                "runner.recover_watchdog.rescheduled run_id=%s remaining_sec=%s",
                run.id,
                remaining,
            )
            rescheduled += 1

        return rescheduled

    async def extend_timeout(
        self,
        run_id: int,
        extend_min: int = 30,
        actor: str | None = None,
        session: AsyncSession | None = None,
    ) -> dict:
        """Extend the auto-timeout for an active run by extend_min minutes."""
        if extend_min <= 0 or extend_min > 240:
            raise RunnerError("extend_min must be between 1 and 240 minutes")

        sm = _sessionmaker()

        async def _do(s: AsyncSession) -> dict:
            run = (
                await s.execute(
                    select(models.Run)
                    .where(models.Run.id == run_id)
                    .options(selectinload(models.Run.assets))
                )
            ).scalar_one_or_none()
            if run is None:
                raise RunnerError(f"run id={run_id} not found")
            if run.status not in (RunStatus.RUNNING, RunStatus.PENDING):
                raise RunnerError(
                    f"cannot extend timeout for terminal run (status={run.status.value})"
                )

            now = datetime.now(UTC)
            current_deadline = self._active_deadlines.get(run_id)
            if current_deadline is None or current_deadline < now:
                new_deadline = now + timedelta(minutes=extend_min)
            else:
                new_deadline = current_deadline + timedelta(minutes=extend_min)

            self._active_deadlines[run_id] = new_deadline
            remaining_sec = max(0, int((new_deadline - now).total_seconds()))

            # Cancel existing task if any and spawn a new one with remaining time
            old_task = self._active_tasks.get(run_id)
            if old_task and not old_task.done():
                old_task.cancel()

            node = getattr(settings, "proxmox_node", "pve") or "pve"
            try:
                loop = asyncio.get_running_loop()
                task = loop.create_task(
                    self._watchdog_timeout_fire(
                        run_id=run_id,
                        node=node,
                        timeout_min=remaining_sec / 60.0,
                        asset_count=len(run.assets) if run.assets else 0,
                    )
                )
                self._active_tasks[run_id] = task
            except RuntimeError:
                pass

            await self._audit(
                s,
                action=AuditAction.RUN_EXTENDED,
                actor=actor or "unknown",
                run_id=run.id,
                details={
                    "extended_by_min": extend_min,
                    "new_deadline": new_deadline.isoformat(),
                    "remaining_sec": remaining_sec,
                },
            )
            await s.commit()

            return {
                "run_id": run_id,
                "extended_by_min": extend_min,
                "remaining_sec": remaining_sec,
                "new_deadline": new_deadline.isoformat(),
            }

        if session is not None:
            return await _do(session)
        async with sm() as session:
            return await _do(session)

    async def _watchdog_timeout_fire(
        self, *, run_id: int, node: str, timeout_min: float, asset_count: int
    ) -> None:
        """Sleep then flip the run to TIMEOUT if still RUNNING.

        Best-effort: if anything fails (DB down, adapter crash), log
        and move on. The audit + metric paths are fire-and-forget;
        we never raise out of the watchdog.
        """
        try:
            await asyncio.sleep(timeout_min * 60)
        except asyncio.CancelledError:
            return  # Run terminated on its own; no-op.

        sm = _sessionmaker()
        try:
            async with sm() as session:
                run = (
                    await session.execute(select(models.Run).where(models.Run.id == run_id))
                ).scalar_one_or_none()
                if run is None:
                    log.info("runner.watchdog.run_gone run_id=%s", run_id)
                    return
                if run.status != RunStatus.RUNNING:
                    log.info(
                        "runner.watchdog.run_already_terminal run_id=%s status=%s",
                        run_id,
                        run.status.value,
                    )
                    return

                # Best-effort adapter teardown.
                assets = (
                    (
                        await session.execute(
                            select(models.Asset).where(models.Asset.run_id == run_id)
                        )
                    )
                    .scalars()
                    .all()
                )
                for asset in assets:
                    if asset.pve_vmid is None or not asset.pve_node:
                        continue
                    try:
                        await self._adapter.stop_vm(asset.pve_vmid, asset.pve_node, force=True)
                    except Exception as exc:  # noqa: BLE001
                        log.warning(
                            "runner.watchdog.stop_failed vmid=%s err=%s",
                            asset.pve_vmid,
                            exc,
                        )
                    try:
                        await self._adapter.destroy_vm(asset.pve_vmid, asset.pve_node)
                    except Exception as exc:  # noqa: BLE001
                        log.warning(
                            "runner.watchdog.destroy_failed vmid=%s err=%s",
                            asset.pve_vmid,
                            exc,
                        )
                    asset.status = AssetStatus.STOPPED

                self._active_deadlines.pop(run_id, None)
                self._active_tasks.pop(run_id, None)
                run.status = RunStatus.TIMEOUT
                run.ended_at = datetime.now(UTC)
                run.error = f"auto-timeout after {timeout_min} min"
                inc_run_terminal(outcome="timeout", adapter=_adapter_label(self._adapter))
                await self._audit(
                    session,
                    action=AuditAction.RUN_TIMEOUT,
                    actor="watchdog",
                    run_id=run.id,
                    details={
                        "timeout_min": timeout_min,
                        "asset_count": asset_count,
                    },
                )
                await session.commit()
                log.info(
                    "runner.watchdog.timeout_fired run_id=%s timeout_min=%s",
                    run_id,
                    timeout_min,
                )
        except Exception as exc:  # noqa: BLE001
            log.error(
                "runner.watchdog.failed run_id=%s err=%s",
                run_id,
                exc,
                exc_info=True,
            )
