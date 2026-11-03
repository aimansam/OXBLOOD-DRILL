"""Run a Scenario end-to-end against a ProxmoxAdapter.

This is the orchestrator. It owns the run lifecycle:

  pending -> running -> succeeded
                       \\-> failed
                       \\-> timeout (caller-imposed)
                       \\-> cancelled

The runner is **strict**: disposable assets are cloned, started, and
destroyed on teardown; scenarios with complete snapshot baselines restore
their persistent VM IDs instead, then reset them to the clean snapshot on
teardown.

Concurrency model: assets are spawned sequentially for now. PVE clone
is fast but template-disk-bound; parallel clone is a future
optimisation.

Failure handling: any exception during clone or start transitions the
run to FAILED and best-effort tears down what was already created.
The error is recorded on `Run.error` and in the audit log.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import models
from app.db.models import AssetStatus, AuditAction, RunStatus, TelemetrySeverity
from app.observability import (
    inc_run_started,
    inc_run_terminal,
    record_cancel,
)
from app.runners.adapter import NetworkSpec, ProxmoxAdapter
from app.runners.runner_assets import AssetSeedingMixin

# Re-exported (``as`` form) so existing ``from app.runners.runner import ...`` callers keep working.
from app.runners.runner_base import (
    _PERSISTENT_APPLIANCE_BASELINE as _PERSISTENT_APPLIANCE_BASELINE,
)
from app.runners.runner_base import (
    RunnerError as RunnerError,
)
from app.runners.runner_base import (
    _adapter_label as _adapter_label,
)
from app.runners.runner_base import (
    _sessionmaker as _sessionmaker,
)
from app.runners.runner_base import (
    _static_ip_configs as _static_ip_configs,
)
from app.runners.runner_base import (
    _vm_name as _vm_name,
)
from app.runners.runner_base import instance_spec
from app.runners.runner_baselines import BaselineMixin
from app.runners.runner_watchdog import WatchdogMixin
from app.services import telemetry as _telemetry
from app.services.event_recorder import record_event as _record_event
from app.services.pve_bridges import BridgePlanError, plan_bridges_from_db

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class RunRequest:
    """Inputs to start a new Run."""

    scenario_id: int
    started_by: str | None = None
    # Optional override; defaults to first node returned by the adapter.
    node: str | None = None
    # F6: optional exercise + team binding.
    exercise_id: int | None = None
    team: str | None = None
    # F7: optional template this run is spawned from. The runner
    # uses the template's ``snapshot`` to pre-stage assets / flags
    # rather than re-deriving them from the live scenario row
    # (handy for replaying a frozen state).
    template_id: int | None = None
    # Optional drill-level lifecycle limit. When omitted, the scenario's
    # declared duration is used before falling back to the legacy setting.
    timeout_min: int | None = None
    cancel_event: asyncio.Event | None = None
    # Range copy number: 1 is the scenario as declared; 2, 3, ... run beside it (match copies).
    instance: int = 1


@dataclass(frozen=True)
class RunResult:
    """Return value of `start_run` for the API layer."""

    run_id: int
    status: RunStatus


class Runner(AssetSeedingMixin, BaselineMixin, WatchdogMixin):
    """Orchestrates one run at a time."""

    # --- public API ------------------------------------------------------

    async def start_run(self, req: RunRequest, session: AsyncSession) -> RunResult:
        """Create Run row, clone + start each asset, flip to SUCCEEDED.

        Returns the new run id. The returned Run is committed (i.e. you
        can read it from a fresh session).
        """
        scenario = (
            await session.execute(
                select(models.Scenario).where(models.Scenario.id == req.scenario_id)
            )
        ).scalar_one_or_none()
        if scenario is None:
            raise RunnerError(f"scenario id={req.scenario_id} not found")

        # F7: if template_id is provided, use the template's snapshot
        # instead of the scenario's live spec. This lets operators
        # replay a frozen state (assets, flags, networks) rather than
        # re-deriving from the scenario YAML.
        if req.template_id is not None:
            template = (
                await session.execute(
                    select(models.Template).where(models.Template.id == req.template_id)
                )
            ).scalar_one_or_none()
            if template is None:
                raise RunnerError(f"template id={req.template_id} not found")
            snapshot = template.snapshot or {}
            assets_spec = snapshot.get("assets") or []
            if not assets_spec:
                raise RunnerError("template snapshot has no assets")
            # Use snapshot networks if present, otherwise fall back to scenario
            networks_spec_from_snapshot = snapshot.get("networks")
            log.info(
                "runner.template.snapshot_used template_id=%s assets=%s",
                req.template_id,
                len(assets_spec),
            )
        else:
            snapshot = {}
            assets_spec = []

        # Load scenario spec for networks/flags if not overridden by template
        spec = instance_spec(scenario.spec.get("spec") or scenario.spec, req.instance)
        if not assets_spec:
            assets_spec = spec.get("assets") or []
        if not assets_spec:
            raise RunnerError("scenario has no assets")

        expected_roles: list[str] = []
        for asset_spec in assets_spec:
            count = max(1, min(int(asset_spec.get("count") or 1), 64))
            base_role = str(asset_spec["role"])
            expected_roles.extend(
                f"{base_role}_{index + 1}" if count > 1 else base_role for index in range(count)
            )
        baseline_by_role: dict[str, models.SnapshotBaseline] = {}
        if req.template_id is None:
            baseline_rows = (
                (
                    await session.execute(
                        select(models.SnapshotBaseline).where(
                            models.SnapshotBaseline.scenario_id == scenario.id,
                            models.SnapshotBaseline.scenario_version == scenario.version,
                            models.SnapshotBaseline.instance == req.instance,
                            models.SnapshotBaseline.status == "ready",
                        )
                    )
                )
                .scalars()
                .all()
            )
            baseline_by_role = {baseline.role: baseline for baseline in baseline_rows}
        snapshot_mode = bool(baseline_by_role) and all(
            role in baseline_by_role for role in expected_roles
        )

        # Pick node before validating node-scoped networking so bridge
        # checks target the same PVE node that will receive the clones.
        nodes = await self._adapter.list_nodes()
        if not nodes:
            raise RunnerError("adapter reports zero PVE nodes")
        node = req.node or getattr(self._adapter, "_node", None) or nodes[0]
        if req.node is not None and req.node not in nodes:
            raise RunnerError(
                f"requested PVE node {req.node!r} is not available "
                f"(available nodes: {', '.join(nodes)})"
            )
        if hasattr(self._adapter, "set_node"):
            self._adapter.set_node(node)  # type: ignore[attr-defined]
        elif hasattr(self._adapter, "_node"):
            self._adapter._node = node  # type: ignore[attr-defined]

        preflight_spec = {**spec, "assets": assets_spec}
        if req.template_id is not None and networks_spec_from_snapshot is not None:
            preflight_spec["networks"] = networks_spec_from_snapshot
        if snapshot_mode:
            preflight_spec["provisioning"] = {"mode": "snapshot"}
        checks = await self._adapter.preflight(preflight_spec, node)
        failed = [check["detail"] for check in checks if not check["ready"]]
        if failed:
            raise RunnerError("Range preflight failed: " + "; ".join(failed))

        # Build the network plan from spec.networks[]. VLAN scenarios use
        # one shared VLAN-aware bridge; legacy scenarios retain the old
        # per-network bridge path for compatibility.
        # F7: use template snapshot networks if available
        if req.template_id is not None and networks_spec_from_snapshot is not None:
            networks_spec = networks_spec_from_snapshot
        else:
            networks_spec = spec.get("networks") or []
        bridges_by_name: dict[str, str] = {}
        vlan_by_name: dict[str, int | None] = {}
        declared_network_names = {
            str(net_spec.get("name", "")).strip()
            for net_spec in networks_spec
            if str(net_spec.get("name", "")).strip()
        }
        for asset_spec in assets_spec:
            for net_name in asset_spec.get("networks") or []:
                if net_name not in declared_network_names:
                    raise RunnerError(
                        f"asset {asset_spec.get('role')!r} references unknown network {net_name!r}"
                    )

        vlan_mode = bool(networks_spec) and any(
            net_spec.get("vlan_id") is not None for net_spec in networks_spec
        )
        if vlan_mode and any(net_spec.get("vlan_id") is None for net_spec in networks_spec):
            raise RunnerError("VLAN mode requires vlan_id on every scenario network")

        if networks_spec and vlan_mode:
            # vmbr200 is operator-owned shared infrastructure. It is
            # intentionally excluded from per-run bridge cleanup.
            shared_bridge = "vmbr200"
            await self._adapter.create_bridge(NetworkSpec(bridge=shared_bridge))
            for net_spec in networks_spec:
                net_name = str(net_spec.get("name", "")).strip()
                vlan_id = int(net_spec["vlan_id"])
                if not 1 <= vlan_id <= 4094:
                    raise RunnerError(f"network {net_name!r} has invalid vlan_id {vlan_id}")
                bridges_by_name[net_name] = shared_bridge
                vlan_by_name[net_name] = vlan_id
        elif networks_spec:
            try:
                bridge_plan = await plan_bridges_from_db(session)
            except BridgePlanError as exc:
                raise RunnerError(f"bridge plan invalid: {exc}") from exc
            if bridge_plan.conflicts:
                raise RunnerError("bridge plan conflicts: " + "; ".join(bridge_plan.conflicts))

            planned_for_scenario = {
                bridge.network: bridge
                for bridge in bridge_plan.bridges
                if bridge.scenario == scenario.name
            }

            for net_spec in networks_spec:
                net_name = str(net_spec.get("name", "")).strip()
                planned_bridge = planned_for_scenario.get(net_name)
                if planned_bridge is None:
                    raise RunnerError(
                        f"network {net_name!r} has no planned bridge; check the "
                        "scenario CIDR and Setup -> Scenarios & Networks"
                    )
                bridge = planned_bridge.name
                bridges_by_name[net_name] = bridge
                vlan_by_name[net_name] = None
                await self._adapter.create_bridge(
                    NetworkSpec(
                        bridge=bridge,
                        cidr=net_spec.get("cidr", ""),
                        isolation=net_spec.get("isolation", "tight"),
                        egress=net_spec.get("egress", "blocked"),
                        dhcp=net_spec.get("dhcp", True),
                    )
                )
                log.info(
                    "runner.networks.bridge_created name=%s bridge=%s cidr=%s",
                    net_spec["name"],
                    bridge,
                    net_spec.get("cidr"),
                )

        # 1. Create Run (pending) + Asset (planned) rows.
        # F6 + F7: propagate exercise_id + team + template_id.
        run = models.Run(
            scenario_id=scenario.id,
            status=RunStatus.PENDING,
            started_by=req.started_by,
            exercise_id=req.exercise_id,
            team=req.team,
            template_id=req.template_id,
            timeout_min=self._resolve_timeout_min(req.timeout_min, scenario.duration_min),
        )
        session.add(run)
        await session.flush()
        # Scenario commands can reference {{domain_password}}. Keep the
        # generated credential in memory for this drill only.
        # Keep the lab-only Windows bootstrap secret compatible with both
        # ``net user`` and AD DS Safe Mode validation.  A bare URL-safe token
        # can lack the character classes Windows requires for an administrator
        # password, which makes promotion fail with an unhelpful "blank"
        # password diagnostic.
        self._windows_setup_secrets[run.id] = f"D1videLab-{secrets.token_urlsafe(18)}!"
        # F8: emit run.started event.
        await _record_event(
            session,
            run_id=run.id,
            kind="run.started",
            source="runner",
            severity=TelemetrySeverity.INFO,
            payload={
                "scenario_id": scenario.id,
                "scenario_name": scenario.name,
                "started_by": req.started_by,
                "exercise_id": req.exercise_id,
                "team": req.team,
                "template_id": req.template_id,
            },
        )

        # F3 follow-up: honor ``spec.assets[].count`` so a single
        # declared asset can spawn multiple clones (e.g.
        # ``victim_workstation count: 2`` -> two VM rows). The
        # generated ``role`` for instance N is
        # ``<declared_role>_<N>`` (1-indexed); single-count assets
        # keep the declared role verbatim (no suffix).
        asset_count_total = 0
        for asset_spec in assets_spec:
            count = int(asset_spec.get("count") or 1)
            count = max(1, min(count, 64))  # schema already enforces; clamp defensively
            base_role = asset_spec["role"]
            for instance in range(count) if count > 1 else [0]:
                # Use _N suffix only when count > 1; instance 0 means
                # "single, use declared role verbatim".
                role = f"{base_role}_{instance + 1}" if count > 1 else base_role
                session.add(
                    models.Asset(
                        run_id=run.id,
                        role=role,
                        kind=asset_spec.get("kind", "vm"),
                        template=asset_spec["template"],
                        status=AssetStatus.PLANNED,
                    )
                )
                asset_count_total += 1
        await session.flush()

        await self._audit(
            session,
            action=AuditAction.RUN_STARTED,
            actor=req.started_by,
            run_id=run.id,
            scenario_id=scenario.id,
            details={"node": node, "asset_count": len(assets_spec)},
        )

        # 2. Transition to RUNNING.
        run.status = RunStatus.RUNNING
        run.started_at = datetime.now(UTC)
        await session.flush()
        # Publish the run and planned assets before the first clone so the
        # operator UI can discover the live run while provisioning is active.
        await session.commit()
        inc_run_started(adapter=_adapter_label(self._adapter))

        # 2b. Schedule the watchdog (L2 2.8). A drill's explicit time limit
        # wins, followed by the scenario duration. The old global setting is
        # only a fallback for legacy callers that do not provide either.
        watchdog_timeout_min = run.timeout_min
        self._schedule_watchdog(
            run.id,
            node,
            len(assets_spec),
            timeout_min=watchdog_timeout_min,
        )

        # 3. Clone + start each asset. On error, mark run FAILED and tear
        #    down whatever was already created.
        cloned_so_far: list[models.Asset] = []
        # Bridges we created during this run; tracked so teardown
        # (best-effort) can ask the adapter to remove them.
        bridges_created: list[str] = [] if vlan_mode else list(bridges_by_name.values())
        # Spawn one clone per generated row. The role of each row
        # is either the declared role (count == 1) or
        # ``<declared>_<N>`` (count > 1, N is 1-indexed). The
        # _spawn_asset method receives both the asset row and the
        # original asset_spec so it knows the declaring YAML.
        for asset_spec in assets_spec:
            count = int(asset_spec.get("count") or 1)
            base_role = asset_spec["role"]
            for instance_idx in range(count) if count > 1 else [0]:
                instance_role = f"{base_role}_{instance_idx + 1}" if count > 1 else base_role
                asset = (
                    await session.execute(
                        select(models.Asset)
                        .where(models.Asset.run_id == run.id)
                        .where(models.Asset.role == instance_role)
                    )
                ).scalar_one()
                try:
                    # F3: stash bridges_by_name on the asset so _spawn_asset
                    # can read it (no method-signature change). The asset is
                    # a SQLAlchemy instance; attaching ad-hoc attributes is
                    # safe because we drop it on session.flush boundaries.
                    asset._f3_bridges_by_name = bridges_by_name  # type: ignore[attr-defined]
                    asset._f3_vlan_by_name = vlan_by_name  # type: ignore[attr-defined]
                    # F6: stash exercise + team attrs for the spawner log.
                    asset._f6_exercise_id = req.exercise_id  # type: ignore[attr-defined]
                    asset._f6_team = req.team  # type: ignore[attr-defined]
                    asset._divide_scenario_spec = spec  # type: ignore[attr-defined]
                    baseline = baseline_by_role.get(asset.role)
                    if baseline is not None:
                        await self._restore_baseline_asset(
                            session=session,
                            asset=asset,
                            asset_spec=asset_spec,
                            baseline=baseline,
                            actor=req.started_by,
                        )
                    else:
                        await self._spawn_asset(
                            session=session,
                            asset=asset,
                            asset_spec=asset_spec,
                            node=node,
                            actor=req.started_by,
                        )
                    # F8: emit asset.running (after spawn + boot).
                    await _record_event(
                        session,
                        run_id=run.id,
                        asset_id=asset.id,
                        kind="asset.running",
                        source="runner",
                        severity=TelemetrySeverity.INFO,
                        payload={
                            "role": asset.role,
                            "kind": asset.kind,
                            "template": asset.template,
                            "pve_vmid": asset.pve_vmid,
                        },
                    )
                    cloned_so_far.append(asset)
                    if req.cancel_event is not None and req.cancel_event.is_set():
                        cancelled = await self._cancel_run_impl(
                            run.id,
                            "Provisioning cancelled by drill cleanup",
                            req.started_by,
                            session,
                        )
                        self._windows_setup_secrets.pop(run.id, None)
                        return RunResult(run_id=run.id, status=cancelled.status)
                except Exception as spawn_exc:
                    run.status = RunStatus.FAILED
                    run.ended_at = datetime.now(UTC)
                    vmid_text = f" vmid={asset.pve_vmid}" if asset.pve_vmid is not None else ""
                    run.error = (
                        f"{type(spawn_exc).__name__} while provisioning "
                        f"{asset.role}{vmid_text}: {spawn_exc}"
                    )
                    asset.status = AssetStatus.FAILED
                    asset.error = str(spawn_exc)
                    teardown_assets = list(cloned_so_far)
                    if asset.pve_vmid is not None and asset not in teardown_assets:
                        teardown_assets.append(asset)
                    await self._best_effort_teardown(session, teardown_assets)
                    # Tear down bridges we created so a retry starts
                    # clean. Best-effort: a real-PVE bridge is
                    # operator-owned and remove_bridge is a no-op;
                    # the mock removes them.
                    for br in bridges_created:
                        try:
                            await self._adapter.remove_bridge(br)
                        except Exception as bridge_exc:  # noqa: BLE001
                            log.warning(
                                "runner.networks.remove_bridge_failed bridge=%s err=%s",
                                br,
                                bridge_exc,
                            )
                    inc_run_terminal(outcome="failed", adapter=_adapter_label(self._adapter))
                    await self._audit(
                        session,
                        action=AuditAction.RUN_FAILED,
                        actor=req.started_by,
                        run_id=run.id,
                        scenario_id=scenario.id,
                        details={
                            "error": str(spawn_exc),
                            "role": asset.role,
                            "pve_vmid": asset.pve_vmid,
                        },
                    )
                    await session.commit()
                    self._windows_setup_secrets.pop(run.id, None)
                    raise

        # 4. F5: plant flags declared in spec.flags[]. Each flag
        # has a planted_on_role; for F5.2 we record the planting
        # intent (audit row + run-level metadata) so the operator
        # sees the chain. The actual filesystem write is done via
        # cloud-init user_data on the target asset; that comes
        # for free when scenarios author a user_data snippet
        # referencing spec.flags[].id. See README.md §5 §3
        # for the user_data recipe.
        # F7: use template snapshot flags if available
        if req.template_id is not None and snapshot.get("flags") is not None:
            flags_spec = snapshot.get("flags") or []
        else:
            flags_spec = spec.get("flags") or []
        planted_count = 0
        for flag_spec in flags_spec:
            planted_role = flag_spec.get("planted_on_role")
            if not planted_role:
                continue
            # Find the matching asset(s) so the audit row can
            # link to the asset_id when the planting intent is
            # associated with a specific cloned VM.
            asset_link = None
            for asset in cloned_so_far:
                if asset.role == planted_role and asset.pve_vmid:
                    asset_link = asset.id
                    break
            await self._audit(
                session,
                action=AuditAction.FLAG_PLANTED,
                actor=req.started_by,
                run_id=run.id,
                asset_id=asset_link,
                details={
                    "flag_id": flag_spec.get("id"),
                    "side": flag_spec.get("side"),
                    "planted_on_role": planted_role,
                    "base_points": flag_spec.get("base_points"),
                    "decay_window_seconds": flag_spec.get("decay_window_seconds"),
                    # Do NOT log the value; the API surfaces the
                    # value to authenticated clients only.
                    "value_present": bool(flag_spec.get("value")),
                },
            )
            planted_count += 1
        if flags_spec:
            log.info(
                "runner.flags.planted run_id=%s planted=%s declared=%s",
                run.id,
                planted_count,
                len(flags_spec),
            )

        # 5. All assets up — keep run in RUNNING state.
        # The watchdog will timeout after drill_timeout_min, or the user
        # can manually stop/cancel the drill.
        # Bridges stay active for the duration of the drill.
        # They will be cleaned up by:
        # 1. Watchdog timeout (fires after drill_timeout_min)
        # 2. Manual stop/cancel by user
        # 3. Failure path above (already handled)
        # Run stays in RUNNING state until watchdog timeout or manual stop.
        # No RUN_COMPLETED audit here — that fires when the watchdog
        # or operator actually stops the drill.

        await session.commit()

        # Telemetry (L2 2.11). Build sinks from the scenario spec and
        # fire-and-forget dispatch. Telemetry is best-effort — failures
        # never propagate; ``dispatch`` swallows them.
        sinks = _telemetry.build_sinks_from_spec(scenario.spec)
        await _telemetry.dispatch(
            sinks,
            {
                "type": "run.started",
                "run_id": run.id,
                "scenario_id": scenario.id,
                "started_by": run.started_by,
                "started_at": run.started_at.isoformat() if run.started_at else None,
                "asset_count": len(assets_spec),
            },
        )

        self._windows_setup_secrets.pop(run.id, None)
        return RunResult(run_id=run.id, status=run.status)

    async def stop_run(
        self,
        run_id: int,
        reason: str = "user-requested",
        session: AsyncSession | None = None,
        actor: str | None = None,
    ) -> models.Run:
        """Stop every asset in a run and destroy them. Idempotent.

        Sets ``Run.status = SUCCEEDED`` (operator-initiated "the drill is
        done — clean up"). For trainee-initiated aborts use
        :meth:`cancel_run`, which sets ``CANCELLED`` instead.

        Pass `session` to participate in a caller's transaction; if None,
        the runner owns the session lifecycle via the global sessionmaker.
        """
        if session is not None:
            return await self._stop_run_impl(run_id, reason, actor, session)
        sm = _sessionmaker()
        async with sm() as session:
            return await self._stop_run_impl(run_id, reason, actor, session)

    async def cancel_run(
        self,
        run_id: int,
        reason: str = "user-requested",
        session: AsyncSession | None = None,
        actor: str | None = None,
    ) -> models.Run:
        """Abort a running drill. Symmetric with :meth:`stop_run`.

        Behaviour:
          * Validates the run exists and is in a non-terminal state
            (``PENDING`` or ``RUNNING``). If already terminal, raises
            :class:`RunnerError` (the router maps to 409 Conflict).
          * Stops and destroys every asset that was spawned (best-effort,
            matching the spawn failure path).
          * Sets ``Run.status = CANCELLED``, ``ended_at = now``,
            ``error = reason`` (so the audit + UI can show why).
          * Writes an audit ``RUN_CANCELLED`` entry with the reason +
            actor in details.

        Idempotent on the adapter side (destroy is 404-tolerant), but the
        DB transition is not — a second cancel on an already-cancelled
        run raises.
        """
        if session is not None:
            return await self._cancel_run_impl(run_id, reason, actor, session)
        sm = _sessionmaker()
        async with sm() as session:
            return await self._cancel_run_impl(run_id, reason, actor, session)

    async def _stop_run_impl(
        self,
        run_id: int,
        reason: str,
        actor: str | None,
        session: AsyncSession,
    ) -> models.Run:
        run = (
            await session.execute(select(models.Run).where(models.Run.id == run_id))
        ).scalar_one_or_none()
        if run is None:
            raise RunnerError(f"run id={run_id} not found")
        # Q23-B1: refuse to write a duplicate RUN_STOPPED audit row
        # for an already-terminal run. Pre-B1, double-clicking Stop
        # (or stopping an already-stopped run via API) flipped the
        # row to SUCCEEDED again and stacked audit rows -- making
        # "how many times was this stopped?" unanswerable. We still
        # return the run row so the caller gets a 200, but no DB
        # mutation occurs.
        terminal_run = run.status in (
            RunStatus.SUCCEEDED,
            RunStatus.FAILED,
            RunStatus.CANCELLED,
            RunStatus.TIMEOUT,
        )
        assets = (
            (await session.execute(select(models.Asset).where(models.Asset.run_id == run_id)))
            .scalars()
            .all()
        )

        for asset in assets:
            if asset.pve_vmid is not None and asset.pve_node:
                async with self._pve_lifecycle_section(
                    "stop", run_id=asset.run_id, role=asset.role, vmid=asset.pve_vmid
                ):
                    try:
                        await self._adapter.stop_vm(asset.pve_vmid, asset.pve_node)
                        asset.status = AssetStatus.STOPPED
                    except Exception as exc:
                        asset.status = AssetStatus.FAILED
                        asset.error = f"stop failed: {exc}"
                    try:
                        baseline = await self._baseline_for_asset(session, asset)
                        if baseline is not None:
                            if baseline.snapshot_name != _PERSISTENT_APPLIANCE_BASELINE:
                                await self._adapter.restore_vm_snapshot(
                                    asset.pve_vmid, asset.pve_node, baseline.snapshot_name
                                )
                            await self._reapply_baseline_name(session, asset, baseline)
                        else:
                            await self._adapter.destroy_vm(asset.pve_vmid, asset.pve_node)
                        # Q17: explicit success marker. Previously the
                        # code only set ORPHANED on failure; if the
                        # destroy succeeded but stop failed earlier,
                        # the asset could end up FAILED. Be explicit.
                        if asset.status != AssetStatus.FAILED:
                            asset.status = AssetStatus.STOPPED
                        asset.cleaned_at = datetime.now(UTC)
                    except Exception:
                        asset.status = AssetStatus.ORPHANED
            else:
                asset.status = AssetStatus.STOPPED

        if terminal_run:
            await session.commit()
            await session.refresh(run, attribute_names=["assets"])
            self._windows_setup_secrets.pop(run.id, None)
            return run

        run.status = RunStatus.SUCCEEDED
        run.ended_at = datetime.now(UTC)
        inc_run_terminal(outcome="succeeded", adapter=_adapter_label(self._adapter))
        # Q17: distinguish operator-initiated stop from trainee
        # cancel. ``/stop`` writes RUN_STOPPED; ``/cancel`` still
        # writes RUN_CANCELLED. Audit log readers can now answer
        # "did the operator stop this, or did the trainee cancel?"
        # without diffing the reason text.
        await self._audit(
            session,
            action=AuditAction.RUN_STOPPED,
            actor=actor,
            run_id=run.id,
            details={"reason": reason},
        )
        # A started drill stays RUNNING, so the SOC feed's terminal event
        # is emitted here, when the operator (or watchdog) ends it.
        await _record_event(
            session,
            run_id=run.id,
            kind="run.completed",
            source="runner",
            severity=TelemetrySeverity.INFO,
            payload={"reason": reason, "stopped_by": actor, "outcome": "succeeded"},
        )
        await session.commit()
        await session.refresh(run, attribute_names=["assets"])
        scenario = await session.get(models.Scenario, run.scenario_id)
        if scenario is not None:
            await _telemetry.dispatch(
                _telemetry.build_sinks_from_spec(scenario.spec),
                {
                    "type": "run.completed",
                    "run_id": run.id,
                    "scenario_id": scenario.id,
                    "started_by": run.started_by,
                    "started_at": run.started_at.isoformat() if run.started_at else None,
                    "ended_at": run.ended_at.isoformat() if run.ended_at else None,
                    "duration_sec": run.duration_sec,
                    "asset_count": len(assets),
                    "reason": reason,
                },
            )
        self._windows_setup_secrets.pop(run.id, None)
        return run

    async def _cancel_run_impl(
        self,
        run_id: int,
        reason: str,
        actor: str | None,
        session: AsyncSession,
    ) -> models.Run:
        run = (
            await session.execute(select(models.Run).where(models.Run.id == run_id))
        ).scalar_one_or_none()
        if run is None:
            raise RunnerError(f"run id={run_id} not found")
        if run.status not in (RunStatus.PENDING, RunStatus.RUNNING):
            raise RunnerError(
                f"run id={run_id} is in terminal state {run.status.value!r}; cannot cancel"
            )

        assets = (
            (await session.execute(select(models.Asset).where(models.Asset.run_id == run_id)))
            .scalars()
            .all()
        )

        # Best-effort teardown — never raise from here; we want the run
        # row + audit entry to land even if the adapter is half-broken.
        for asset in assets:
            if asset.pve_vmid is not None and asset.pve_node:
                async with self._pve_lifecycle_section(
                    "cancel", run_id=asset.run_id, role=asset.role, vmid=asset.pve_vmid
                ):
                    try:
                        await self._adapter.stop_vm(asset.pve_vmid, asset.pve_node, force=True)
                    except Exception as exc:  # noqa: BLE001
                        asset.status = AssetStatus.ORPHANED
                        asset.error = f"stop failed during cancel: {exc}"
                        continue
                    try:
                        baseline = await self._baseline_for_asset(session, asset)
                        if baseline is not None:
                            if baseline.snapshot_name != _PERSISTENT_APPLIANCE_BASELINE:
                                await self._adapter.restore_vm_snapshot(
                                    asset.pve_vmid, asset.pve_node, baseline.snapshot_name
                                )
                            await self._reapply_baseline_name(session, asset, baseline)
                        else:
                            await self._adapter.destroy_vm(asset.pve_vmid, asset.pve_node)
                    except Exception as exc:  # noqa: BLE001
                        asset.status = AssetStatus.ORPHANED
                        asset.error = f"destroy failed during cancel: {exc}"
                        continue
                asset.status = AssetStatus.STOPPED
                asset.cleaned_at = datetime.now(UTC)
            else:
                # Asset never got as far as cloning — mark stopped so the
                # UI shows the row in a sensible state.
                asset.status = AssetStatus.STOPPED

        run.status = RunStatus.CANCELLED
        run.ended_at = datetime.now(UTC)
        run.error = reason
        inc_run_terminal(outcome="cancelled", adapter=_adapter_label(self._adapter))
        record_cancel(result="ok")
        await self._audit(
            session,
            action=AuditAction.RUN_CANCELLED,
            actor=actor,
            run_id=run.id,
            details={"reason": reason, "actor": actor},
        )
        await session.commit()
        await session.refresh(run, attribute_names=["assets"])
        self._windows_setup_secrets.pop(run.id, None)
        return run

    # --- internals -------------------------------------------------------

    async def _best_effort_teardown(
        self, session: AsyncSession, assets: list[models.Asset]
    ) -> None:
        for a in assets:
            if a.pve_vmid is None or not a.pve_node:
                continue
            try:
                async with self._pve_lifecycle_section(
                    "teardown", run_id=a.run_id, role=a.role, vmid=a.pve_vmid
                ):
                    await self._adapter.stop_vm(a.pve_vmid, a.pve_node, force=True)
                    baseline = await self._baseline_for_asset(session, a)
                    if baseline is not None:
                        if baseline.snapshot_name != _PERSISTENT_APPLIANCE_BASELINE:
                            await self._adapter.restore_vm_snapshot(
                                a.pve_vmid, a.pve_node, baseline.snapshot_name
                            )
                        await self._reapply_baseline_name(session, a, baseline)
                    else:
                        await self._adapter.destroy_vm(a.pve_vmid, a.pve_node)
                a.status = AssetStatus.STOPPED
                a.cleaned_at = datetime.now(UTC)
            except Exception as exc:  # noqa: BLE001
                # Q17: surface the failure so the operator can
                # see why the VM is orphaned (previously the
                # error was swallowed with no log + no asset.error).
                log.warning(
                    "runner.assets.teardown_failed asset_id=%s vmid=%s err=%s",
                    a.id,
                    a.pve_vmid,
                    exc,
                )
                a.status = AssetStatus.ORPHANED
                a.error = f"teardown failed: {exc}"

    # --- watchdog (L2 2.8) --------------------------------------------


def _default_adapter() -> ProxmoxAdapter:
    """Pick the right adapter based on env.

    - If `PROXMOX_HOST` + `PROXMOX_TOKEN_ID` + `PROXMOX_TOKEN_SECRET` are
      all set, return a `RealProxmoxAdapter` against the live cluster.
    - Otherwise return `MockProxmoxAdapter` so dev/test/CLI keep working
      without a PVE token.

    This is the single decision point that swaps mock <-> real; the rest of
    the runner doesn't know which is in use.
    """
    from app.core.config import settings  # noqa: F811  (resolved at call time)
    from app.runners.mock_adapter import MockProxmoxAdapter
    from app.runners.real_adapter import RealProxmoxAdapter
    from app.services import proxmox as proxmox_svc

    if proxmox_svc._DB_OVERLAY is not None:
        try:
            return RealProxmoxAdapter.from_overlay(
                proxmox_svc._DB_OVERLAY,
                clone_storage=(
                    proxmox_svc._DB_OVERLAY.get("clone_storage") or settings.proxmox.clone_storage
                ),
                seed_snippet_storage=(
                    proxmox_svc._DB_OVERLAY.get("seed_snippet_storage")
                    or settings.proxmox.seed_snippet_storage
                ),
            )
        except Exception:  # noqa: BLE001
            import logging

            logging.getLogger(__name__).warning(
                "pve_config overlay present but invalid; using MockProxmoxAdapter",
                exc_info=True,
            )
            return MockProxmoxAdapter()

    p = settings.proxmox
    host = (p.host or "").strip()
    token_id = (p.token_id or "").strip()
    has_secret = p.token_secret is not None and bool(p.token_secret.get_secret_value())
    if host and token_id and has_secret:
        try:
            return RealProxmoxAdapter.from_settings(p)
        except Exception:  # noqa: BLE001
            # Bad config: fall back to mock so the API still boots, but log.
            import logging

            logging.getLogger(__name__).warning(
                "PROXMOX_* env present but invalid; using MockProxmoxAdapter",
                exc_info=True,
            )
    return MockProxmoxAdapter()


def build_runner() -> Runner:
    """Build a `Runner` with the default adapter selection.

    Convenience factory used by FastAPI dependency injection and the CLI
    smoke tool. Pass `Runner(adapter=...)` explicitly in tests so the
    mock stays in your control.
    """
    return Runner(adapter=_default_adapter())
