"""Competition endpoints: permissions, team and round workflow, referee ledger, frozen board."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from app.core.auth import sign_token
from app.db.models import User
from app.db.models_drill import (
    Drill,
    DrillEvent,
    DrillParticipant,
    DrillRound,
    DrillScoreEvent,
    DrillTeam,
)
from app.db.session import get_session
from app.routers.drills_v2.competition import router
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def api(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'comp.sqlite'}")
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def setup():
        async with engine.begin() as conn:
            for table in (
                User.__table__,
                Drill.__table__,
                DrillTeam.__table__,
                DrillParticipant.__table__,
                DrillRound.__table__,
                DrillScoreEvent.__table__,
                DrillEvent.__table__,
            ):
                await conn.run_sync(table.create)
        async with maker() as db:
            db.add(Drill(title="Competition", max_participants=20))
            for name, role in (("ana", "red"), ("ben", "blue"), ("outsider", "red")):
                db.add(User(sub=name, password_hash="x", role=role))
            await db.commit()
            for uid, role in ((1, "red"), (2, "blue")):
                db.add(DrillParticipant(drill_id=1, user_id=uid, role=role, status="registered"))
            await db.commit()

    run(setup())
    app = FastAPI()
    app.include_router(router, prefix="/api/v2/drills")

    async def test_session():
        async with maker() as db:
            yield db

    app.dependency_overrides[get_session] = test_session
    with TestClient(app) as client:
        yield client, maker
    run(engine.dispose())


def tok(sub, role):
    return {"X-Divide-Token": sign_token(sub, role, 3600)}


# Tokens are signed when used: another test may change the signing key after import.
def ref():
    return tok("referee", "lead")


def ana():  # enrolled player
    return tok("ana", "red")


def outsider():  # has an account, not enrolled
    return tok("outsider", "red")


def setup_four_teams(client):
    r = client.post("/api/v2/drills/1/teams", json={"count": 4}, headers=ref())
    assert r.status_code == 200, r.text
    return r.json()["teams"]


def test_only_referees_can_change_things_and_players_only_read_their_drill(api):
    client, _ = api
    assert (
        client.post("/api/v2/drills/1/teams", json={"count": 4}, headers=ana()).status_code == 403
    )
    assert client.post("/api/v2/drills/1/score-events", json={}, headers=ana()).status_code == 403
    setup_four_teams(client)
    assert client.get("/api/v2/drills/1/scoreboard").status_code == 401
    assert client.get("/api/v2/drills/1/scoreboard", headers=outsider()).status_code == 403
    assert client.get("/api/v2/drills/1/scoreboard", headers=ana()).status_code == 200
    assert client.get("/api/v2/drills/99/teams", headers=ref()).status_code == 404


def test_team_setup_assignment_and_visibility(api):
    client, _ = api
    teams = setup_four_teams(client)
    assert [t["name"] for t in teams] == ["Alpha", "Bravo", "Charlie", "Delta"]
    alpha = teams[0]["id"]
    assert client.put(f"/api/v2/drills/1/teams/{alpha}/members/1", headers=ref()).status_code == 200
    assert (
        client.put(f"/api/v2/drills/1/teams/{alpha}/members/3", headers=ref()).status_code == 409
    )  # not enrolled
    renamed = client.put(f"/api/v2/drills/1/teams/{alpha}", json={"name": "Falcons"}, headers=ref())
    assert renamed.json()["name"] == "Falcons"

    referee_view = {
        t["name"]: t for t in client.get("/api/v2/drills/1/teams", headers=ref()).json()["teams"]
    }
    assert [m["sub"] for m in referee_view["Falcons"]["members"]] == ["ana"]
    # A player sees every team's name and size, but only their own team's members.
    player_view = {
        t["name"]: t for t in client.get("/api/v2/drills/1/teams", headers=ana()).json()["teams"]
    }
    assert player_view["Falcons"]["member_count"] == 1
    assert [m["sub"] for m in player_view["Falcons"]["members"]] == ["ana"]
    assert player_view["Bravo"]["members"] == []

    assert (
        client.delete(f"/api/v2/drills/1/teams/{alpha}/members/1", headers=ref()).status_code == 200
    )
    assert (
        client.delete(f"/api/v2/drills/1/teams/{alpha}/members/1", headers=ref()).status_code == 404
    )


def test_rounds_flow_and_the_swap_shows_in_my_team(api):
    client, _ = api
    teams = setup_four_teams(client)
    alpha, charlie = teams[0]["id"], teams[2]["id"]
    client.put(f"/api/v2/drills/1/teams/{alpha}/members/1", headers=ref())
    client.put(f"/api/v2/drills/1/teams/{charlie}/members/2", headers=ref())

    plan = client.post("/api/v2/drills/1/rounds/plan", json={"rounds": 2}, headers=ref())
    assert [r["status"] for r in plan.json()["rounds"]] == ["pending", "pending"]
    assert client.post("/api/v2/drills/1/rounds/2/start", headers=ref()).status_code == 409
    started = client.post("/api/v2/drills/1/rounds/1/start", headers=ref())
    assert started.status_code == 200
    assert started.json()["flag_rotation"]["status"] == "skipped"  # no range prepared in this test
    assert client.post("/api/v2/drills/1/rounds/2/start", headers=ref()).status_code == 409
    mine = client.get("/api/v2/drills/1/my-team", headers=ana()).json()
    assert (
        mine["team"]["name"] == "Alpha" and mine["side"] == "red" and mine["round"]["number"] == 1
    )
    assert client.post("/api/v2/drills/1/rounds/1/finish", headers=ref()).status_code == 200
    assert client.post("/api/v2/drills/1/rounds/2/start", headers=ref()).status_code == 200
    assert client.get("/api/v2/drills/1/my-team", headers=ana()).json()["side"] == "blue"  # swapped
    assert client.post("/api/v2/drills/1/rounds/9/start", headers=ref()).status_code == 404


def test_referee_score_changes_need_a_reason_and_a_valid_team(api):
    client, _ = api
    teams = setup_four_teams(client)
    alpha = teams[0]["id"]
    base = {"team_id": alpha, "points": 25, "kind": "award"}
    assert (
        client.post(
            "/api/v2/drills/1/score-events", json={**base, "reason": ""}, headers=ref()
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v2/drills/1/score-events",
            json={**base, "reason": "ok", "kind": "flag"},
            headers=ref(),
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v2/drills/1/score-events",
            json={**base, "reason": "great write-up", "points": 0},
            headers=ref(),
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v2/drills/1/score-events",
            json={**base, "reason": "great write-up", "team_id": 999},
            headers=ref(),
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/api/v2/drills/1/score-events",
            json={**base, "reason": "great write-up"},
            headers=ref(),
        ).status_code
        == 201
    )
    penalty = client.post(
        "/api/v2/drills/1/score-events",
        json={**base, "kind": "penalty", "reason": "killed the shared DNS"},
        headers=ref(),
    )
    assert penalty.status_code == 201 and penalty.json()["points"] == -25

    events = client.get("/api/v2/drills/1/score-events", headers=ref()).json()["events"]
    assert [e["created_by"] for e in events] == ["referee", "referee"]
    assert (
        client.get("/api/v2/drills/1/score-events", headers=ana()).status_code == 403
    )  # ledger is referee-only
    board = client.get("/api/v2/drills/1/scoreboard", headers=ref()).json()
    assert {t["name"]: t["total"] for t in board["teams"]}["Alpha"] == 0  # +25 then -25


def test_frozen_board_hides_late_points_from_players_but_not_referees(api):
    client, maker = api
    teams = setup_four_teams(client)
    alpha = teams[0]["id"]
    client.post("/api/v2/drills/1/rounds/plan", json={"rounds": 2}, headers=ref())
    client.post("/api/v2/drills/1/rounds/1/start", headers=ref())
    freeze = datetime.now(UTC) - timedelta(minutes=5)
    assert (
        client.put(
            "/api/v2/drills/1/rounds/1/freeze",
            json={"freeze_at": freeze.isoformat()},
            headers=ref(),
        ).status_code
        == 200
    )
    client.post(
        "/api/v2/drills/1/score-events",
        json={"team_id": alpha, "points": 80, "reason": "late capture"},
        headers=ref(),
    )

    player = client.get("/api/v2/drills/1/scoreboard", headers=ana()).json()
    referee = client.get("/api/v2/drills/1/scoreboard", headers=ref()).json()
    assert (
        player["frozen"] is True and {t["name"]: t["total"] for t in player["teams"]}["Alpha"] == 0
    )
    assert (
        referee["frozen"] is False
        and {t["name"]: t["total"] for t in referee["teams"]}["Alpha"] == 80
    )
    client.post("/api/v2/drills/1/rounds/1/finish", headers=ref())
    revealed = client.get("/api/v2/drills/1/scoreboard", headers=ana()).json()
    assert (
        revealed["frozen"] is False
        and {t["name"]: t["total"] for t in revealed["teams"]}["Alpha"] == 80
    )


def test_responses_do_not_grow_spurious_null_fields(api):
    client, _ = api
    setup_four_teams(client)
    team = client.get("/api/v2/drills/1/teams", headers=ref()).json()["teams"][0]
    assert set(team) == {
        "id",
        "name",
        "color",
        "position",
        "captain_user_id",
        "match_number",
        "member_count",
        "members",
    }


def _set_env(maker, **env):
    async def go():
        async with maker() as db:
            drill = await db.get(Drill, 1)
            drill.environment_config = {**(drill.environment_config or {}), **env}
            await db.commit()

    run(go())


@pytest.fixture
def reset_calls(monkeypatch, api):
    """Replace the background reset (it uses the global sessionmaker) with a recorder."""
    from app.routers.drills_v2 import competition

    _, maker = api
    calls = []

    async def fake_set(drill_id, status, error=None):
        async with maker() as db:
            drill = await db.get(Drill, drill_id)
            drill.environment_config = {
                **(drill.environment_config or {}),
                "range_reset": {"status": status, "error": error},
            }
            await db.commit()

    async def fake_background(drill_id, run_id):
        calls.append((drill_id, run_id))

    monkeypatch.setattr(competition, "_set_range_reset", fake_set)
    monkeypatch.setattr(competition, "_reset_range_background", fake_background)
    return calls


def test_range_reset_needs_a_prepared_range_and_no_running_round(api, reset_calls):
    client, maker = api
    assert client.post("/api/v2/drills/1/range/reset", headers=ana()).status_code == 403
    assert client.post("/api/v2/drills/1/range/reset", headers=ref()).status_code == 409

    _set_env(maker, provision_run_id=7)
    for name in ("A", "B"):
        client.post("/api/v2/drills/1/teams", json={"name": name}, headers=ref())
    client.post("/api/v2/drills/1/rounds/plan", json={"rounds": 2}, headers=ref())
    client.post("/api/v2/drills/1/rounds/1/start", headers=ref())
    assert client.post("/api/v2/drills/1/range/reset", headers=ref()).status_code == 409
    assert reset_calls == []


def test_next_round_waits_for_a_healthy_range(api, reset_calls):
    client, maker = api
    _set_env(maker, provision_run_id=7)
    for name in ("A", "B"):
        client.post("/api/v2/drills/1/teams", json={"name": name}, headers=ref())
    client.post("/api/v2/drills/1/rounds/plan", json={"rounds": 2}, headers=ref())
    client.post("/api/v2/drills/1/rounds/1/start", headers=ref())
    client.post("/api/v2/drills/1/rounds/1/finish", headers=ref())

    reset = client.post("/api/v2/drills/1/range/reset", headers=ref())
    assert reset.status_code == 202
    assert reset_calls == [(1, [7])]
    assert client.get("/api/v2/drills/1/rounds", headers=ref()).json()["range_reset"]["status"] == (
        "resetting"
    )
    assert client.post("/api/v2/drills/1/range/reset", headers=ref()).status_code == 409
    assert client.post("/api/v2/drills/1/rounds/2/start", headers=ref()).status_code == 409

    _set_env(maker, range_reset={"status": "failed", "error": "RED01 not running"})
    blocked = client.post("/api/v2/drills/1/rounds/2/start", headers=ref())
    assert blocked.status_code == 409 and "RED01 not running" in blocked.json()["detail"]

    _set_env(maker, range_reset={"status": "ready", "error": None})
    assert client.post("/api/v2/drills/1/rounds/2/start", headers=ref()).status_code == 200


def test_teams_are_paired_into_matches_and_the_mode_is_chosen_before_a_range_exists(api):
    client, maker = api
    teams = setup_four_teams(client)
    assert [t["match_number"] for t in teams] == [1, 2, 1, 2]  # Alpha+Charlie, Bravo+Delta

    assert (
        client.put("/api/v2/drills/1/matches", json={"mode": "x"}, headers=ref()).status_code == 422
    )
    assert (
        client.put("/api/v2/drills/1/matches", json={"mode": "separate"}, headers=ana()).status_code
        == 403
    )
    ok = client.put("/api/v2/drills/1/matches", json={"mode": "separate"}, headers=ref())
    assert ok.json() == {"mode": "separate", "matches": 2}

    _set_env(maker, provision_run_id=5)
    late = client.put("/api/v2/drills/1/matches", json={"mode": "shared"}, headers=ref())
    assert late.status_code == 409  # a range already exists
