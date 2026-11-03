"""Flag submission in a team competition, plus the multi-flag fix for classic drills."""

from __future__ import annotations

import asyncio

import pytest
from app.core.auth import sign_token
from app.db.base import Base
from app.db.models import User
from app.db.models_drill import Drill, DrillFlag, DrillParticipant
from app.db.session import get_session
from app.routers.drills_v2.competition import router as competition_router
from app.routers.submissions_v2 import router as submissions_router
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def run(coro):
    return asyncio.run(coro)


RED_FLAG, BLUE_FLAG, OPEN_FLAG = "FLAG{red_one}", "FLAG{blue_one}", "FLAG{open_one}"


@pytest.fixture
def world(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'flags.sqlite'}")
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with maker() as db:
            db.add(Drill(title="Competition", max_participants=20))
            for name, role in (("ana", "red"), ("ben", "blue"), ("cy", "red"), ("dee", "red")):
                db.add(User(sub=name, password_hash="x", role=role))
            await db.commit()
            for uid, role in ((1, "red"), (2, "blue"), (3, "red"), (4, "red")):
                db.add(DrillParticipant(drill_id=1, user_id=uid, role=role, status="registered"))
            db.add_all(
                [
                    DrillFlag(
                        drill_id=1, name="red-foothold", value=RED_FLAG, points=100, sort_order=1
                    ),
                    DrillFlag(
                        drill_id=1, name="blue-source", value=BLUE_FLAG, points=80, sort_order=2
                    ),
                    DrillFlag(
                        drill_id=1, name="shared-note", value=OPEN_FLAG, points=40, sort_order=3
                    ),
                ]
            )
            await db.commit()

    run(setup())
    app = FastAPI()
    app.include_router(submissions_router)
    app.include_router(competition_router, prefix="/api/v2/drills")

    async def test_session():
        async with maker() as db:
            yield db

    app.dependency_overrides[get_session] = test_session
    with TestClient(app) as client:
        yield client, maker
    run(engine.dispose())


def player(sub, role):
    return {"X-Divide-Token": sign_token(sub, role, 3600)}


# Signed on use (not at import): another test may change the signing key in between.
class _User:
    def __init__(self, sub, role):
        self.sub, self.role = sub, role

    def __call__(self):
        return player(self.sub, self.role)


ANA, BEN, CY, DEE = (
    _User("ana", "red"),
    _User("ben", "blue"),
    _User("cy", "red"),
    _User("dee", "red"),
)
REF = _User("referee", "lead")


def submit(client, headers, value):
    return client.post(
        "/api/v2/submissions?user_id=0",
        json={"drill_id": 1, "lab_flag_id": 0, "flag_value": value, "hints_used": 0},
        headers=headers(),
    )


def test_classic_drills_match_the_value_against_every_flag(world):
    client, _ = world
    # Before: only the first flag could ever be correct.
    second = submit(client, ANA, BLUE_FLAG)
    assert second.status_code == 200 and second.json()["is_correct"] is True
    assert submit(client, ANA, "FLAG{nope}").json()["is_correct"] is False


def start_competition(client, maker):
    teams = client.post("/api/v2/drills/1/teams", json={"count": 4}, headers=REF()).json()["teams"]
    alpha, bravo, charlie = teams[0]["id"], teams[1]["id"], teams[2]["id"]
    for user_id, team in ((1, alpha), (3, alpha), (4, bravo), (2, charlie)):
        assert (
            client.put(
                f"/api/v2/drills/1/teams/{team}/members/{user_id}", headers=REF()
            ).status_code
            == 200
        )
    client.post("/api/v2/drills/1/rounds/plan", json={"rounds": 2}, headers=REF())
    return teams


def totals(client):
    board = client.get("/api/v2/drills/1/scoreboard", headers=REF()).json()
    return {t["name"]: t["total"] for t in board["teams"]}


def test_team_scoring_dedupe_first_blood_and_side_rules(world):
    client, maker = world
    start_competition(client, maker)

    # Nothing scores before the referee starts a round.
    assert submit(client, ANA, RED_FLAG).status_code == 409
    client.post("/api/v2/drills/1/rounds/1/start", headers=REF())

    first = submit(client, ANA, RED_FLAG).json()  # Alpha is red in round 1
    assert first["is_correct"] and first["points_earned"] == 100
    assert first["first_blood"] is True and first["first_blood_bonus"] == 25
    assert totals(client)["Alpha"] == 125

    again = submit(client, ANA, RED_FLAG).json()  # same player, same flag
    teammate = submit(client, CY, RED_FLAG).json()  # a teammate, same flag
    assert again["already_captured"] and again["points_earned"] == 0
    assert teammate["already_captured"] and teammate["points_earned"] == 0
    assert totals(client)["Alpha"] == 125  # no double scoring

    rival = submit(client, DEE, RED_FLAG).json()  # Bravo is also red: scores, but not first
    assert rival["is_correct"] and rival["points_earned"] == 100 and rival["first_blood"] is False
    assert totals(client)["Bravo"] == 100

    wrong_side = submit(client, BEN, RED_FLAG).json()  # Charlie is blue this round
    assert wrong_side["is_correct"] is False and "red flag" in wrong_side["message"]
    blue = submit(client, BEN, BLUE_FLAG).json()
    assert blue["is_correct"] and blue["points_earned"] == 80
    assert totals(client)["Charlie"] == 80 + 20

    open_flag = submit(client, ANA, OPEN_FLAG).json()  # flags without a side suit anyone
    assert open_flag["is_correct"] and open_flag["points_earned"] == 40


def test_swapped_round_lets_the_other_side_score_again(world):
    client, maker = world
    start_competition(client, maker)
    client.post("/api/v2/drills/1/rounds/1/start", headers=REF())
    assert submit(client, ANA, RED_FLAG).json()["is_correct"]
    assert submit(client, BEN, BLUE_FLAG).json()["is_correct"]
    client.post("/api/v2/drills/1/rounds/1/finish", headers=REF())
    client.post("/api/v2/drills/1/rounds/2/start", headers=REF())

    # Alpha is now blue and Charlie red: their old flags are the wrong side, the others open up.
    swapped_red = submit(client, BEN, RED_FLAG).json()  # Charlie is red in round 2
    assert swapped_red["is_correct"] and swapped_red["first_blood"] is True  # first in *this* round
    blocked = submit(client, ANA, RED_FLAG).json()  # Alpha is blue now
    assert blocked["is_correct"] is False
    assert submit(client, ANA, BLUE_FLAG).json()["is_correct"] is True
    board = client.get("/api/v2/drills/1/scoreboard", headers=REF()).json()
    alpha = next(t for t in board["teams"] if t["name"] == "Alpha")
    assert len(alpha["by_round"]) == 2  # points in both rounds, summed in the total


def test_guessing_is_rate_limited(world):
    client, maker = world
    start_competition(client, maker)
    client.post("/api/v2/drills/1/rounds/1/start", headers=REF())
    statuses = [submit(client, ANA, f"FLAG{{guess{i}}}").status_code for i in range(12)]
    assert statuses[:10] == [200] * 10
    assert statuses[10:] == [429, 429]


def test_a_player_without_a_team_keeps_the_classic_path(world):
    client, maker = world
    teams = client.post("/api/v2/drills/1/teams", json={"count": 4}, headers=REF()).json()["teams"]
    assert teams  # teams exist, but nobody is in one
    result = submit(client, ANA, RED_FLAG).json()
    assert result["is_correct"] is True and "team" not in result


def test_only_the_blue_captain_submits_and_a_referee_can_change_it(world):
    client, maker = world
    teams = start_competition(client, maker)
    charlie = teams[2]["id"]
    client.put(f"/api/v2/drills/1/teams/{charlie}/members/4", headers=REF())  # dee joins Charlie
    client.post("/api/v2/drills/1/rounds/1/start", headers=REF())  # Charlie is blue

    assert submit(client, DEE, BLUE_FLAG).status_code == 403  # ben was elected first
    assert submit(client, BEN, BLUE_FLAG).json()["points_earned"] == 80

    swap = client.put(
        f"/api/v2/drills/1/teams/{charlie}/captain", json={"user_id": 4}, headers=REF()
    )
    assert swap.status_code == 200
    assert submit(client, BEN, "FLAG{any}").status_code == 403
    assert submit(client, DEE, "FLAG{any}").status_code == 200
    bad = client.put(
        f"/api/v2/drills/1/teams/{charlie}/captain", json={"user_id": 1}, headers=REF()
    )
    assert bad.status_code == 409

    # Red is not restricted: every member of Alpha may submit.
    assert submit(client, CY, RED_FLAG).status_code == 200


def test_an_earlier_rounds_flag_is_named_as_such(world):
    import asyncio

    from app.db.models_drill import Drill
    from app.services.flag_rotation import derive_flag_value

    client, maker = world
    start_competition(client, maker)

    async def set_seed():
        async with maker() as db:
            drill = await db.get(Drill, 1)
            drill.environment_config = {"flag_seed": "s3cret"}
            await db.commit()

    asyncio.run(set_seed())
    client.post("/api/v2/drills/1/rounds/1/start", headers=REF())
    client.post("/api/v2/drills/1/rounds/1/finish", headers=REF())
    client.post("/api/v2/drills/1/rounds/2/start", headers=REF())

    old = derive_flag_value("s3cret", 1, "red-foothold")
    result = submit(client, BEN, old).json()  # Charlie is red in round 2
    assert result["is_correct"] is False and "earlier round" in result["message"]


def test_separate_matches_score_only_the_teams_own_value_and_report_sharing(world):
    import asyncio

    from app.db.models_drill import Drill, DrillTeamFlag

    client, maker = world
    start_competition(client, maker)  # Alpha+Charlie are match 1, Bravo is match 2

    async def configure():
        async with maker() as db:
            drill = await db.get(Drill, 1)
            drill.environment_config = {"match_mode": "separate"}
            db.add_all(
                [
                    DrillTeamFlag(
                        drill_id=1,
                        round_number=1,
                        team_id=1,
                        flag_name="red-foothold",
                        value="FLAG{alpha}",
                    ),
                    DrillTeamFlag(
                        drill_id=1,
                        round_number=1,
                        team_id=2,
                        flag_name="red-foothold",
                        value="FLAG{bravo}",
                    ),
                ]
            )
            await db.commit()

    asyncio.run(configure())
    client.post("/api/v2/drills/1/rounds/1/start", headers=REF())

    # The scenario's original value no longer works for a team that has its own.
    assert submit(client, ANA, RED_FLAG).json()["is_correct"] is False
    own = submit(client, ANA, "FLAG{alpha}").json()
    assert own["is_correct"] and own["points_earned"] == 100

    # Bravo hands in Alpha's value: no points, and the referees get a ledger note.
    shared = submit(client, DEE, "FLAG{alpha}").json()
    assert shared["is_correct"] is False and "another team" in shared["message"]
    ledger = client.get("/api/v2/drills/1/score-events", headers=REF()).json()["events"]
    assert any(
        e["kind"] == "report" and "sharing" in e["reason"] and e["points"] == 0 for e in ledger
    )

    assert submit(client, DEE, "FLAG{bravo}").json()["is_correct"] is True
    # Open flags (no machine, no per-team value) still work from the scenario value.
    assert submit(client, ANA, OPEN_FLAG).json()["is_correct"] is True
