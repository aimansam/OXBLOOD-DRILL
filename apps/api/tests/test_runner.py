"""Runner unit tests against a MockProxmoxAdapter.

We exercise:
  * Happy path: scenario with N assets -> Run SUCCEEDED, N Assets RUNNING
  * Each asset got cloned, started, and assigned an IP
  * Audit log records the lifecycle
  * Stop tears everything down, marks assets STOPPED
  * Asset-level failure transitions to RUN FAILED + best-effort teardown
  * Scenario with no assets raises
  * Scenario missing in DB raises
  * Missing template raises and Run is marked FAILED
  * Adapter error after some assets are spawned triggers teardown of those
"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC

import pytest
from app.db import models
from app.db.base import Base
from app.db.models import AssetStatus, AuditAction, RunStatus
from app.runners.adapter import CloneSpec
from app.runners.mock_adapter import MockProxmoxAdapter
from app.runners.runner import (
    Runner,
    RunnerError,
    RunRequest,
    _static_ip_configs,
    _vm_name,
    instance_spec,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine


def test_vm_name_uses_short_code_and_counted_instance() -> None:
    assert _vm_name({"vm_name": "DC01"}, "dc01") == "DC01"
    assert _vm_name({"vm_name": "PC", "count": 3}, "victim_workstation_2") == "PC02"
    assert _vm_name({}, "dc01") is None


@pytest.mark.asyncio
async def test_stop_reapplies_short_name_after_snapshot_rollback(session: AsyncSession) -> None:
    class RestoringNameAdapter(MockProxmoxAdapter):
        async def restore_vm_snapshot(self, vmid: int, node: str, name: str) -> None:
            await super().restore_vm_snapshot(vmid, node, name)
            self._require_vm(vmid, node).name = "old-dc-name"

    scenario = _scenario_with("short-name-rollback", [{**_asset("dc01"), "vm_name": "DC01"}])
    session.add(scenario)
    await session.commit()
    adapter = RestoringNameAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)
    result = await runner.start_run(RunRequest(scenario_id=scenario.id), session)
    asset = (
        await session.execute(select(models.Asset).where(models.Asset.run_id == result.run_id))
    ).scalar_one()
    await adapter.stop_vm(asset.pve_vmid, asset.pve_node)
    await adapter.create_vm_snapshot(asset.pve_vmid, asset.pve_node, "clean-baseline")
    await adapter.start_vm(asset.pve_vmid, asset.pve_node)
    session.add(
        models.SnapshotBaseline(
            scenario_id=scenario.id,
            scenario_version=1,
            role="dc01",
            template="tpl-x",
            pve_vmid=asset.pve_vmid,
            pve_node=asset.pve_node,
            snapshot_name="clean-baseline",
            status="ready",
            source_run_id=result.run_id,
        )
    )
    await session.commit()

    await runner.stop_run(result.run_id, session=session)
    state = await adapter.get_vm_state(asset.pve_vmid, asset.pve_node)
    assert state.status == "stopped"
    assert state.name == "DC01"


@pytest.mark.asyncio
async def test_build_snapshot_baselines_is_automatic_and_idempotent(session: AsyncSession) -> None:
    scenario = _scenario_with("auto-baseline", [_asset("dc01"), _asset("web")])
    session.add(scenario)
    await session.commit()
    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)

    built = await runner.build_snapshot_baselines(scenario.id, session, actor="t")
    assert {b.role for b in built} == {"dc01", "web"}
    assert len(adapter.snapshots_created) == 2
    assert await runner.ready_baseline_roles(scenario, session) == {"dc01", "web"}

    assert await runner.build_snapshot_baselines(scenario.id, session, actor="t") == []
    assert len(adapter.snapshots_created) == 2

    # The next prepare restores the snapshots instead of cloning.
    result = await runner.start_run(RunRequest(scenario_id=scenario.id), session)
    assert result.status == RunStatus.RUNNING
    assert len(adapter.snapshots_restored) == 2


@pytest.mark.asyncio
async def test_build_snapshot_baselines_removes_clones_when_a_vm_is_down(
    session: AsyncSession,
) -> None:
    class DownAdapter(MockProxmoxAdapter):
        down = False

        async def get_vm_state(self, vmid: int, node: str):
            state = await super().get_vm_state(vmid, node)
            return dataclasses.replace(state, status="stopped") if self.down else state

    scenario = _scenario_with("auto-baseline-fail", [_asset("dc01")])
    session.add(scenario)
    await session.commit()
    adapter = DownAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)
    real_start = runner.start_run

    async def start_then_go_down(req, sess):
        result = await real_start(req, sess)
        adapter.down = True
        return result

    runner.start_run = start_then_go_down  # type: ignore[method-assign]

    with pytest.raises(RunnerError, match="clones removed"):
        await runner.build_snapshot_baselines(scenario.id, session)
    assert adapter.snapshots_created == []
    rows = (await session.execute(select(models.SnapshotBaseline))).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_build_snapshot_baselines_refuses_an_incomplete_set(session: AsyncSession) -> None:
    scenario = _scenario_with("auto-baseline-stale", [_asset("dc01"), _asset("web")])
    session.add(scenario)
    await session.commit()
    session.add(
        models.SnapshotBaseline(
            scenario_id=scenario.id,
            scenario_version=1,
            role="dc01",
            template="tpl-x",
            pve_vmid=777,
            pve_node="pve",
            snapshot_name="clean-baseline",
            status="ready",
        )
    )
    await session.commit()
    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    with pytest.raises(RunnerError, match="Retire them"):
        await Runner(adapter=adapter).build_snapshot_baselines(scenario.id, session)
    assert adapter.snapshots_created == []


@pytest.mark.asyncio
async def test_reset_run_to_baselines_restores_every_vm_in_place(session: AsyncSession) -> None:
    scenario = _scenario_with("reset-in-place", [_asset("dc01"), _asset("web")])
    session.add(scenario)
    await session.commit()
    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)
    await runner.build_snapshot_baselines(scenario.id, session)
    result = await runner.start_run(RunRequest(scenario_id=scenario.id), session)
    restored_before = len(adapter.snapshots_restored)

    assert await runner.reset_run_to_baselines(result.run_id, session) == 2
    assert len(adapter.snapshots_restored) == restored_before + 2
    run = await session.get(models.Run, result.run_id)
    assert run.status == RunStatus.RUNNING


@pytest.mark.asyncio
async def test_reset_run_to_baselines_refuses_machines_without_a_baseline(
    session: AsyncSession,
) -> None:
    scenario = _scenario_with("reset-no-baseline", [_asset("dc01")])
    session.add(scenario)
    await session.commit()
    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)
    result = await runner.start_run(RunRequest(scenario_id=scenario.id), session)

    with pytest.raises(RunnerError, match="no snapshot baseline for: dc01"):
        await runner.reset_run_to_baselines(result.run_id, session)
    assert adapter.snapshots_restored == []


def test_instance_spec_shifts_vlans_and_names_and_leaves_copy_one_alone() -> None:
    spec = {
        "networks": [{"name": "a", "vlan_id": 230}, {"name": "b"}],
        "assets": [{"role": "web", "template": "tpl-x", "vm_name": "WEB01"}, {"role": "db"}],
    }
    assert instance_spec(spec, 1) is spec
    copy = instance_spec(spec, 3)
    assert [n.get("vlan_id") for n in copy["networks"]] == [270, None]
    assert [a.get("vm_name") for a in copy["assets"]] == ["M3-WEB01", None]
    assert spec["networks"][0]["vlan_id"] == 230  # the original is untouched

    with pytest.raises(RunnerError, match="OPNsense"):
        instance_spec({"assets": [{"role": "fw", "template": "tpl-opnsense"}]}, 2)


@pytest.mark.asyncio
async def test_range_copies_have_their_own_baselines_vlans_and_names(session: AsyncSession) -> None:
    asset = {**_asset("web"), "vm_name": "WEB01"}
    scenario = _scenario_with("copies", [asset])
    scenario.spec["spec"]["networks"] = [{"name": "n", "cidr": "10.10.0.0/24", "vlan_id": 230}]
    session.add(scenario)
    await session.commit()
    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)

    one = await runner.build_snapshot_baselines(scenario.id, session, instance=1)
    two = await runner.build_snapshot_baselines(scenario.id, session, instance=2)
    assert one[0].pve_vmid != two[0].pve_vmid
    assert (one[0].instance, two[0].instance) == (1, 2)
    assert await runner.ready_baseline_roles(scenario, session, 2) == {"web"}
    assert await runner.build_snapshot_baselines(scenario.id, session, instance=2) == []

    vlans = {vlan for (_vm, _bridge, _nic, vlan) in adapter.nic_attached_vlan}
    assert {230, 250} <= vlans

    result = await runner.start_run(RunRequest(scenario_id=scenario.id, instance=2), session)
    assert result.status == RunStatus.RUNNING
    restored = [vmid for (vmid, _node, _name) in adapter.snapshots_restored]
    assert restored == [two[0].pve_vmid]  # copy 2 restored its own VM, not copy 1's
    state = await adapter.get_vm_state(two[0].pve_vmid, two[0].pve_node)
    assert state.name == "M2-WEB01"


# --- fixtures ---------------------------------------------------------------


@pytest.fixture
def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    yield eng
    import asyncio

    asyncio.run(eng.dispose())


@pytest.fixture
async def session(engine) -> AsyncSession:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as s:
        yield s


def _scenario_with(name: str, assets_spec: list[dict]) -> models.Scenario:
    network_names = sorted(
        {network for asset in assets_spec for network in (asset.get("networks") or [])}
    )
    return models.Scenario(
        name=name,
        title=name,
        version=1,
        difficulty="beginner",
        duration_min=30,
        spec={
            "apiVersion": "divide/v1",
            "kind": "Scenario",
            "spec": {
                "networks": [
                    {"name": network, "cidr": "10.10.0.0/24"} for network in network_names
                ],
                "assets": assets_spec,
            },
        },
    )


def _asset(role: str, template: str = "tpl-x") -> dict:
    return {"role": role, "kind": "vm", "template": template, "networks": ["n"]}


def test_static_ip_configs_use_declared_host_number() -> None:
    scenario = {"networks": [{"name": "identity", "cidr": "10.30.40.0/24"}]}

    assert _static_ip_configs({"role": "dc01", "networks": ["identity"]}, scenario) == {
        0: "ip=10.30.40.10/24,gw=10.30.40.1"
    }
    assert _static_ip_configs({"role": "blue_workstation", "networks": ["identity"]}, scenario) == {
        0: "ip=10.30.40.11/24,gw=10.30.40.1"
    }
    assert (
        _static_ip_configs(
            {"role": "dc01", "template": "tpl-win2022-ad-auto", "networks": ["identity"]},
            scenario,
        )
        == {}
    )


# --- happy path -------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_run_creates_run_and_assets(session: AsyncSession) -> None:
    s = _scenario_with(
        "happy",
        [_asset("red_attacker"), _asset("victim_workstation")],
    )
    session.add(s)
    await session.commit()
    await session.refresh(s)

    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)

    result = await runner.start_run(RunRequest(scenario_id=s.id, started_by="alice"), session)
    # Run stays in RUNNING state until watchdog timeout or manual stop
    assert result.status == RunStatus.RUNNING

    runs = (await session.execute(select(models.Run))).scalars().all()
    assert len(runs) == 1
    run = runs[0]
    # Run stays in RUNNING state until watchdog timeout or manual stop
    assert run.status == RunStatus.RUNNING
    assert run.started_by == "alice"
    assert run.started_at is not None
    # ended_at and duration_sec are NULL while run is still active
    assert run.ended_at is None
    assert run.duration_sec is None

    assets = (await session.execute(select(models.Asset))).scalars().all()
    assert len(assets) == 2
    roles = sorted(a.role for a in assets)
    assert roles == ["red_attacker", "victim_workstation"]
    # Assets stay RUNNING after start_run — VMs are not torn down
    # immediately. They remain active until watchdog timeout or
    # manual stop/cancel.
    for a in assets:
        assert a.status == AssetStatus.RUNNING
        assert a.pve_vmid is not None
        assert a.pve_node == "pve"
        assert a.pve_ip is not None


@pytest.mark.asyncio
async def test_start_run_honors_drill_cleanup_request(session: AsyncSession) -> None:
    s = _scenario_with(
        "cancel-during-provision",
        [_asset("first_vm"), _asset("second_vm")],
    )
    session.add(s)
    await session.commit()

    cancel_event = asyncio.Event()

    class CancelAfterFirstBootAdapter(MockProxmoxAdapter):
        async def start_vm(self, vmid: int, node: str) -> None:
            await super().start_vm(vmid, node)
            cancel_event.set()

    adapter = CancelAfterFirstBootAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)

    result = await runner.start_run(
        RunRequest(
            scenario_id=s.id,
            started_by="operator",
            cancel_event=cancel_event,
        ),
        session,
    )

    assert result.status == RunStatus.CANCELLED
    run = (await session.execute(select(models.Run))).scalar_one()
    assets = (
        (await session.execute(select(models.Asset).where(models.Asset.run_id == run.id)))
        .scalars()
        .all()
    )
    assert run.ended_at is not None
    assert all(asset.status == AssetStatus.STOPPED for asset in assets)
    assert all(asset.cleaned_at is not None for asset in assets if asset.pve_vmid)
    assert len(adapter.destroyed) == 1


@pytest.mark.asyncio
async def test_start_run_records_audit_log(session: AsyncSession) -> None:
    s = _scenario_with("audited", [_asset("red_attacker")])
    session.add(s)
    await session.commit()

    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)

    await runner.start_run(RunRequest(scenario_id=s.id, started_by="alice"), session)

    logs = (await session.execute(select(models.AuditLog))).scalars().all()
    actions = [log.action for log in logs]
    assert AuditAction.RUN_STARTED in actions
    assert AuditAction.ASSET_SPAWNED in actions
    # RUN_COMPLETED is NOT emitted here — run stays RUNNING until
    # watchdog timeout or manual stop


@pytest.mark.asyncio
async def test_start_run_asset_spawned_audit_records_actor(session: AsyncSession) -> None:
    """Regression for L2 2.9: every ASSET_SPAWNED audit row must carry the
    token subject (i.e. Run.started_by) — not NULL. The router already
    threads ``started_by`` through RunRequest -> Run.started_by; the
    runner's _spawn_asset() used to omit the actor on its _audit call,
    so all per-asset lifecycle events were unattributed.
    """
    s = _scenario_with("attributed", [_asset("red_attacker"), _asset("dc")])
    session.add(s)
    await session.commit()

    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)

    result = await runner.start_run(RunRequest(scenario_id=s.id, started_by="alice"), session)
    # Run stays in RUNNING state until watchdog timeout or manual stop
    assert result.status == RunStatus.RUNNING

    spawn_audits = (
        (
            await session.execute(
                select(models.AuditLog).where(
                    models.AuditLog.run_id == result.run_id,
                    models.AuditLog.action == AuditAction.ASSET_SPAWNED,
                )
            )
        )
        .scalars()
        .all()
    )
    # Two assets -> two spawn events; both must be attributed.
    assert len(spawn_audits) == 2
    for entry in spawn_audits:
        assert entry.actor == "alice", f"ASSET_SPAWNED audit row missing actor: {entry.actor!r}"
        assert entry.asset_id is not None
        assert entry.run_id == result.run_id


@pytest.mark.asyncio
async def test_mock_adapter_records_calls(session: AsyncSession) -> None:
    s = _scenario_with("calls", [_asset("red_attacker"), _asset("dc")])
    session.add(s)
    await session.commit()

    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)

    await runner.start_run(RunRequest(scenario_id=s.id), session)

    # 2 clones, 2 starts, 2 VM-state queries
    assert len(adapter.cloned) == 2
    assert len(adapter.started) == 2
    assert all(spec.name.startswith("divide-") for spec in adapter.cloned)
    # Asset names embed role; check both roles show up. Note that the
    # runner sanitizes underscores from the role before passing it to
    # PVE (PVE 9 rejects DNS-invalid names on the clone endpoint), so
    # 'red_attacker' becomes 'redattacker'.
    names = sorted(spec.name.rsplit("-", 1)[-1] for spec in adapter.cloned)
    assert names == ["dc", "redattacker"]


# --- stop path --------------------------------------------------------------


@pytest.mark.asyncio
async def test_stop_run_tears_down_assets(session: AsyncSession) -> None:
    s = _scenario_with("stopped", [_asset("red_attacker"), _asset("victim")])
    session.add(s)
    await session.commit()

    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)
    result = await runner.start_run(RunRequest(scenario_id=s.id), session)
    # Q17: ``start_run`` now cleans up VMs on the success path,
    # so by the time we call ``stop_run`` the mock adapter has
    # already destroyed the 2 spawned clones once. ``stop_run``
    # then re-enters stop_vm/destroy_vm idempotently (the mock
    # records every call), giving 2 spawn + 2 stop-on-success
    # + 2 stop-from-stop_run = 6 calls if we count both, but
    # the assertions below only care about the second-stage
    # numbers being >= the previous baseline (2) -- the mock
    # teardown is idempotent.
    stopped = await runner.stop_run(result.run_id, reason="end of smoke", session=session)

    assert stopped.status == RunStatus.SUCCEEDED  # we left it SUCCEEDED
    # An operator stop is a terminal transition like cancel/fail/timeout, so
    # it records when the run ended (and therefore its duration).
    assert stopped.ended_at is not None
    assert stopped.duration_sec is not None
    for a in stopped.assets:
        assert a.status == AssetStatus.STOPPED
    # Q17: pre-fix this asserted ``len(stopped) == 2``. With
    # success-path cleanup the count is doubled. Both phases
    # are idempotent on the mock, so we just assert non-zero
    # counts at each stage.
    assert len(adapter.stopped) >= 2
    assert len(adapter.destroyed) >= 2


@pytest.mark.asyncio
async def test_telemetry_sinks_see_started_then_completed(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sinks get run.started when the drill starts and run.completed when it is stopped."""
    from app.runners import runner as runner_module

    sent: list[dict] = []

    async def _capture(sinks, event):
        sent.append(event)

    monkeypatch.setattr(runner_module._telemetry, "dispatch", _capture)

    s = _scenario_with("sink-events", [_asset("red_attacker")])
    session.add(s)
    await session.commit()
    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)
    result = await runner.start_run(RunRequest(scenario_id=s.id), session)

    assert [e["type"] for e in sent] == ["run.started"]
    assert "ended_at" not in sent[0]

    await runner.stop_run(result.run_id, reason="done", session=session)

    assert [e["type"] for e in sent] == ["run.started", "run.completed"]
    assert sent[1]["ended_at"] is not None
    assert sent[1]["duration_sec"] is not None
    assert sent[1]["reason"] == "done"


@pytest.mark.asyncio
async def test_stop_run_is_idempotent(session: AsyncSession) -> None:
    s = _scenario_with("twice", [_asset("red_attacker")])
    session.add(s)
    await session.commit()
    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)
    await runner.start_run(RunRequest(scenario_id=s.id), session)
    first = await runner.stop_run(1, session=session)
    second = await runner.stop_run(1, session=session)  # second call must not crash

    # Same run, same final state.
    assert first.id == second.id == 1
    assert second.status == RunStatus.SUCCEEDED


# --- failure paths ----------------------------------------------------------


@pytest.mark.asyncio
async def test_v2_preparation_never_recovers_a_legacy_watchdog(
    session: AsyncSession, monkeypatch
) -> None:
    from datetime import datetime, timedelta

    from app.core.config import settings

    monkeypatch.setattr(settings, "drill_timeout_enabled", True)
    scenario = _scenario_with("prepared-timer", [_asset("desktop")])
    session.add(scenario)
    await session.flush()
    run = models.Run(
        scenario_id=scenario.id,
        status=RunStatus.RUNNING,
        timeout_min=-1,
        started_at=datetime.now(UTC) - timedelta(hours=3),
    )
    session.add(run)
    await session.commit()
    assert Runner.get_timeout_sec(run.id, run.started_at, timeout_min=-1) is None
    assert await Runner.recover_watchdogs(session) == 0
    assert run.status == RunStatus.RUNNING


@pytest.mark.asyncio
async def test_start_run_unknown_scenario_raises(session: AsyncSession) -> None:
    adapter = MockProxmoxAdapter()
    runner = Runner(adapter=adapter)
    with pytest.raises(RunnerError, match="not found"):
        await runner.start_run(RunRequest(scenario_id=999), session)


@pytest.mark.asyncio
async def test_start_run_no_assets_raises(session: AsyncSession) -> None:
    s = _scenario_with("empty", [])
    session.add(s)
    await session.commit()
    adapter = MockProxmoxAdapter()
    runner = Runner(adapter=adapter)
    with pytest.raises(RunnerError, match="no assets"):
        await runner.start_run(RunRequest(scenario_id=s.id), session)


@pytest.mark.asyncio
async def test_start_run_missing_template_fails_run(session: AsyncSession) -> None:
    s = _scenario_with("missing-tpl", [_asset("red_attacker", template="tpl-doesnt-exist")])
    session.add(s)
    await session.commit()

    adapter = MockProxmoxAdapter()
    # NOTE: deliberately do NOT seed tpl-doesnt-exist
    runner = Runner(adapter=adapter)

    with pytest.raises(RunnerError, match="Range preflight failed"):
        await runner.start_run(RunRequest(scenario_id=s.id), session)

    assert (await session.execute(select(models.Run))).scalar_one_or_none() is None
    assert (await session.execute(select(models.Asset))).scalar_one_or_none() is None
    assert adapter.destroyed == []


@pytest.mark.asyncio
async def test_start_run_partial_failure_tears_down_clones(session: AsyncSession) -> None:
    """Asset 1 succeeds; asset 2 fails while cloning. The runner should
    destroy the successfully-cloned asset 1."""
    s = _scenario_with(
        "partial",
        [
            _asset("a", template="tpl-a"),
            _asset("b", template="tpl-b"),
        ],
    )
    session.add(s)
    await session.commit()

    class PartialFailureAdapter(MockProxmoxAdapter):
        async def clone_vm(self, spec):
            if spec.source_vmid == 9001:
                raise RunnerError("Second clone failed")
            return await super().clone_vm(spec)

    adapter = PartialFailureAdapter()
    adapter.seed_template("tpl-a", 9000)
    adapter.seed_template("tpl-b", 9001)
    runner = Runner(adapter=adapter)

    with pytest.raises(RunnerError):
        await runner.start_run(RunRequest(scenario_id=s.id), session)

    # At least one non-template VMID should have been destroyed: the
    # successfully-cloned asset 'a'. We can't pin the exact VMID because
    # template seeding already consumed 9000; just count destructions
    # of non-template VMs.
    non_template_destroys = [
        (vmid, node)
        for (vmid, node) in adapter.destroyed
        if vmid != 9000  # the template seed VMID
    ]
    assert non_template_destroys, (
        f"expected asset 'a' VM destroyed, got adapter.destroyed={adapter.destroyed}"
    )


@pytest.mark.asyncio
async def test_start_run_clone_failure_continues_audit(session: AsyncSession) -> None:
    """When the adapter raises mid-clone, we still record the FAILED audit."""
    s = _scenario_with("audit-on-fail", [_asset("only", template="tpl-x")])
    session.add(s)
    await session.commit()

    class ExplodingAdapter(MockProxmoxAdapter):
        async def clone_vm(self, spec: CloneSpec):  # type: ignore[override]
            raise RuntimeError("disk full")

    adapter = ExplodingAdapter()
    adapter.seed_template("tpl-x", 9000)
    runner = Runner(adapter=adapter)

    with pytest.raises(RuntimeError, match="disk full"):
        await runner.start_run(RunRequest(scenario_id=s.id), session)

    actions = [
        log.action for log in (await session.execute(select(models.AuditLog))).scalars().all()
    ]
    assert AuditAction.RUN_FAILED in actions


# --- adapter contract -------------------------------------------------------


@pytest.mark.asyncio
async def test_mock_adapter_inventory_round_trip() -> None:
    adapter = MockProxmoxAdapter(nodes=["pve-a", "pve-b"])
    assert await adapter.list_nodes() == ["pve-a", "pve-b"]
    adapter.seed_template("tpl-x", 9000)
    assert await adapter.find_template("tpl-x") == 9000
    assert await adapter.find_template("nope") is None
    vmid1 = await adapter.allocate_vmid()
    vmid2 = await adapter.allocate_vmid()
    assert vmid2 == vmid1 + 1


@pytest.mark.asyncio
async def test_mock_adapter_clone_then_state() -> None:
    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    res = await adapter.clone_vm(
        CloneSpec(source_vmid=9000, new_vmid=9100, node="pve", name="alice")
    )
    assert res.vmid == 9100
    state = await adapter.get_vm_state(9100, "pve")
    assert state.status == "stopped"
    await adapter.start_vm(9100, "pve")
    state = await adapter.get_vm_state(9100, "pve")
    assert state.status == "running"


def test_runner_skips_default_cloud_init_seed_for_windows_template() -> None:
    runner = Runner(MockProxmoxAdapter())
    asset = models.Asset(
        role="victim_workstation",
        kind="vm",
        template="tpl-win11-enterprise",
        status=AssetStatus.PLANNED,
    )

    seed = runner._build_seed_spec(
        asset=asset,
        asset_spec={
            "role": "victim_workstation",
            "kind": "vm",
            "template": "tpl-win11-enterprise",
        },
        scenario_spec={},
    )

    assert seed is None


def test_legacy_linux_image_removes_agent_and_keeps_syslog() -> None:
    import subprocess

    runner = Runner(MockProxmoxAdapter())
    asset = models.Asset(
        run_id=1, role="blue_workstation", template="tpl-debian-blue-gui-wazuh-xrdp"
    )
    seed = runner._build_seed_spec(
        asset=asset,
        asset_spec={"role": asset.role, "template": asset.template},
        scenario_spec={
            "telemetry": {"sinks": [{"type": "wazuh", "endpoint": "10.30.221.10:1514"}]},
            "assets": [{"role": "log_aggregator", "networks": ["blue"]}],
            "networks": [{"name": "blue", "cidr": "10.30.40.0/24"}],
        },
    )
    assert seed is not None
    assert "dpkg --remove wazuh-agent" in seed.runcmd[0]
    assert "agent-auth" not in "\n".join(seed.runcmd) + str(seed.files)
    assert "wazuh-enroll.sh" not in str(seed.files)
    assert seed.files["/etc/rsyslog.d/30-divide-forward.conf"] == "*.* @@10.30.40.31:514\n"
    subprocess.run(["sh", "-n"], input=seed.runcmd[0], text=True, check=True)
    # Mock package tools in the shell; never uninstall a package on the test host.
    result = subprocess.run(
        [
            "bash",
            "-c",
            "set -eu; dpkg-query() { printf 'hold ok installed'; }; "
            "dpkg() { return 42; }; " + seed.runcmd[0] + "; echo unexpected-success",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 42
    assert "unexpected-success" not in result.stdout


def test_compact_blue_workstation_receives_investigation_bundle() -> None:
    runner = Runner(MockProxmoxAdapter())
    asset = models.Asset(
        run_id=1, role="blue_workstation", template="tpl-debian-blue-gui-wazuh-xrdp"
    )
    seed = runner._build_seed_spec(
        asset=asset,
        asset_spec={"role": asset.role, "template": asset.template},
        scenario_spec={
            "assets": [{"role": "blue_workstation", "networks": ["identity"]}],
            "flags": [
                {
                    "id": "blue-pivot",
                    "side": "blue",
                    "value": "FLAG{pivot}",
                    "planted_on_role": "blue_workstation",
                }
            ],
        },
    )

    assert seed is not None
    assert "/opt/divide/evidence/incident-timeline.log" in seed.files
    assert (
        "dmz_gateway authenticated to dc01"
        in seed.files["/opt/divide/evidence/incident-timeline.log"]
    )
    assert seed.files["/opt/divide/flags/blue-pivot.txt"] == "FLAG{pivot}\n"


@pytest.mark.asyncio
async def test_legacy_sink_never_starts_retired_manager(session: AsyncSession) -> None:
    from unittest.mock import AsyncMock

    scenario = _scenario_with("retired-manager", [_asset("desktop")])
    scenario.spec = {
        **scenario.spec,
        "spec": {
            **scenario.spec["spec"],
            "telemetry": {"sinks": [{"type": "wazuh", "endpoint": "10.30.221.10:1514"}]},
        },
    }
    session.add(scenario)
    await session.commit()
    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    adapter.ensure_vm_running = AsyncMock(
        side_effect=AssertionError("Retired manager must not start")
    )
    await Runner(adapter).start_run(RunRequest(scenario_id=scenario.id, timeout_min=-1), session)
    adapter.ensure_vm_running.assert_not_awaited()


def test_runner_can_opt_windows_template_into_cloudbase_seed() -> None:
    runner = Runner(MockProxmoxAdapter())
    asset = models.Asset(
        role="victim_workstation",
        kind="vm",
        template="tpl-win11-enterprise",
        status=AssetStatus.PLANNED,
    )

    seed = runner._build_seed_spec(
        asset=asset,
        asset_spec={
            "role": "victim_workstation",
            "kind": "vm",
            "template": "tpl-win11-enterprise",
            "cloudbase_init": True,
        },
        scenario_spec={},
    )

    assert seed is not None
    assert seed.role == "victim_workstation"


@pytest.mark.asyncio
async def test_runner_seeds_role_credentials_and_flags(session: AsyncSession) -> None:
    s = models.Scenario(
        name="seeded",
        title="seeded",
        version=1,
        difficulty="beginner",
        duration_min=30,
        spec={
            "apiVersion": "divide/v1",
            "kind": "Scenario",
            "spec": {
                "objectives": {
                    "red": ["Reach the file server."],
                    "blue": ["Identify the red IP."],
                },
                "networks": [],
                "assets": [
                    {"role": "red_workstation", "kind": "vm", "template": "tpl-x", "networks": []},
                    {"role": "blue_workstation", "kind": "vm", "template": "tpl-x", "networks": []},
                    {"role": "file_server", "kind": "vm", "template": "tpl-x", "networks": []},
                ],
                "flags": [
                    {
                        "id": "red-flag-file-server",
                        "side": "red",
                        "value": "FLAG{file_server_access_confirmed}",
                        "planted_on_role": "file_server",
                        "decay_window_seconds": 3600,
                        "base_points": 150,
                    }
                ],
            },
        },
    )
    session.add(s)
    await session.commit()
    await session.refresh(s)

    adapter = MockProxmoxAdapter(templates={"tpl-x": 9000})
    runner = Runner(adapter=adapter)
    await runner.start_run(RunRequest(scenario_id=s.id), session)

    seeds = {seed.role: seed for _, _, seed in adapter.seeded}
    assert seeds["red_workstation"].ciuser == "red"
    assert seeds["red_workstation"].cipassword == "red-team"
    assert seeds["blue_workstation"].ciuser == "blue"
    assert seeds["blue_workstation"].cipassword == "blue-team"
    file_seed = seeds["file_server"]
    assert file_seed.ciuser == "divide"
    assert file_seed.files
    assert file_seed.files["/opt/divide/flags/red-flag-file-server.txt"] == (
        "FLAG{file_server_access_confirmed}\n"
    )


@pytest.mark.asyncio
async def test_mock_adapter_destroy_is_idempotent() -> None:
    adapter = MockProxmoxAdapter()
    adapter.seed_template("tpl-x", 9000)
    await adapter.destroy_vm(9999, "pve")  # not present, must not raise
    assert adapter.destroyed == [(9999, "pve")]


@pytest.mark.asyncio
async def test_get_vm_state_missing_raises() -> None:
    adapter = MockProxmoxAdapter()
    with pytest.raises(KeyError):
        await adapter.get_vm_state(12345, "pve")


# --- cancel_run -----------------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_run_tears_down_and_marks_cancelled(session: AsyncSession) -> None:
    """A run in RUNNING must cancel cleanly: assets stopped + destroyed,
    run flips to CANCELLED, audit row records actor + reason.

    We construct the run/asset state directly (rather than via start_run)
    because start_run completes synchronously with the mock — by the time
    it returns, status is SUCCEEDED. The runner's lifecycle model
    assumes a non-terminal state when cancel arrives; in production the
    portal would call cancel mid-flight via the background task model.
    """
    s = _scenario_with("cancelled", [_asset("red_attacker"), _asset("victim")])
    session.add(s)
    await session.flush()
    run = models.Run(
        scenario_id=s.id,
        status=RunStatus.RUNNING,
        started_by="unit",
    )
    session.add(run)
    await session.flush()
    # Two assets with VMIDs (pretend spawn already happened).
    for role, vmid in [("red_attacker", 9100), ("victim", 9101)]:
        session.add(
            models.Asset(
                run_id=run.id,
                role=role,
                kind="vm",
                template="tpl-x",
                status=AssetStatus.RUNNING,
                pve_vmid=vmid,
                pve_node="pve",
            )
        )
    await session.commit()

    adapter = MockProxmoxAdapter()
    runner = Runner(adapter=adapter)
    cancelled = await runner.cancel_run(
        run.id, reason="trainee pressed abort", actor="trainee-7", session=session
    )

    assert cancelled.id == run.id
    assert cancelled.status == RunStatus.CANCELLED
    assert cancelled.error == "trainee pressed abort"
    for a in cancelled.assets:
        assert a.status == AssetStatus.STOPPED
    # Adapter saw stop (forced) + destroy for every spawned asset.
    assert len(adapter.stopped) == 2
    assert all(force for (_v, _n, force) in adapter.stopped)
    assert len(adapter.destroyed) == 2

    # Audit row recorded with actor + reason.
    audits = (
        (await session.execute(select(models.AuditLog).where(models.AuditLog.run_id == run.id)))
        .scalars()
        .all()
    )
    actions = {a.action for a in audits}
    assert AuditAction.RUN_CANCELLED in actions
    cancel_audit = next(a for a in audits if a.action == AuditAction.RUN_CANCELLED)
    assert cancel_audit.actor == "trainee-7"
    assert cancel_audit.details["reason"] == "trainee pressed abort"


@pytest.mark.asyncio
async def test_cancel_run_on_unknown_run_raises(session: AsyncSession) -> None:
    adapter = MockProxmoxAdapter()
    runner = Runner(adapter=adapter)
    with pytest.raises(RunnerError, match="not found"):
        await runner.cancel_run(9999, session=session)


@pytest.mark.asyncio
async def test_cancel_run_on_terminal_run_raises(session: AsyncSession) -> None:
    """A run that has already reached a terminal state cannot be cancelled."""
    s = _scenario_with("already_done", [_asset("red_attacker")])
    session.add(s)
    await session.flush()
    run = models.Run(
        scenario_id=s.id,
        status=RunStatus.SUCCEEDED,
        started_by="unit",
    )
    session.add(run)
    await session.commit()

    adapter = MockProxmoxAdapter()
    runner = Runner(adapter=adapter)
    with pytest.raises(RunnerError, match="terminal state"):
        await runner.cancel_run(run.id, session=session)


@pytest.mark.asyncio
async def test_cancel_run_isolates_from_stop_run_semantics(
    session: AsyncSession,
) -> None:
    """cancel_run -> CANCELLED, stop_run -> SUCCEEDED. Same teardown,
    different terminal state — proves the two paths don't alias."""
    s = _scenario_with("lifecycle_test", [_asset("red_attacker")])
    session.add(s)
    await session.flush()

    # cancel path
    run_cancel = models.Run(scenario_id=s.id, status=RunStatus.RUNNING, started_by="unit")
    session.add(run_cancel)
    await session.flush()
    session.add(
        models.Asset(
            run_id=run_cancel.id,
            role="red_attacker",
            kind="vm",
            template="tpl-x",
            status=AssetStatus.RUNNING,
            pve_vmid=9100,
            pve_node="pve",
        )
    )
    await session.commit()

    adapter1 = MockProxmoxAdapter()
    runner1 = Runner(adapter=adapter1)
    out_cancel = await runner1.cancel_run(run_cancel.id, session=session)
    assert out_cancel.status == RunStatus.CANCELLED

    # stop path (separate run)
    run_stop = models.Run(scenario_id=s.id, status=RunStatus.RUNNING, started_by="unit")
    session.add(run_stop)
    await session.flush()
    session.add(
        models.Asset(
            run_id=run_stop.id,
            role="red_attacker",
            kind="vm",
            template="tpl-x",
            status=AssetStatus.RUNNING,
            pve_vmid=9200,
            pve_node="pve",
        )
    )
    await session.commit()

    adapter2 = MockProxmoxAdapter()
    runner2 = Runner(adapter=adapter2)
    out_stop = await runner2.stop_run(run_stop.id, session=session)
    assert out_stop.status == RunStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_cancel_run_handles_no_assets_yet(session: AsyncSession) -> None:
    """A run in PENDING (no spawned assets yet) must cancel cleanly
    without any adapter calls."""
    s = _scenario_with("pending", [_asset("red_attacker")])
    session.add(s)
    await session.commit()

    run = models.Run(scenario_id=s.id, status=RunStatus.PENDING, started_by="unit")
    session.add(run)
    await session.commit()

    adapter = MockProxmoxAdapter()
    runner = Runner(adapter=adapter)
    cancelled = await runner.cancel_run(run.id, reason="aborted before start", session=session)
    assert cancelled.status == RunStatus.CANCELLED
    assert adapter.stopped == []
    assert adapter.destroyed == []


@pytest.mark.asyncio
async def test_cancel_run_records_error_as_reason(session: AsyncSession) -> None:
    """Run.error stores the cancel reason so the UI can show 'why'."""
    s = _scenario_with("why_cancelled", [_asset("red_attacker")])
    session.add(s)
    await session.flush()
    run = models.Run(scenario_id=s.id, status=RunStatus.RUNNING, started_by="unit")
    session.add(run)
    await session.flush()
    session.add(
        models.Asset(
            run_id=run.id,
            role="red_attacker",
            kind="vm",
            template="tpl-x",
            status=AssetStatus.PLANNED,
            pve_vmid=None,
            pve_node=None,
        )
    )
    await session.commit()

    adapter = MockProxmoxAdapter()
    runner = Runner(adapter=adapter)
    out = await runner.cancel_run(run.id, reason="scoring threshold already met", session=session)
    assert out.error == "scoring threshold already met"
