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
import ipaddress
import logging
import re
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.db import models
from app.db.models import AssetStatus, AuditAction, RunStatus, TelemetrySeverity
from app.observability import (
    inc_run_started,
    inc_run_terminal,
    record_cancel,
)
from app.runners.adapter import CloneSpec, NetworkSpec, ProxmoxAdapter, SeedSpec
from app.services import telemetry as _telemetry
from app.services.event_recorder import record_event as _record_event
from app.services.pve_bridges import BridgePlanError, plan_bridges_from_db

log = logging.getLogger(__name__)


def _vm_name(asset_spec: dict, role: str) -> str | None:
    """Return a stable PVE-safe short name, including counted VM instances."""
    stem = str(asset_spec.get("vm_name") or "").strip()
    if not stem:
        return None
    if int(asset_spec.get("count") or 1) > 1:
        match = re.search(r"_(\d+)$", role)
        if match:
            return f"{stem}{int(match.group(1)):02d}"
    return stem


def _static_ip_configs(asset: dict, scenario_spec: dict) -> dict[int, str]:
    """Build deterministic PVE cloud-init addresses for a scenario asset.

    The range is intentionally self-contained: the router owns the first
    usable address and guests receive stable addresses by role. This keeps a
    fresh lab usable before a DHCP service is installed on the router image.
    """
    networks = {
        str(net.get("name")): net
        for net in (scenario_spec.get("networks") or [])
        if isinstance(net, dict) and net.get("name") and net.get("cidr")
    }
    requested = [str(name) for name in (asset.get("networks") or [])]
    if not requested:
        return {}

    role = str(asset.get("role") or "asset")
    base_role = role.rsplit("_", 1)[0] if role.rsplit("_", 1)[-1].isdigit() else role
    template = str(asset.get("template") or "").lower()
    if (
        str(asset.get("network_mode") or "").lower() == "trunk"
        or "opnsense" in template
        # Windows templates use their declared setup phases to configure
        # networking. PVE cloud-init IP config can be re-applied at reboot
        # and undo that Windows-side state.
        or ("win" in template and not asset.get("cloudbase_init"))
    ):
        # OPNsense owns its VLAN interface addresses in its native config;
        # do not emit Linux cloud-init addresses for the trunk appliance.
        return {}
    host_by_role = {
        "red_workstation": 10,
        "red_attacker": 10,
        "red_staging": 20,
        "blue_workstation": 11,
        "web_gateway": 20,
        "file_server": 20,
        "backup_server": 20,
        "log_aggregator": 30,
        "dc01": 10,
        "dc02": 10,
    }
    host = host_by_role.get(base_role, 40)
    configs: dict[int, str] = {}
    for nic_index, network_name in enumerate(requested):
        net = networks.get(network_name)
        if not net:
            continue
        try:
            subnet = ipaddress.ip_network(str(net["cidr"]), strict=False)
            usable = list(subnet.hosts())
        except (ValueError, TypeError):
            continue
        if not usable:
            continue
        # ``hosts()`` starts at the first usable host (.1), so indexing it
        # directly by a host number turns host 10 into .11. Keep role
        # allocations expressed as ordinary last-octet host numbers.
        address = (
            usable[0]
            if base_role == "router_fw"
            else usable[min(max(0, host - 1), len(usable) - 1)]
        )
        configs[nic_index] = f"ip={address}/{subnet.prefixlen}"
        if base_role != "router_fw":
            configs[nic_index] += f",gw={usable[0]}"
    return configs


def _adapter_label(adapter: ProxmoxAdapter) -> str:
    """``real`` or ``mock`` — used as a Prometheus label so we can graph
    live vs test traffic without distinguishing class names."""
    cls = type(adapter).__name__
    if cls == "RealProxmoxAdapter":
        return "real"
    return "mock"


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


@dataclass(frozen=True)
class RunResult:
    """Return value of `start_run` for the API layer."""

    run_id: int
    status: RunStatus


class RunnerError(RuntimeError):
    """Raised when the runner cannot complete a phase. Always actionable."""


_PERSISTENT_APPLIANCE_BASELINE = "__persistent__"


class Runner:
    """Orchestrates one run at a time."""

    # Class-level dictionaries mapping run_id -> deadline (datetime UTC)
    # and run_id -> asyncio.Task (for in-flight watchdog tasks).
    _active_deadlines: dict[int, datetime] = {}
    _active_tasks: dict[int, asyncio.Task] = {}
    _pve_lifecycle_locks: dict[int, asyncio.Lock] = {}
    _windows_setup_secrets: dict[int, str] = {}

    def __init__(self, adapter: ProxmoxAdapter) -> None:
        self._adapter = adapter

    @classmethod
    def _pve_lifecycle_lock(cls) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        return cls._pve_lifecycle_locks.setdefault(id(loop), asyncio.Lock())

    @classmethod
    def pve_lifecycle_busy(cls) -> bool:
        return cls._pve_lifecycle_lock().locked()

    @asynccontextmanager
    async def _pve_lifecycle_section(self, action: str, **labels):
        lock = self._pve_lifecycle_lock()
        label_text = " ".join(f"{k}={v}" for k, v in labels.items() if v is not None)
        if lock.locked():
            log.info("runner.pve_lock.waiting action=%s %s", action, label_text)
        async with lock:
            log.info("runner.pve_lock.acquired action=%s %s", action, label_text)
            try:
                yield
            finally:
                log.info("runner.pve_lock.released action=%s %s", action, label_text)

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
        spec = scenario.spec.get("spec") or scenario.spec
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

    async def _spawn_asset(
        self,
        session: AsyncSession,
        asset: models.Asset,
        asset_spec: dict,
        node: str,
        actor: str | None = None,
    ) -> None:
        log.info(
            "runner.spawn_asset_start role=%s template=%s run_id=%s",
            asset.role,
            asset.template,
            asset.run_id,
        )

        async with self._pve_lifecycle_section("clone", run_id=asset.run_id, role=asset.role):
            template_vmid = await self._adapter.find_template(asset.template)
            if template_vmid is None:
                raise RunnerError(
                    f"template {asset.template!r} not found on PVE (role={asset.role!r})"
                )
            log.info(
                "runner.template_found role=%s template_vmid=%s",
                asset.role,
                template_vmid,
            )

            new_vmid = await self._adapter.allocate_vmid()
            log.info("runner.vmid_allocated role=%s new_vmid=%s", asset.role, new_vmid)

            resources = asset_spec.get("resources") or {}
            provisioning = (getattr(asset, "_divide_scenario_spec", {}) or {}).get(
                "provisioning", {}
            ) or {}
            linked_clone = provisioning.get("mode") == "linked_clone"
            # PVE 9 enforces strict DNS-1123 names on the clone VMID; underscores
            # in the role (e.g. ``drill_vm``) violate that. We strip them from
            # Keep the stable role in the DB while using the short name in PVE.
            role = asset.role
            sanitized_role = _vm_name(asset_spec, role) or role.replace("_", "")
            clone = CloneSpec(
                source_vmid=template_vmid,
                new_vmid=new_vmid,
                node=node,
                name=f"divide-{asset.run_id}-{sanitized_role}",
                template_name=asset.template,
                cores=resources.get("cores"),
                sockets=resources.get("sockets"),
                ram_mb=resources.get("ram_mb"),
                disk_gb=resources.get("disk_gb"),
                ip_configs=_static_ip_configs(
                    asset_spec, getattr(asset, "_divide_scenario_spec", {}) or {}
                ),
                full_clone=not linked_clone,
            )
            asset.status = AssetStatus.CLONING
            await session.flush()

            log.info("runner.cloning_vm role=%s new_vmid=%s", asset.role, new_vmid)
            result = await self._adapter.clone_vm(clone)
            asset.pve_vmid = result.vmid
            asset.pve_node = result.node
            asset.status = AssetStatus.BOOTING
            await session.flush()
            # Publish clone progress immediately. Provisioning can take
            # several minutes and the operator UI must not wait for the
            # entire run transaction to finish before seeing this VM.
            await session.commit()
            log.info("runner.clone_complete role=%s vmid=%s", asset.role, result.vmid)

        seed = self._build_seed_spec(
            asset=asset,
            asset_spec=asset_spec,
            scenario_spec=getattr(asset, "_divide_scenario_spec", {}) or {},
        )
        async with self._pve_lifecycle_section(
            "boot", run_id=asset.run_id, role=asset.role, vmid=result.vmid
        ):
            # F3 multi-VM scenarios: attach NICs before the first boot.
            # Cloud-init/Linux guests discover NICs during early boot; adding
            # scenario bridges after start can leave the guest without DHCP/IP
            # and makes the UI look like the VM failed to boot.
            await self._attach_asset_networks(
                asset=asset,
                asset_spec=asset_spec,
                bridges_by_name=asset._f3_bridges_by_name,  # type: ignore[attr-defined]
                node=node,
            )
            await session.flush()

            if seed is not None:
                log.info("runner.seeding_vm role=%s vmid=%s", asset.role, result.vmid)
                await self._adapter.seed_vm(result.vmid, result.node, seed)

            log.info("runner.starting_vm role=%s vmid=%s", asset.role, result.vmid)
            await self._adapter.start_vm(result.vmid, result.node)
            log.info("runner.vm_started role=%s vmid=%s", asset.role, result.vmid)

            if seed is not None:
                await self._adapter.apply_guest_seed(result.vmid, result.node, seed)

            windows_verify = (asset_spec.get("windows_setup") or {}).get("verify") or {}
            if windows_verify:
                await self._adapter.verify_windows_role(
                    result.vmid,
                    result.node,
                    expected_ip=str(windows_verify.get("ip") or ""),
                    domain=str(windows_verify.get("domain") or ""),
                    controller=str(windows_verify.get("controller") or "member"),
                )
                log.info(
                    "runner.windows_verified role=%s vmid=%s ip=%s domain=%s controller=%s",
                    asset.role,
                    result.vmid,
                    windows_verify.get("ip"),
                    windows_verify.get("domain"),
                    windows_verify.get("controller", "member"),
                )

            state = await self._adapter.get_vm_state(result.vmid, result.node)
            log.info(
                "runner.vm_state role=%s vmid=%s status=%s ip=%s",
                asset.role,
                result.vmid,
                state.status,
                state.ip,
            )

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
                "vmid": result.vmid,
                "ip": state.ip,
                "seeded": seed is not None,
                "seed_files": len((seed.files if seed else {}) or {}),
                "seed_commands": len((seed.runcmd if seed else []) or []),
            },
        )
        # Make the completed machine visible before the next asset starts.
        await session.commit()

    def _build_seed_spec(
        self,
        *,
        asset: models.Asset,
        asset_spec: dict,
        scenario_spec: dict,
    ) -> SeedSpec | None:
        template = str(asset_spec.get("template") or asset.template or "").lower()
        if str(asset_spec.get("network_mode") or "").lower() == "trunk" or "opnsense" in template:
            log.info(
                "runner.seed.skip_firewall_appliance role=%s template=%s",
                asset.role,
                asset_spec.get("template") or asset.template,
            )
            return None
        windows_setup = asset_spec.get("windows_setup") or {}
        if ("win" in template or "windows" in template) and not bool(
            asset_spec.get("cloudbase_init")
            or asset_spec.get("cloudinit")
            or windows_setup.get("commands")
            or windows_setup.get("phases")
        ):
            log.info(
                "runner.seed.skip_windows_template role=%s template=%s",
                asset.role,
                asset_spec.get("template") or asset.template,
            )
            return None

        role = str(asset.role or asset_spec.get("role") or "asset")
        base_role = str(asset_spec.get("role") or role)
        access = asset_spec.get("access") or {}
        if role.startswith("red") or base_role.startswith("red"):
            ciuser = str(access.get("user") or "red")
            cipassword = str(access.get("password") or "red-team")
        elif role.startswith("blue") or base_role.startswith("blue"):
            ciuser = str(access.get("user") or "blue")
            cipassword = str(access.get("password") or "blue-team")
        else:
            ciuser = str(access.get("user") or "divide")
            cipassword = str(access.get("password") or "divide")

        objectives = scenario_spec.get("objectives") or {}
        files: dict[str, str] = {
            "/opt/divide/role.txt": role + "\n",
            "/opt/divide/objectives-red.txt": "\n".join(objectives.get("red") or []) + "\n",
            "/opt/divide/objectives-blue.txt": "\n".join(objectives.get("blue") or []) + "\n",
        }

        matched_flags = []
        for flag in scenario_spec.get("flags") or []:
            planted = str(flag.get("planted_on_role") or "")
            if planted and (
                planted == role or planted == base_role or role.startswith(planted + "_")
            ):
                matched_flags.append(flag)

        for flag in matched_flags:
            flag_id = str(flag.get("id") or "flag")
            files[f"/opt/divide/flags/{flag_id}.txt"] = str(flag.get("value") or "") + "\n"

        # Compact ranges keep Blue-team evidence on the investigation
        # workstation instead of dedicating a separate log-aggregator VM.
        # The bundle is only written when Blue flags are intentionally
        # planted on that workstation, so other scenarios retain their
        # existing topology and evidence flow.
        if base_role == "blue_workstation" and any(
            str(flag.get("side") or "") == "blue" for flag in matched_flags
        ):
            files["/opt/divide/evidence/incident-timeline.log"] = (
                "2026-01-01T09:12:44Z red_vlan workstation initiated HTTPS to dmz_gateway\n"
                "2026-01-01T09:18:07Z dmz_gateway authenticated to dc01 over WinRM\n"
                "2026-01-01T09:26:31Z file_server recorded unusual archive access\n"
                "2026-01-01T09:31:52Z backup_server received a protected-path access attempt\n"
            )

        runcmd = [
            "mkdir -p /opt/divide/flags",
            "mkdir -p /opt/divide/evidence",
            "chmod -R 700 /opt/divide",
            "sysctl --system || true"
            if base_role == "router_fw" and "opnsense" not in template
            else "true",
        ]
        domain_password = self._windows_setup_secrets.setdefault(
            asset.run_id, f"D1videLab-{secrets.token_urlsafe(18)}!"
        )

        def render_windows_command(command: object) -> str:
            return str(command).replace("{{domain_password}}", domain_password)

        windows_commands = [
            render_windows_command(command)
            for command in (windows_setup.get("commands") or [])
            if str(command).strip()
        ]
        windows_phases: list[dict] = []
        for phase in windows_setup.get("phases") or []:
            if not isinstance(phase, dict):
                continue
            phase_commands = [
                render_windows_command(command)
                for command in (phase.get("commands") or [])
                if str(command).strip()
            ]
            if phase_commands:
                windows_phases.append(
                    {
                        "name": str(phase.get("name") or f"phase-{len(windows_phases) + 1}"),
                        "commands": phase_commands,
                        "reboot": bool(phase.get("reboot")),
                        "timeout_seconds": int(phase.get("timeout_seconds") or 900),
                    }
                )

        log.info(
            "runner.seed.plan role=%s template=%s windows_commands=%s windows_phases=%s files=%s commands=%s",
            role,
            asset_spec.get("template") or asset.template,
            len(windows_commands),
            len(windows_phases),
            len(files),
            len(runcmd),
        )

        # Compatibility while legacy golden images are replaced. Remove the
        # retired agent on disposable Linux clones without deleting log data.
        if "win" not in template and "windows" not in template:
            runcmd.insert(
                0,
                "if command -v dpkg-query >/dev/null 2>&1 && "
                "dpkg-query -W -f='${Status}' wazuh-agent 2>/dev/null | grep -q 'ok installed$'; then "
                "DEBIAN_FRONTEND=noninteractive dpkg --remove wazuh-agent; fi",
            )

        # Intermediate file-breach scenarios use the blue log aggregator as
        # the investigation trail. Forward local syslog over TCP when the
        # scenario declares that role so telemetry is real, not decorative.
        log_asset = next(
            (
                candidate
                for candidate in (scenario_spec.get("assets") or [])
                if str(candidate.get("role") or "") == "log_aggregator"
            ),
            None,
        )
        if log_asset and base_role != "log_aggregator":
            log_networks = log_asset.get("networks") or []
            scenario_networks = {
                str(net.get("name")): net
                for net in (scenario_spec.get("networks") or [])
                if isinstance(net, dict)
            }
            log_network = scenario_networks.get(str(log_networks[0])) if log_networks else None
            if log_network and log_network.get("cidr"):
                try:
                    log_hosts = list(
                        ipaddress.ip_network(str(log_network["cidr"]), strict=False).hosts()
                    )
                    if len(log_hosts) > 30:
                        files["/etc/rsyslog.d/30-divide-forward.conf"] = (
                            f"*.* @@{log_hosts[30]}:514\n"
                        )
                        runcmd.append("systemctl restart rsyslog || true")
                except (ValueError, TypeError):
                    log.warning("runner.telemetry.invalid_log_network role=%s", role)

        event_log_by_role = {
            "web_gateway": "/var/log/divide-web-events.log",
            "file_server": "/var/log/divide-file-events.log",
            "backup_server": "/var/log/divide-backup-events.log",
        }
        event_log = event_log_by_role.get(base_role)
        if event_log:
            files[event_log] = (
                f"divide scenario asset={base_role} event=seeded\n"
                f"divide scenario asset={base_role} event=ready\n"
            )
            runcmd.append(f"logger -t divide-{base_role} scenario_asset_ready || true")

        if (
            base_role == "router_fw"
            and "opnsense" not in template
            and str(asset_spec.get("network_mode") or "").lower() != "trunk"
        ):
            files["/etc/sysctl.d/99-divide-router.conf"] = (
                "net.ipv4.ip_forward=1\n"
                "net.ipv4.conf.all.rp_filter=0\n"
                "net.ipv4.conf.default.rp_filter=0\n"
            )
            routing = scenario_spec.get("routing_policy") or {}
            network_interfaces = {
                str(network): f"eth{index}"
                for index, network in enumerate(asset_spec.get("networks") or [])
            }
            nft_rules = [
                "table inet divide {",
                "  chain input { type filter hook input priority 0; policy accept; }",
                "  chain output { type filter hook output priority 0; policy accept; }",
                "  chain forward {",
                f"    type filter hook forward priority 0; policy {routing.get('default_forward', 'drop')};",
                "    ct state established,related accept",
            ]
            for rule in routing.get("rules") or []:
                source = network_interfaces.get(str(rule.get("from")))
                target = network_interfaces.get(str(rule.get("to")))
                if not source or not target:
                    continue

                def render_port(port: object) -> str:
                    value = str(port).strip()
                    if "-" in value:
                        start, end = value.split("-", 1)
                        return f"{int(start)}-{int(end)}"
                    return str(int(value))

                ports = ", ".join(render_port(port) for port in rule.get("ports") or [])
                if ports:
                    ports_expr = ports if len(rule.get("ports") or []) == 1 else f"{{ {ports} }}"
                    nft_rules.append(
                        f'    iifname "{source}" oifname "{target}" '
                        f"{rule.get('protocol')} dport {ports_expr} accept"
                    )
            nft_rules.extend(["  }", "}", ""])
            files["/etc/nftables.d/divide-policy.nft"] = "\n".join(nft_rules)
            runcmd.append("nft -f /etc/nftables.d/divide-policy.nft")

        return SeedSpec(
            role=role,
            ciuser=ciuser,
            cipassword=cipassword,
            files=files,
            runcmd=runcmd,
            windows_commands=windows_commands or None,
            windows_phases=windows_phases or None,
        )

    async def _attach_asset_networks(
        self,
        *,
        asset: models.Asset,
        asset_spec: dict,
        bridges_by_name: dict[str, str],
        node: str,
    ) -> None:
        """F3: attach NICs to the bridges this asset declares.

        Iterates ``asset_spec.networks[]`` in declaration order,
        records each as an additional NIC on the freshly cloned VM.
        Silently skips networks whose name is not in
        ``bridges_by_name`` (the runner validates the network
        declarations exist before this is called, so this should be
        unreachable in practice — but we don't want a typo to
        brick the runner with a KeyError here).
        """
        asset_networks = asset_spec.get("networks") or []
        vlan_by_name = getattr(asset, "_f3_vlan_by_name", {})
        network_mode = str(asset_spec.get("network_mode") or "").lower()
        template = str(asset_spec.get("template") or asset.template or "").lower()
        if network_mode == "trunk" or "opnsense" in template:
            vlan_ids = [vlan_by_name.get(str(net_name)) for net_name in asset_networks]
            trunk_vlans = sorted({int(vlan_id) for vlan_id in vlan_ids if vlan_id is not None})
            if not trunk_vlans:
                raise RunnerError(f"router asset {asset.role!r} has no VLAN IDs for trunk mode")
            bridge = bridges_by_name.get(str(asset_networks[0])) if asset_networks else None
            if bridge is None:
                raise RunnerError(f"router asset {asset.role!r} has no attached networks")
            await self._adapter.attach_network(
                asset.pve_vmid,  # type: ignore[arg-type]
                node,
                bridge,
                0,
                trunks=trunk_vlans,
            )
            log.info(
                "runner.networks.attached_trunk role=%s vmid=%s bridge=%s vlans=%s",
                asset.role,
                asset.pve_vmid,
                bridge,
                trunk_vlans,
            )
            return
        for nic_id, net_name in enumerate(asset_networks):
            bridge = bridges_by_name.get(net_name)
            if bridge is None:
                log.warning(
                    "runner.networks.unknown_network role=%s network=%s (bridge not found)",
                    asset.role,
                    net_name,
                )
                continue
            await self._adapter.attach_network(
                asset.pve_vmid,  # type: ignore[arg-type]
                node,
                bridge,
                nic_id,
                vlan_id=vlan_by_name.get(net_name),
            )
            log.info(
                "runner.networks.attached role=%s vmid=%s bridge=%s nic_id=%s",
                asset.role,
                asset.pve_vmid,
                bridge,
                nic_id,
            )

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

    async def _audit(
        self,
        session: AsyncSession,
        *,
        action: AuditAction,
        actor: str | None = None,
        scenario_id: int | None = None,
        run_id: int | None = None,
        asset_id: int | None = None,
        details: dict | None = None,
    ) -> None:
        session.add(
            models.AuditLog(
                action=action,
                actor=actor,
                scenario_id=scenario_id,
                run_id=run_id,
                asset_id=asset_id,
                details=details or {},
            )
        )

    # --- watchdog (L2 2.8) --------------------------------------------

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


def _sessionmaker():
    """Lazy import to avoid circular import at module load."""
    from app.db.session import get_sessionmaker

    return get_sessionmaker()


def _default_adapter() -> ProxmoxAdapter:
    """Pick the right adapter based on env.

    - If `PROXMOX_HOST` + `PROXMOX_TOKEN_ID` + `PROXMOX_TOKEN_SECRET` are
      all set, return a `RealProxmoxAdapter` against the live cluster.
    - Otherwise return `MockProxmoxAdapter` so dev/test/CLI keep working
      without a PVE token.

    This is the single decision point that swaps mock <-> real; the rest of
    the runner doesn't know which is in use.
    """
    from app.core.config import settings
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
