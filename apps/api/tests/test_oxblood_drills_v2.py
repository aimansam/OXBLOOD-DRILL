"""Regression coverage for OxBlood v2 drill behavior used by the web UI."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from app.core.auth import sign_token
from app.db import models as auth_models
from app.db import models_drill as m
from app.db.session import get_session
from app.runners.adapter import ConsoleTicket, VmState
from app.services.drill_service import (
    create_drill,
    create_drill_flag,
    get_drill,
    link_scenario,
    update_drill,
)
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _patch(monkeypatch, name, value):
    """Patch ``name`` in every drills_v2 submodule that looks it up."""
    from app.routers import drills_v2

    patched = False
    for module in drills_v2.SUBMODULES:
        if hasattr(module, name):
            monkeypatch.setattr(module, name, value)
            patched = True
    assert patched, f"no drills_v2 submodule defines {name}"


def test_team_enrollment_does_not_fail_vm_preparation():
    from app.routers.drills_v2 import _provision_checks_ready

    checks = [
        {"id": "range-machines", "required": True, "state": "ready"},
        {"id": "mission-roster", "required": True, "state": "needs_attention"},
    ]
    assert _provision_checks_ready({"checks": checks})
    checks[0]["state"] = "needs_attention"
    assert not _provision_checks_ready({"checks": checks})


@pytest.mark.parametrize("phase", ["starting", "validating", "validation_failed", "started"])
def test_prepared_range_reserves_environment_without_timer(sessionmaker, phase):
    from app.modules.drills.lock import acquire_environment_lock, environment_lock_status
    from fastapi import HTTPException

    async def case():
        async with sessionmaker() as db:
            drill = await create_drill(
                db, title="Prepared", environment_config={"provision_status": phase}
            )
            assert drill.actual_start_at is None
            state = await environment_lock_status(db)
            assert not state["available"]
            assert state["drill_id"] == drill.id
            with pytest.raises(HTTPException) as exc:
                await acquire_environment_lock(db, owner_sub="other", owner_role="lead")
            assert exc.value.status_code == 409

    _run(case())


def test_unbound_claim_cannot_be_overwritten(sessionmaker):
    from app.modules.drills.lock import acquire_environment_lock
    from fastapi import HTTPException

    async def case():
        async with sessionmaker() as db:
            await acquire_environment_lock(db, owner_sub="first", owner_role="lead")
            with pytest.raises(HTTPException) as exc:
                await acquire_environment_lock(db, owner_sub="second", owner_role="lead")
            assert exc.value.status_code == 409

    _run(case())


def test_prepare_is_idempotent_and_does_not_start_exercise(sessionmaker, monkeypatch):
    from app.core.auth import TokenData
    from app.routers import drills_v2
    from fastapi import BackgroundTasks, HTTPException

    queued = []
    _patch(monkeypatch, "_queue_drill_provision", lambda *args: queued.append(args))

    async def case():
        async with sessionmaker() as db:
            db.add(
                auth_models.Scenario(
                    id=1,
                    name="prepare",
                    title="Prepare",
                    version=1,
                    difficulty="beginner",
                    duration_min=10,
                    tags=[],
                    authors=[],
                    spec={"spec": {"assets": []}},
                )
            )
            await db.flush()
            drill = await create_drill(db, title="Prepare", scenario_id=1)
            token = TokenData(sub="operator", role="lead", iat=0, exp=9999999999)
            tasks = BackgroundTasks()
            result = await drills_v2.prepare_drill_endpoint(drill.id, tasks, db, token)
            assert result["status"] == "scheduled"
            assert drill.actual_start_at is None
            await drills_v2.prepare_drill_endpoint(drill.id, tasks, db, token)
            assert len(queued) == 1
            with pytest.raises(HTTPException) as exc:
                await drills_v2.start_drill_endpoint(drill.id, db, token)
            assert exc.value.status_code == 409
            assert drill.actual_start_at is None

    _run(case())


@pytest.mark.parametrize("ready", [False, True])
def test_start_requires_fresh_readiness(sessionmaker, monkeypatch, ready):
    from unittest.mock import AsyncMock

    from app.core.auth import TokenData
    from app.routers import drills_v2
    from fastapi import HTTPException

    _patch(monkeypatch, "_refresh_drill_provision_state", AsyncMock(return_value={"errors": []}))
    probe = AsyncMock(
        return_value={
            "mood": "ready" if ready else "needs_attention",
            "checks": [],
            "checked_at": "now",
        }
    )
    _patch(monkeypatch, "_range_health", probe)

    async def case():
        async with sessionmaker() as db:
            db.add(
                auth_models.Scenario(
                    id=1,
                    name="start",
                    title="Start",
                    version=1,
                    difficulty="beginner",
                    duration_min=10,
                    tags=[],
                    authors=[],
                    spec={"spec": {"assets": []}},
                )
            )
            await db.flush()
            drill = await create_drill(
                db,
                title="Prepared",
                scenario_id=1,
                environment_config={"provision_status": "validation_failed"},
            )
            token = TokenData(sub="operator", role="lead", iat=0, exp=9999999999)
            if ready:
                result = await drills_v2.start_drill_endpoint(drill.id, db, token)
                assert result["status"] == "active"
                assert drill.actual_start_at is not None
            else:
                with pytest.raises(HTTPException) as exc:
                    await drills_v2.start_drill_endpoint(drill.id, db, token)
                assert exc.value.detail["code"] == "range_not_ready"
                assert drill.actual_start_at is None
            probe.assert_awaited_once()

    _run(case())


def test_readiness_requires_every_address_and_completed_setup(sessionmaker, monkeypatch):
    from unittest.mock import AsyncMock

    from app.routers import drills_v2

    _patch(monkeypatch, "_tcp_connect_ok", AsyncMock(return_value=(True, "reachable")))

    async def case():
        async with sessionmaker() as db:
            scenario = auth_models.Scenario(
                name="readiness",
                title="Readiness",
                version=1,
                difficulty="beginner",
                duration_min=10,
                tags=[],
                authors=[],
                spec={
                    "spec": {
                        "assets": [{"role": "desktop", "count": 2}],
                        "telemetry": {"sinks": [{"type": "wazuh"}]},
                        "validation": {
                            "probes": [
                                {
                                    "id": "desktop",
                                    "type": "tcp_connect",
                                    "role": "desktop",
                                    "port": 3389,
                                },
                                {"id": "telemetry", "type": "telemetry_declared"},
                            ]
                        },
                    }
                },
            )
            db.add(scenario)
            await db.flush()
            run = auth_models.Run(scenario_id=scenario.id, status=auth_models.RunStatus.RUNNING)
            db.add(run)
            await db.flush()
            assets = [
                auth_models.Asset(
                    run_id=run.id,
                    role=f"desktop_{i}",
                    template="desktop",
                    status=auth_models.AssetStatus.RUNNING,
                    pve_ip="10.0.0.1" if i == 1 else None,
                )
                for i in (1, 2)
            ]
            db.add_all(assets)
            drill = await create_drill(
                db,
                title="Health",
                scenario_id=scenario.id,
                environment_config={"provision_status": "starting", "provision_run_id": run.id},
            )
            health = await drills_v2._range_health(db, drill)
            checks = {check["id"]: check for check in health["checks"]}
            assert health["mood"] != "ready"
            assert checks["guest-setup"]["state"] != "ready"
            assert checks["desktop"]["state"] != "ready"
            assert checks["telemetry"]["required"] is False
            drill.environment_config = {
                **drill.environment_config,
                "provision_status": "validating",
            }
            assets[1].pve_ip = "10.0.0.2"
            await db.commit()
            assert (await drills_v2._range_health(db, drill))["mood"] == "ready"

    _run(case())


@pytest.fixture
def sessionmaker():
    async def _build():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(auth_models.User.__table__.create)
            await conn.run_sync(auth_models.Scenario.__table__.create)
            await conn.run_sync(auth_models.Run.__table__.create)
            await conn.run_sync(auth_models.Asset.__table__.create)
            for table in [
                m.Drill.__table__,
                m.DrillScenario.__table__,
                m.DrillParticipant.__table__,
                m.DrillEvent.__table__,
                m.DrillObjective.__table__,
                m.DrillFlag.__table__,
                m.DrillEnvironmentLock.__table__,
                m.DrillTeam.__table__,
                m.DrillRound.__table__,
                m.DrillScoreEvent.__table__,
                m.DrillTeamFlag.__table__,
            ]:
                await conn.run_sync(table.create)
        return engine, async_sessionmaker(bind=engine, expire_on_commit=False)

    engine, maker = _run(_build())
    try:
        yield maker
    finally:
        _run(engine.dispose())


def test_update_drill_persists_drill_type_for_web_edit_form(sessionmaker):
    async def _case():
        async with sessionmaker() as session:
            drill = await create_drill(
                session,
                title="Tabletop",
                drill_type="individual",
                duration_limit_minutes=60,
                max_participants=10,
            )

            await update_drill(session, drill.id, drill_type="team")
            reloaded = await get_drill(session, drill.id)
            assert reloaded is not None
            assert reloaded.drill_type == "team"

    _run(_case())


def test_update_drill_sanitizes_title_and_description(sessionmaker):
    async def _case():
        async with sessionmaker() as session:
            drill = await create_drill(session, title="Clean")

            await update_drill(
                session,
                drill.id,
                title="<script>alert(1)</script>Blue",
                description='<img src=x onerror="alert(2)">desc',
            )
            reloaded = await get_drill(session, drill.id)
            assert reloaded is not None
            assert "<script" not in reloaded.title.lower()
            assert "onerror" not in (reloaded.description or "").lower()
            assert reloaded.title == "Blue"

    _run(_case())


def test_update_drill_rejects_invalid_web_edit_values(sessionmaker):
    async def _case():
        async with sessionmaker() as session:
            drill = await create_drill(session, title="Guarded")

            with pytest.raises(ValueError, match="Invalid drill type"):
                await update_drill(session, drill.id, drill_type="purple")
            with pytest.raises(ValueError, match="Duration limit"):
                await update_drill(session, drill.id, duration_limit_minutes=0)
            with pytest.raises(ValueError, match="Max participants"):
                await update_drill(session, drill.id, max_participants=0)

    _run(_case())


def test_participants_endpoint_returns_auth_display_name(sessionmaker):
    async def _seed():
        async with sessionmaker() as session:
            user = auth_models.User(
                sub="blue.op",
                password_hash="test",
                role="blue",
            )
            session.add(user)
            await session.flush()
            drill = await create_drill(session, title="Roster")
            participant = m.DrillParticipant(
                drill_id=drill.id,
                user_id=user.id,
                role="blue",
                status="registered",
            )
            session.add(participant)
            await session.commit()
            return drill.id

    async def _override_session():
        async with sessionmaker() as session:
            yield session

    drill_id = _run(_seed())

    from app.main import app

    app.dependency_overrides[get_session] = _override_session
    try:
        client = TestClient(app)
        response = client.get(
            f"/api/v2/drills/{drill_id}/participants",
            headers={"X-Divide-Token": sign_token("admin", "admin", 3600)},
        )
    finally:
        app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 200, response.text
    row = response.json()["participants"][0]
    assert row["sub"] == "blue.op"
    assert row["username"] == "blue.op"


def test_link_scenario_updates_drill_run_scenario(sessionmaker):
    async def _case():
        async with sessionmaker() as session:
            scenario = auth_models.Scenario(
                name="first-live-drill",
                title="First Live Drill",
                version=1,
                difficulty="beginner",
                duration_min=10,
                tags=[],
                authors=[],
                spec={
                    "spec": {
                        "objectives": {
                            "red": ["Capture the service"],
                            "blue": ["Detect the intrusion"],
                        },
                        "assets": [],
                        "networks": [],
                        "flags": [
                            {
                                "id": "red-flag-file-server",
                                "value": "FLAG{rooted}",
                                "base_points": 250,
                                "decay_window_seconds": 900,
                            }
                        ],
                    }
                },
            )
            session.add(scenario)
            await session.flush()
            drill = await create_drill(session, title="Run me")

            await link_scenario(session, drill.id, scenario_id=scenario.id)
            reloaded = await get_drill(session, drill.id)
            objectives = (
                await session.execute(
                    m.DrillObjective.__table__.select().where(m.DrillObjective.drill_id == drill.id)
                )
            ).all()
            flags = (
                await session.execute(
                    m.DrillFlag.__table__.select().where(m.DrillFlag.drill_id == drill.id)
                )
            ).all()

            assert reloaded is not None
            assert reloaded.scenario_id == scenario.id
            assert len(objectives) == 2
            assert len(flags) == 1

    _run(_case())


def test_create_drill_seeds_objectives_and_flags_from_scenario(sessionmaker):
    async def _case():
        async with sessionmaker() as session:
            scenario = auth_models.Scenario(
                name="red-vs-blue-baseline",
                title="Red vs Blue Baseline",
                version=1,
                difficulty="beginner",
                duration_min=30,
                tags=[],
                authors=[],
                spec={
                    "spec": {
                        "objectives": {
                            "red": ["Own the file server"],
                            "blue": ["Identify the attacker"],
                        },
                        "assets": [],
                        "networks": [],
                        "flags": [
                            {
                                "id": "red-flag-file-server",
                                "value": "FLAG{rooted_file_server}",
                                "side": "red",
                                "planted_on_role": "file_server",
                                "base_points": 100,
                                "decay_window_seconds": 1800,
                            }
                        ],
                    }
                },
            )
            session.add(scenario)
            await session.flush()

            drill = await create_drill(
                session,
                title="Seeded Drill",
                scenario_id=scenario.id,
            )
            objectives = await session.execute(
                select(m.DrillObjective).where(m.DrillObjective.drill_id == drill.id)
            )
            flags = await session.execute(
                select(m.DrillFlag).where(m.DrillFlag.drill_id == drill.id)
            )
            links = await session.execute(
                select(m.DrillScenario).where(m.DrillScenario.drill_id == drill.id)
            )

            seeded_objectives = objectives.scalars().all()
            seeded_flags = flags.scalars().all()
            seeded_links = links.scalars().all()
            assert [o.side for o in seeded_objectives] == ["red", "blue"]
            assert [o.title for o in seeded_objectives] == [
                "Own the file server",
                "Identify the attacker",
            ]
            assert [link.scenario_id for link in seeded_links] == [scenario.id]
            assert seeded_flags[0].name == "red-flag-file-server"
            assert seeded_flags[0].value == "FLAG{rooted_file_server}"
            assert seeded_flags[0].points == 100
            assert drill.environment_config["scenario_seed"]["flags"] == 1

    _run(_case())


def test_link_scenario_endpoint_returns_catalog_identity(sessionmaker):
    async def _seed():
        async with sessionmaker() as session:
            scenario = auth_models.Scenario(
                name="phish-to-ransom",
                title="Phish to Ransom",
                version=1,
                difficulty="beginner",
                duration_min=20,
                tags=[],
                authors=[],
                spec={"spec": {"assets": [], "networks": []}},
            )
            session.add(scenario)
            await session.flush()
            drill = await create_drill(session, title="Link via HTTP")
            return drill.id, scenario.id

    async def _override_session():
        async with sessionmaker() as session:
            yield session

    drill_id, scenario_id = _run(_seed())

    from app.main import app

    app.dependency_overrides[get_session] = _override_session
    try:
        client = TestClient(app)
        response = client.post(
            f"/api/v2/drills/{drill_id}/scenarios",
            json={"scenario_id": scenario_id},
        )
        drill_body = client.get(f"/api/v2/drills/{drill_id}").json()
        scenarios_body = client.get(f"/api/v2/drills/{drill_id}/scenarios").json()
    finally:
        app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 200, response.text
    assert response.json()["scenario_id"] == scenario_id
    assert response.json()["link_id"]
    assert drill_body["scenario_id"] == scenario_id
    assert scenarios_body["scenarios"][0]["name"] == "phish-to-ransom"
    assert scenarios_body["scenarios"][0]["title"] == "Phish to Ransom"


def test_v2_prepare_provisions_without_starting_scenario_backed_drill(sessionmaker, monkeypatch):
    async def _seed():
        async with sessionmaker() as session:
            scenario = auth_models.Scenario(
                name="first-live-drill",
                title="First Live Drill",
                version=1,
                difficulty="beginner",
                duration_min=10,
                tags=[],
                authors=[],
                spec={"spec": {"assets": [], "networks": []}},
            )
            session.add(scenario)
            await session.flush()
            drill = await create_drill(
                session,
                title="Provisioned",
                scenario_id=scenario.id,
            )
            return drill.id, scenario.id

    async def _override_session():
        async with sessionmaker() as session:
            yield session

    class FakeRunResult:
        run_id = 321
        status = auth_models.RunStatus.RUNNING

    class FakeRunner:
        requests = []

        async def start_run(self, req, session):
            self.requests.append(req)
            return FakeRunResult()

    fake_runner = FakeRunner()
    drill_id, scenario_id = _run(_seed())

    from app.main import app

    app.dependency_overrides[get_session] = _override_session
    _patch(monkeypatch, "_get_runner", lambda: fake_runner)
    _patch(monkeypatch, "get_sessionmaker", lambda: sessionmaker)
    try:
        client = TestClient(app)
        response = client.post(
            f"/api/v2/drills/{drill_id}/prepare",
            headers={"X-Divide-Token": sign_token("operator", "lead", 60)},
        )
        body = client.get(f"/api/v2/drills/{drill_id}").json()
    finally:
        app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 200, response.text
    assert response.json()["provision_run_id"] is None
    assert response.json()["provision_status"] == "starting"
    assert fake_runner.requests[0].scenario_id == scenario_id
    assert body["status"] == "scheduled"
    assert body["actual_start_at"] is None
    assert fake_runner.requests[0].timeout_min == -1
    assert body["environment_config"]["provision_run_id"] == 321
    assert body["environment_config"]["provision_status"] == "validation_failed"


def test_v2_start_retries_failed_provision_for_active_drill(sessionmaker, monkeypatch):
    async def _seed():
        async with sessionmaker() as session:
            scenario = auth_models.Scenario(
                name="first-live-drill",
                title="First Live Drill",
                version=1,
                difficulty="beginner",
                duration_min=10,
                tags=[],
                authors=[],
                spec={"spec": {"assets": [], "networks": []}},
            )
            session.add(scenario)
            await session.flush()
            drill = await create_drill(
                session,
                title="Provision Retry",
                scenario_id=scenario.id,
            )
            drill.status = m.DrillStatus.ACTIVE
            drill.environment_config = {
                "provision_status": "failed",
                "provision_error": "PVE unreachable: lock timeout",
            }
            await session.commit()
            return drill.id, scenario.id

    async def _override_session():
        async with sessionmaker() as session:
            yield session

    class FakeRunResult:
        run_id = 654
        status = auth_models.RunStatus.RUNNING

    class FakeRunner:
        requests = []

        async def start_run(self, req, session):
            self.requests.append(req)
            return FakeRunResult()

    fake_runner = FakeRunner()
    drill_id, scenario_id = _run(_seed())

    from app.main import app

    app.dependency_overrides[get_session] = _override_session
    _patch(monkeypatch, "_get_runner", lambda: fake_runner)
    _patch(monkeypatch, "get_sessionmaker", lambda: sessionmaker)
    try:
        client = TestClient(app)
        response = client.post(
            f"/api/v2/drills/{drill_id}/prepare",
            headers={"X-Divide-Token": sign_token("operator", "lead", 60)},
        )
        body = client.get(f"/api/v2/drills/{drill_id}").json()
    finally:
        app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 200, response.text
    assert response.json()["message"] == "Provision retry started"
    assert fake_runner.requests[0].scenario_id == scenario_id
    assert body["status"] == "scheduled"
    assert body["actual_start_at"] is None
    assert body["environment_config"]["provision_run_id"] == 654
    assert body["environment_config"]["provision_status"] == "validation_failed"
    assert "lock timeout" not in body["environment_config"].get("provision_error", "")


def test_v2_status_refresh_updates_asset_state(sessionmaker, monkeypatch):
    async def _seed():
        async with sessionmaker() as session:
            scenario = auth_models.Scenario(
                name="watcher-scenario",
                title="Watcher Scenario",
                version=1,
                difficulty="beginner",
                duration_min=10,
                tags=[],
                authors=[],
                spec={"spec": {"assets": [], "networks": []}},
            )
            session.add(scenario)
            await session.flush()
            run = auth_models.Run(
                scenario_id=scenario.id,
                status=auth_models.RunStatus.RUNNING,
                started_at=datetime.now(UTC),
            )
            session.add(run)
            await session.flush()
            asset = auth_models.Asset(
                run_id=run.id,
                role="router_fw",
                template="tpl-debian-router",
                status=auth_models.AssetStatus.BOOTING,
                pve_vmid=9100,
                pve_node="pve",
            )
            session.add(asset)
            drill = await create_drill(
                session,
                title="Watcher Drill",
                scenario_id=scenario.id,
                environment_config={
                    "provision_run_id": run.id,
                    "provision_status": "starting",
                },
            )
            drill.status = m.DrillStatus.ACTIVE
            await session.commit()
            return drill.id, asset.id

    async def _override_session():
        async with sessionmaker() as session:
            yield session

    class FakeAdapter:
        async def get_vm_state(self, vmid, node):
            return VmState(
                vmid=vmid,
                node=node,
                name="divide-1-router",
                status="running",
                ip="10.20.10.1",
            )

    class FakeRunner:
        _adapter = FakeAdapter()

    drill_id, asset_id = _run(_seed())

    from app.main import app

    app.dependency_overrides[get_session] = _override_session
    _patch(monkeypatch, "_get_runner", lambda: FakeRunner())
    try:
        client = TestClient(app)
        response = client.get(f"/api/v2/drills/{drill_id}/status")
    finally:
        app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["lifecycle"]["provision_phase"] == "provisioning"
    assert body["environment_config"]["provision_status"] == "starting"
    assert body["provision"]["assets"][0]["status"] == "running"
    assert body["provision"]["assets"][0]["ip"] == "10.20.10.1"

    async def _check():
        async with sessionmaker() as session:
            asset = await session.get(auth_models.Asset, asset_id)
            assert asset.status == auth_models.AssetStatus.RUNNING
            assert asset.pve_ip == "10.20.10.1"

    _run(_check())


def test_v2_range_health_reports_human_readiness(sessionmaker, monkeypatch):
    async def _seed():
        async with sessionmaker() as session:
            scenario = auth_models.Scenario(
                name="health-scenario",
                title="Health Scenario",
                version=1,
                difficulty="beginner",
                duration_min=10,
                tags=[],
                authors=[],
                spec={
                    "spec": {
                        "objectives": {
                            "red": ["Reach the file server."],
                            "blue": ["Find the attacker."],
                        },
                        "assets": [{"role": "red_workstation"}],
                        "networks": [],
                        "flags": [
                            {
                                "id": "red-flag",
                                "value": "FLAG{x}",
                                "planted_on_role": "red_workstation",
                            }
                        ],
                        "validation": {
                            "probes": [
                                {
                                    "id": "red-ready",
                                    "label": "Red workstation is ready",
                                    "type": "role_running",
                                    "role": "red_workstation",
                                    "side": "red",
                                },
                                {
                                    "id": "flags-loaded",
                                    "label": "Flags are loaded",
                                    "type": "flag_seeded",
                                    "side": "shared",
                                },
                            ]
                        },
                    }
                },
            )
            session.add(scenario)
            await session.flush()
            run = auth_models.Run(
                scenario_id=scenario.id,
                status=auth_models.RunStatus.RUNNING,
                started_at=datetime.now(UTC),
            )
            session.add(run)
            await session.flush()
            session.add(
                auth_models.Asset(
                    run_id=run.id,
                    role="red_workstation",
                    template="tpl-kali-cloudinit",
                    status=auth_models.AssetStatus.RUNNING,
                    pve_vmid=9101,
                    pve_node="pve",
                    pve_ip="10.20.10.10",
                )
            )
            drill = await create_drill(
                session,
                title="Range Health",
                scenario_id=scenario.id,
                environment_config={
                    "provision_run_id": run.id,
                    "provision_status": "started",
                },
            )
            await create_drill_flag(
                session,
                drill.id,
                name="red-flag",
                value="FLAG{x}",
            )
            red = auth_models.User(
                sub="red.ready",
                password_hash="test",
                role="red",
            )
            blue = auth_models.User(
                sub="blue.ready",
                password_hash="test",
                role="blue",
            )
            session.add_all([red, blue])
            await session.flush()
            session.add_all(
                [
                    m.DrillParticipant(
                        drill_id=drill.id,
                        user_id=red.id,
                        role="red",
                        status="registered",
                    ),
                    m.DrillParticipant(
                        drill_id=drill.id,
                        user_id=blue.id,
                        role="blue",
                        status="registered",
                    ),
                ]
            )
            await session.commit()
            return drill.id

    async def _override_session():
        async with sessionmaker() as session:
            yield session

    class FakeAdapter:
        async def get_vm_state(self, vmid, node):
            return VmState(
                vmid=vmid,
                node=node,
                name="divide-1-red",
                status="running",
                ip="10.20.10.10",
            )

    class FakeRunner:
        _adapter = FakeAdapter()

    drill_id = _run(_seed())

    from app.main import app

    app.dependency_overrides[get_session] = _override_session
    _patch(monkeypatch, "_get_runner", lambda: FakeRunner())
    try:
        client = TestClient(app)
        response = client.get(f"/api/v2/drills/{drill_id}/range-health")
    finally:
        app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mood"] == "ready"
    assert body["summary"] == "The range is ready for play."
    assert body["counts"]["ready"] == body["counts"]["total"]
    assert {check["label"] for check in body["checks"]} == {
        "Red workstation is ready",
        "Flags are loaded",
        "Required teams are enrolled",
        "Guest setup completed",
        "All range machines are running",
    }


def test_v2_failed_provision_retry_cleans_previous_run_first(sessionmaker, monkeypatch):
    async def _seed():
        async with sessionmaker() as session:
            scenario = auth_models.Scenario(
                name="retry-cleanup-scenario",
                title="Retry Cleanup Scenario",
                version=1,
                difficulty="beginner",
                duration_min=10,
                tags=[],
                authors=[],
                spec={"spec": {"assets": [], "networks": []}},
            )
            session.add(scenario)
            await session.flush()
            drill = await create_drill(
                session,
                title="Retry Cleanup",
                scenario_id=scenario.id,
            )
            drill.status = m.DrillStatus.ACTIVE
            drill.environment_config = {
                "provision_status": "failed",
                "provision_error": "PVE rejected clone",
                "provision_run_id": 777,
            }
            await session.commit()
            return drill.id, scenario.id

    async def _override_session():
        async with sessionmaker() as session:
            yield session

    class FakeRunResult:
        run_id = 778
        status = auth_models.RunStatus.RUNNING

    class FakeRunner:
        calls = []

        async def stop_run(self, run_id, reason, session, actor):
            self.calls.append(("stop", run_id, actor))

        async def start_run(self, req, session):
            self.calls.append(("start", req.scenario_id, req.started_by))
            return FakeRunResult()

    fake_runner = FakeRunner()
    drill_id, scenario_id = _run(_seed())

    from app.main import app

    app.dependency_overrides[get_session] = _override_session
    _patch(monkeypatch, "_get_runner", lambda: fake_runner)
    _patch(monkeypatch, "get_sessionmaker", lambda: sessionmaker)
    try:
        client = TestClient(app)
        response = client.post(
            f"/api/v2/drills/{drill_id}/prepare",
            headers={"X-Divide-Token": sign_token("operator", "lead", 60)},
        )
        body = client.get(f"/api/v2/drills/{drill_id}").json()
    finally:
        app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 200, response.text
    assert fake_runner.calls[0] == ("stop", 777, "oxblood")
    assert fake_runner.calls[1] == ("start", scenario_id, "oxblood")
    assert "cleanup_status" not in body["environment_config"]
    assert body["environment_config"]["provision_run_id"] == 778
    assert body["environment_config"]["provision_status"] == "validation_failed"


@pytest.mark.parametrize(
    "status,expected", [(m.DrillStatus.ACTIVE, "completed"), (m.DrillStatus.SCHEDULED, "cancelled")]
)
def test_v2_stop_cleans_up_provision_run(sessionmaker, monkeypatch, status, expected):
    async def _seed():
        async with sessionmaker() as session:
            drill = await create_drill(session, title="Cleanup me")
            drill.status = status
            drill.environment_config = {
                "provision_status": "started",
                "provision_run_id": 777,
            }
            await session.commit()
            return drill.id

    async def _override_session():
        async with sessionmaker() as session:
            yield session

    class FakeRunner:
        calls = []

        async def stop_run(self, run_id, reason, session, actor):
            self.calls.append(
                {
                    "run_id": run_id,
                    "reason": reason,
                    "session": session,
                    "actor": actor,
                }
            )

    fake_runner = FakeRunner()
    drill_id = _run(_seed())

    from app.main import app

    app.dependency_overrides[get_session] = _override_session
    _patch(monkeypatch, "_get_runner", lambda: fake_runner)
    try:
        client = TestClient(app)
        response = client.post(
            f"/api/v2/drills/{drill_id}/stop",
            headers={"X-Divide-Token": sign_token("operator", "lead", 60)},
        )
        body = client.get(f"/api/v2/drills/{drill_id}").json()
    finally:
        app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 200, response.text
    assert response.json()["status"] == expected
    assert response.json()["cleanup_status"] == "stopped"
    assert len(fake_runner.calls) == 1
    assert fake_runner.calls[0]["run_id"] == 777
    assert fake_runner.calls[0]["reason"] == f"OxBlood drill {drill_id} stopped"
    assert fake_runner.calls[0]["actor"] == "oxblood"
    assert fake_runner.calls[0]["session"] is not None
    assert body["environment_config"]["cleanup_status"] == "stopped"
    assert body["environment_config"]["cleanup_run_id"] == 777


def test_cleanup_cancels_worker_and_uses_newest_run(sessionmaker, monkeypatch):
    async def _case():
        async with sessionmaker() as session:
            scenario = auth_models.Scenario(
                name="cleanup-race",
                title="Cleanup Race",
                version=1,
                difficulty="beginner",
                duration_min=10,
                tags=[],
                authors=[],
                spec={"spec": {"assets": []}},
            )
            session.add(scenario)
            await session.flush()
            drill = await create_drill(session, title="Cleanup race", scenario_id=scenario.id)
            drill.status = m.DrillStatus.CANCELLED
            drill.actual_start_at = datetime.now(UTC)
            drill.environment_config = {"provision_run_id": 238}
            old_run = auth_models.Run(
                scenario_id=scenario.id,
                status=auth_models.RunStatus.FAILED,
                started_by="test",
                started_at=drill.actual_start_at - timedelta(minutes=1),
            )
            new_run = auth_models.Run(
                scenario_id=scenario.id,
                status=auth_models.RunStatus.RUNNING,
                started_by="test",
                started_at=drill.actual_start_at + timedelta(seconds=1),
            )
            session.add_all([old_run, new_run])
            await session.flush()
            await session.commit()

            class FakeRunner:
                stopped = []

                async def stop_run(self, run_id, reason, session, actor):
                    self.stopped.append(run_id)

            fake_runner = FakeRunner()
            from app.routers import drills_v2

            _patch(monkeypatch, "_get_runner", lambda: fake_runner)
            _patch(monkeypatch, "get_sessionmaker", lambda: sessionmaker)
            job = drills_v2.ProvisionJob()

            async def _wait_for_cancel():
                await job.cancel_event.wait()

            job.task = asyncio.create_task(_wait_for_cancel())
            drills_v2._PROVISION_JOBS[drill.id] = job
            try:
                result = await drills_v2._stop_drill_provision_run(session, drill)
            finally:
                drills_v2._PROVISION_JOBS.pop(drill.id, None)

            assert result == "stopped"
            assert job.cancel_event.is_set()
            assert fake_runner.stopped == [new_run.id]
            await session.refresh(drill)
            assert drill.environment_config["cleanup_run_id"] == new_run.id

    _run(_case())


def test_v2_get_marks_overdue_active_drill_completed(sessionmaker):
    async def _seed():
        async with sessionmaker() as session:
            drill = await create_drill(
                session,
                title="Expired",
                duration_limit_minutes=1,
            )
            drill.status = m.DrillStatus.ACTIVE
            drill.actual_start_at = datetime.now(UTC) - timedelta(minutes=2)
            await session.commit()
            return drill.id

    async def _override_session():
        async with sessionmaker() as session:
            yield session

    drill_id = _run(_seed())

    from app.main import app

    app.dependency_overrides[get_session] = _override_session
    try:
        client = TestClient(app)
        response = client.get(f"/api/v2/drills/{drill_id}")
        events = client.get(f"/api/v2/drills/{drill_id}/timeline").json()
    finally:
        app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "completed"
    assert body["actual_end_at"] is not None
    assert body["environment_config"]["timeout_status"] == "reached"
    assert any(event["title"] == "Drill time limit reached" for event in events["events"])


def test_v2_console_requires_login_and_returns_allowed_ticket(sessionmaker, monkeypatch):
    async def _seed():
        async with sessionmaker() as session:
            scenario = auth_models.Scenario(
                name="access-test",
                title="Access Test",
                version=1,
                difficulty="beginner",
                duration_min=30,
                tags=[],
                authors=[],
                spec={
                    "spec": {
                        "assets": [{"role": "red_workstation", "networks": ["red_vlan"]}],
                        "networks": [{"name": "red_vlan", "cidr": "10.20.10.0/24"}],
                    }
                },
            )
            session.add(scenario)
            await session.flush()
            run = auth_models.Run(
                scenario_id=scenario.id,
                status=auth_models.RunStatus.RUNNING,
                started_at=datetime.now(UTC),
            )
            session.add(run)
            await session.flush()
            asset = auth_models.Asset(
                run_id=run.id,
                role="red_workstation",
                template="tpl-kali-cloudinit",
                status=auth_models.AssetStatus.RUNNING,
                pve_vmid=9001,
                pve_node="pve",
            )
            session.add(asset)
            drill = await create_drill(
                session,
                title="Console Access",
                scenario_id=scenario.id,
                environment_config={
                    "provision_run_id": run.id,
                    "provision_status": "started",
                },
            )
            drill.status = m.DrillStatus.ACTIVE
            user = auth_models.User(sub="red", password_hash="test", role="red")
            session.add(user)
            await session.flush()
            session.add(
                m.DrillParticipant(
                    drill_id=drill.id, user_id=user.id, role="red", status="registered"
                )
            )
            await session.commit()
            return drill.id, asset.id

    async def _override_session():
        async with sessionmaker() as session:
            yield session

    class FakeAdapter:
        calls = []

        async def create_console_ticket(self, vmid, node):
            self.calls.append((vmid, node))
            return ConsoleTicket(
                vmid=vmid,
                node=node,
                ticket="ticket-9001",
                port=5900,
                cert="cert",
                user="root@pam",
                launch_url="https://mock-pve/?console=kvm&novnc=1&vmid=9001&node=pve",
            )

    class FakeRunner:
        _adapter = FakeAdapter()

    drill_id, asset_id = _run(_seed())

    from app.core.auth import sign_token
    from app.main import app

    app.dependency_overrides[get_session] = _override_session
    _patch(monkeypatch, "_get_runner", lambda: FakeRunner())
    try:
        client = TestClient(app)
        anonymous = client.post(f"/api/v2/drills/{drill_id}/access/{asset_id}/console")
        token = sign_token(sub="red", role="red", ttl_s=600)
        response = client.post(
            f"/api/v2/drills/{drill_id}/access/{asset_id}/console",
            headers={"X-Divide-Token": token},
        )
        access = client.get(
            f"/api/v2/drills/{drill_id}/access",
            headers={"X-Divide-Token": token},
        )
    finally:
        app.dependency_overrides.pop(get_session, None)

    assert anonymous.status_code == 401
    assert response.status_code == 200, response.text
    assert access.status_code == 200, access.text
    body = response.json()
    access_body = access.json()
    assert body["ticket"] == "ticket-9001"
    assert body["vmid"] == 9001
    assert body["launch_url"].endswith("vmid=9001&node=pve")
    assert FakeRunner._adapter.calls == [(9001, "pve")]
    assert access_body["assets"][0]["networks"] == ["red_vlan"]
    assert access_body["assets"][0]["seeded"] is True
    assert access_body["assets"][0]["seed_status"] == "Seeded"


def test_v2_prepare_builds_one_range_copy_per_match_and_stop_removes_all(sessionmaker, monkeypatch):
    async def _seed():
        async with sessionmaker() as session:
            scenario = auth_models.Scenario(
                name="two-matches",
                title="Two Matches",
                version=1,
                difficulty="beginner",
                duration_min=10,
                tags=[],
                authors=[],
                spec={"spec": {"assets": [], "networks": []}},
            )
            session.add(scenario)
            await session.flush()
            drill = await create_drill(session, title="Matches", scenario_id=scenario.id)
            drill.environment_config = {"match_mode": "separate"}
            for position, match in enumerate((1, 2, 1, 2), start=1):
                session.add(
                    m.DrillTeam(
                        drill_id=drill.id,
                        name=f"T{position}",
                        position=position,
                        match_number=match,
                    )
                )
            await session.commit()
            return drill.id

    async def _override_session():
        async with sessionmaker() as session:
            yield session

    class FakeRunResult:
        def __init__(self, run_id):
            self.run_id = run_id
            self.status = auth_models.RunStatus.RUNNING

    class FakeRunner:
        def __init__(self):
            self.requests = []
            self.stopped = []

        async def start_run(self, req, session):
            self.requests.append(req)
            return FakeRunResult(320 + req.instance)

        async def stop_run(self, run_id, reason, session, actor):
            self.stopped.append(run_id)

    fake_runner = FakeRunner()
    drill_id = _run(_seed())

    from app.main import app

    app.dependency_overrides[get_session] = _override_session
    _patch(monkeypatch, "_get_runner", lambda: fake_runner)
    _patch(monkeypatch, "get_sessionmaker", lambda: sessionmaker)
    try:
        client = TestClient(app)
        response = client.post(
            f"/api/v2/drills/{drill_id}/prepare",
            headers={"X-Divide-Token": sign_token("operator", "lead", 60)},
        )
        env = client.get(f"/api/v2/drills/{drill_id}").json()["environment_config"]
    finally:
        app.dependency_overrides.pop(get_session, None)

    assert response.status_code == 200, response.text
    assert [r.instance for r in fake_runner.requests] == [1, 2]
    assert env["provision_run_id"] == 321 and env["match_runs"] == {"2": 322}

    async def _stop():
        from app.routers import drills_v2

        async with sessionmaker() as session:
            drill = await session.get(m.Drill, drill_id)
            return await drills_v2._stop_drill_provision_run(session, drill)

    assert _run(_stop()) == "stopped"
    assert sorted(fake_runner.stopped) == [321, 322]
