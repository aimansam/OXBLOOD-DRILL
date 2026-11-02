"""Snapshot-baseline promotion and restore for the run orchestrator."""

from __future__ import annotations

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
    _vm_name,
)

log = logging.getLogger("app.runners.runner")


class BaselineMixin(RunnerBase):
    """Snapshot-baseline promotion and restore for the run orchestrator."""

    async def promote_run_to_snapshot_baseline(
        self,
        run_id: int,
        session: AsyncSession,
        actor: str | None = None,
        snapshot_name: str = "clean-baseline",
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
                        models.SnapshotBaseline.scenario_id == scenario.id
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
        spec = document.get("spec") or document
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
