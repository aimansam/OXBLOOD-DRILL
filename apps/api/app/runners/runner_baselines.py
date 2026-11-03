"""Snapshot-baseline promotion and restore for the run orchestrator."""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import models
from app.db.models import AssetStatus, AuditAction, RunStatus
from app.runners.adapter import SeedSpec
from app.runners.runner_base import (
    _PERSISTENT_APPLIANCE_BASELINE,
    RunnerBase,
    RunnerError,
    _static_ip_configs,
    _vm_name,
    instance_spec,
)

log = logging.getLogger("app.runners.runner")


class BaselineMixin(RunnerBase):
    """Snapshot-baseline promotion and restore for the run orchestrator."""

    async def ready_baseline_roles(
        self, scenario: models.Scenario, session: AsyncSession, instance: int = 1
    ) -> set[str]:
        """Roles that already have a ready baseline for this scenario version and copy."""
        rows = (
            (
                await session.execute(
                    select(models.SnapshotBaseline).where(
                        models.SnapshotBaseline.scenario_id == scenario.id,
                        models.SnapshotBaseline.scenario_version == scenario.version,
                        models.SnapshotBaseline.instance == instance,
                        models.SnapshotBaseline.status == "ready",
                    )
                )
            )
            .scalars()
            .all()
        )
        return {row.role for row in rows}

    async def reset_run_to_baselines(
        self,
        run_id: int,
        session: AsyncSession,
        actor: str | None = None,
        *,
        settle_timeout_s: float = 150.0,
        poll_s: float = 3.0,
    ) -> int:
        """Roll a live run's VMs back to their clean snapshots, boot and check them.

        The run and drill stay as they are; only the machines return to the
        baseline. Refuses up front when any VM has no baseline, since those
        cannot be reset in place.
        """
        run = (
            await session.execute(
                select(models.Run)
                .where(models.Run.id == run_id)
                .options(selectinload(models.Run.scenario), selectinload(models.Run.assets))
            )
        ).scalar_one_or_none()
        if run is None:
            raise RunnerError(f"run id={run_id} not found")
        assets = list(run.assets)
        baselines = {a.id: await self._baseline_for_asset(session, a) for a in assets}
        missing = sorted(a.role for a in assets if baselines[a.id] is None)
        if not assets or missing:
            raise RunnerError(
                "Cannot reset in place; no snapshot baseline for: "
                + (", ".join(missing) or "any machine")
            )
        document = run.scenario.spec if isinstance(run.scenario.spec, dict) else {}
        copy = next(iter(baselines.values())).instance  # type: ignore[union-attr]
        spec = instance_spec(document.get("spec") or document, copy)
        specs = {str(a.get("role")): a for a in spec.get("assets", [])}
        for asset in assets:
            await self._restore_baseline_asset(
                session=session,
                asset=asset,
                asset_spec=specs.get(re.sub(r"_\d+$", "", asset.role), {}),
                baseline=baselines[asset.id],  # type: ignore[arg-type]
                actor=actor,
            )
        down = [a.role for a in assets if a.status != AssetStatus.RUNNING]
        if down:
            raise RunnerError("Range reset incomplete, not running: " + ", ".join(sorted(down)))
        problems = await self._wait_for_guests(assets, specs, spec, settle_timeout_s, poll_s)
        if problems:
            raise RunnerError("Range reset check failed: " + "; ".join(problems))
        return len(assets)

    async def _wait_for_guests(
        self,
        assets: list[models.Asset],
        specs: dict[str, dict],
        spec: dict,
        timeout_s: float,
        poll_s: float,
    ) -> list[str]:
        """Wait until every guest agent reports the address the scenario gives that machine.

        "The VM is running" is not enough: after a snapshot rollback a guest can be up with no
        network (drill 143: RED01 had only a loopback address). Machines without a guest agent
        (the OPNsense router) are skipped.
        """
        pending = {
            a.id: a
            for a in assets
            if a.pve_vmid is not None
            and a.pve_node
            and "opnsense" not in (a.template or "").lower()
        }
        problems: dict[int, str] = {}
        deadline = asyncio.get_running_loop().time() + timeout_s
        while pending:
            for asset_id, asset in list(pending.items()):
                state = await self._adapter.get_vm_state(asset.pve_vmid, asset.pve_node)  # type: ignore[arg-type]
                asset_spec = specs.get(re.sub(r"_\d+$", "", asset.role), {})
                configs = _static_ip_configs(asset_spec, spec) if asset_spec else {}
                expected = None
                if len(configs) == 1:
                    match = re.search(r"ip=([\d.]+)/", next(iter(configs.values())))
                    expected = match.group(1) if match else None
                if state.status != "running":
                    problems[asset_id] = f"{asset.role}: {state.status}"
                elif not state.ip:
                    problems[asset_id] = f"{asset.role}: the guest agent reports no address"
                elif expected and state.ip != expected:
                    problems[asset_id] = f"{asset.role}: address {state.ip}, expected {expected}"
                else:
                    asset.pve_ip = state.ip
                    problems.pop(asset_id, None)
                    del pending[asset_id]
            if not pending or asyncio.get_running_loop().time() >= deadline:
                break
            await asyncio.sleep(poll_s)
        return sorted(problems.values())

    async def build_snapshot_baselines(
        self,
        scenario_id: int,
        session: AsyncSession,
        actor: str | None = None,
        snapshot_name: str = "clean-baseline",
        instance: int = 1,
    ) -> list[models.SnapshotBaseline]:
        """Clone, boot and seed a scenario once, check it, then snapshot it.

        Replaces the manual "prepare a range, verify it, capture it" sequence.
        Does nothing when every role already has a ready baseline for the
        current scenario version. A failed build destroys its clones; stale
        baselines from an older scenario version are never deleted here.
        """
        from app.runners.runner import RunRequest  # circular at import time

        scenario = await session.get(models.Scenario, scenario_id)
        if scenario is None:
            raise RunnerError(f"scenario id={scenario_id} not found")
        document = scenario.spec if isinstance(scenario.spec, dict) else {}
        spec = document.get("spec") or document
        expected = {
            f"{a['role']}_{i + 1}" if int(a.get("count") or 1) > 1 else str(a["role"])
            for a in spec.get("assets", [])
            for i in range(max(1, min(int(a.get("count") or 1), 64)))
        }
        have = await self.ready_baseline_roles(scenario, session, instance)
        if expected and expected <= have:
            return []
        if (
            have
            or (
                await session.execute(
                    select(models.SnapshotBaseline.id).where(
                        models.SnapshotBaseline.scenario_id == scenario.id,
                        models.SnapshotBaseline.instance == instance,
                    )
                )
            ).first()
        ):
            raise RunnerError(
                f"Scenario {scenario.name!r} has baselines from another version or an "
                "incomplete set. Retire them before building new ones."
            )

        result = await self.start_run(  # type: ignore[attr-defined]
            RunRequest(
                scenario_id=scenario.id, started_by=actor, timeout_min=-1, instance=instance
            ),
            session,
        )
        run = (
            await session.execute(
                select(models.Run)
                .where(models.Run.id == result.run_id)
                .options(selectinload(models.Run.assets))
                .execution_options(populate_existing=True)
            )
        ).scalar_one()
        problems = []
        for asset in run.assets:
            if asset.pve_vmid is None or not asset.pve_node:
                problems.append(f"{asset.role}: no VM")
                continue
            state = await self._adapter.get_vm_state(asset.pve_vmid, asset.pve_node)
            if state.status != "running":
                problems.append(f"{asset.role}: {state.status}")
        if problems:
            await self.stop_run(  # type: ignore[attr-defined]
                run.id, reason="baseline build failed verification", session=session, actor=actor
            )
            raise RunnerError("Baseline build failed, clones removed: " + "; ".join(problems))
        return await self.promote_run_to_snapshot_baseline(
            run.id, session, actor=actor, snapshot_name=snapshot_name, instance=instance
        )

    async def promote_run_to_snapshot_baseline(
        self,
        run_id: int,
        session: AsyncSession,
        actor: str | None = None,
        snapshot_name: str = "clean-baseline",
        instance: int = 1,
    ) -> list[models.SnapshotBaseline]:
        """Turn a verified, running scenario run into persistent baselines.

        This is intentionally a one-time operation per scenario version. It
        stops the already-configured range, takes cold PVE snapshots, and
        records VM ownership so future drills restore rather than clone.
        """
        run = (
            await session.execute(
                select(models.Run)
                .where(models.Run.id == run_id)
                .options(selectinload(models.Run.scenario), selectinload(models.Run.assets))
            )
        ).scalar_one_or_none()
        if run is None:
            raise RunnerError(f"run id={run_id} not found")
        scenario = run.scenario
        assets = list(run.assets)
        if not assets:
            raise RunnerError("A baseline can only be captured from a fully running range.")
        # A previous interrupted snapshot attempt may have stopped a VM after
        # updating its in-memory asset state but before committing the run.
        # Verify PVE itself before refusing a verified baseline capture.
        for asset in assets:
            if asset.pve_vmid is None or not asset.pve_node:
                raise RunnerError(f"Asset {asset.role!r} has no PVE VM to snapshot.")
            state = await self._adapter.get_vm_state(asset.pve_vmid, asset.pve_node)
            if state.status != "running":
                raise RunnerError(
                    f"A baseline can only be captured from a fully running range; "
                    f"{asset.role!r} is {state.status}."
                )
            asset.status = AssetStatus.RUNNING
            asset.pve_ip = state.ip
        existing = (
            (
                await session.execute(
                    select(models.SnapshotBaseline).where(
                        models.SnapshotBaseline.scenario_id == scenario.id,
                        models.SnapshotBaseline.instance == instance,
                    )
                )
            )
            .scalars()
            .all()
        )
        if existing:
            raise RunnerError(
                f"Scenario {scenario.name!r} already has snapshot baselines. "
                "Rebuild or retire them before capturing another set."
            )

        created: list[models.SnapshotBaseline] = []
        for asset in assets:
            async with self._pve_lifecycle_section(
                "baseline-snapshot", run_id=run.id, role=asset.role, vmid=asset.pve_vmid
            ):
                await self._adapter.stop_vm(asset.pve_vmid, asset.pve_node, force=True)  # type: ignore[arg-type]
                snapshots = await self._adapter.list_vm_snapshots(asset.pve_vmid, asset.pve_node)  # type: ignore[arg-type]
                asset_snapshot_name = snapshot_name
                if snapshot_name not in snapshots:
                    try:
                        await self._adapter.create_vm_snapshot(
                            asset.pve_vmid,  # type: ignore[arg-type]
                            asset.pve_node,  # type: ignore[arg-type]
                            snapshot_name,
                            description=f"OxBlood {scenario.name} v{scenario.version} clean baseline",
                        )
                    except Exception as exc:  # noqa: BLE001
                        # The OPNsense image is a raw disk on directory
                        # storage, where PVE cannot snapshot it. Its config
                        # is immutable during a drill, so retain it as a
                        # persistent appliance while mutable VMs roll back.
                        if "snapshot feature is not available" not in str(exc).lower():
                            raise
                        asset_snapshot_name = _PERSISTENT_APPLIANCE_BASELINE
                        log.warning(
                            "runner.baseline.persistent_appliance role=%s vmid=%s",
                            asset.role,
                            asset.pve_vmid,
                        )
            asset.status = AssetStatus.STOPPED
            asset.cleaned_at = datetime.now(UTC)
            baseline = models.SnapshotBaseline(
                scenario_id=scenario.id,
                scenario_version=scenario.version,
                instance=instance,
                role=asset.role,
                template=asset.template,
                pve_vmid=asset.pve_vmid,
                pve_node=asset.pve_node,
                snapshot_name=asset_snapshot_name,
                status="ready",
                source_run_id=run.id,
            )
            session.add(baseline)
            created.append(baseline)

        run.status = RunStatus.SUCCEEDED
        run.ended_at = datetime.now(UTC)
        await self._audit(
            session,
            action=AuditAction.RUN_COMPLETED,
            actor=actor,
            run_id=run.id,
            scenario_id=scenario.id,
            details={"snapshot_baseline": snapshot_name, "asset_count": len(created)},
        )
        await session.commit()
        return created

    async def _baseline_for_asset(
        self, session: AsyncSession, asset: models.Asset
    ) -> models.SnapshotBaseline | None:
        if asset.pve_vmid is None or not asset.pve_node:
            return None
        return (
            await session.execute(
                select(models.SnapshotBaseline).where(
                    models.SnapshotBaseline.pve_vmid == asset.pve_vmid,
                    models.SnapshotBaseline.pve_node == asset.pve_node,
                    models.SnapshotBaseline.status == "ready",
                )
            )
        ).scalar_one_or_none()

    async def _reapply_baseline_name(
        self,
        session: AsyncSession,
        asset: models.Asset,
        baseline: models.SnapshotBaseline,
    ) -> None:
        """Snapshot rollback restores the old PVE name; apply the scenario name again."""
        scenario = await session.get(models.Scenario, baseline.scenario_id)
        if scenario is None:
            return
        document = scenario.spec if isinstance(scenario.spec, dict) else {}
        spec = instance_spec(document.get("spec") or document, baseline.instance)
        base_role = re.sub(r"_\d+$", "", asset.role)
        asset_spec = next(
            (row for row in spec.get("assets", []) if row.get("role") == base_role),
            None,
        )
        short_name = _vm_name(asset_spec, asset.role) if asset_spec else None
        if short_name:
            try:
                await self._adapter.set_vm_name(baseline.pve_vmid, baseline.pve_node, short_name)
            except Exception as exc:  # Display name must not block cleanup.
                log.warning(
                    "runner.baseline.rename_failed vmid=%s name=%s error=%s",
                    baseline.pve_vmid,
                    short_name,
                    exc,
                )

    async def _restore_baseline_asset(
        self,
        *,
        session: AsyncSession,
        asset: models.Asset,
        asset_spec: dict,
        baseline: models.SnapshotBaseline,
        actor: str | None,
    ) -> None:
        """Restore one persistent VM to its clean snapshot and boot it."""
        async with self._pve_lifecycle_section(
            "baseline-restore", run_id=asset.run_id, role=asset.role, vmid=baseline.pve_vmid
        ):
            await self._adapter.stop_vm(baseline.pve_vmid, baseline.pve_node, force=True)
            if baseline.snapshot_name != _PERSISTENT_APPLIANCE_BASELINE:
                await self._adapter.restore_vm_snapshot(
                    baseline.pve_vmid, baseline.pve_node, baseline.snapshot_name
                )
            short_name = _vm_name(asset_spec, asset.role)
            if short_name:
                try:
                    await self._adapter.set_vm_name(
                        baseline.pve_vmid, baseline.pve_node, short_name
                    )
                except Exception as exc:  # Cosmetic name must not prevent range recovery.
                    log.warning(
                        "runner.baseline.rename_failed vmid=%s name=%s error=%s",
                        baseline.pve_vmid,
                        short_name,
                        exc,
                    )
            await self._adapter.start_vm(baseline.pve_vmid, baseline.pve_node)
            restore_commands = asset_spec.get("restore_commands") or []
            if restore_commands:
                await self._adapter.apply_guest_seed(
                    baseline.pve_vmid,
                    baseline.pve_node,
                    SeedSpec(role=asset.role, runcmd=list(restore_commands)),
                )
            state = await self._adapter.get_vm_state(baseline.pve_vmid, baseline.pve_node)
        asset.pve_vmid = baseline.pve_vmid
        asset.pve_node = baseline.pve_node
        asset.pve_ip = state.ip
        asset.status = AssetStatus.RUNNING if state.status == "running" else AssetStatus.STOPPED
        await session.flush()
        await self._audit(
            session,
            action=AuditAction.ASSET_SPAWNED,
            actor=actor,
            run_id=asset.run_id,
            asset_id=asset.id,
            details={
                "role": asset.role,
                "vmid": baseline.pve_vmid,
                "restored_snapshot": baseline.snapshot_name,
            },
        )
        await session.commit()
