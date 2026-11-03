"""Competition teams, rounds, side swap, score ledger and the frozen scoreboard."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from app.db.models import User
from app.db.models_drill import (
    Drill,
    DrillParticipant,
    DrillRound,
    DrillScoreEvent,
    DrillTeam,
)
from app.services import teams as svc
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def db_factory(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'teams.sqlite'}")
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
            ):
                await conn.run_sync(table.create)
        async with maker() as db:
            db.add(Drill(title="Competition", max_participants=20))
            for name in ("ana", "ben", "cy", "dee"):
                db.add(User(sub=name, password_hash="x", role="red"))
            await db.commit()
            for uid in (1, 2, 3, 4):
                db.add(DrillParticipant(drill_id=1, user_id=uid, role="red", status="registered"))
            await db.commit()

    run(setup())
    yield maker
    run(engine.dispose())


def test_ensure_teams_is_idempotent_and_names_them(db_factory):
    async def go():
        async with db_factory() as db:
            first = await svc.ensure_teams(db, 1, 4)
            again = await svc.ensure_teams(db, 1, 4)
            return first, again

    first, again = run(go())
    assert [t.name for t in first] == ["Alpha", "Bravo", "Charlie", "Delta"]
    assert [t.id for t in first] == [t.id for t in again]


def test_team_count_is_bounded(db_factory):
    async def go():
        async with db_factory() as db:
            with pytest.raises(svc.TeamError):
                await svc.ensure_teams(db, 1, 1)
            with pytest.raises(svc.TeamError):
                await svc.ensure_teams(db, 1, 99)

    run(go())


def test_assign_requires_enrollment_and_a_team_of_this_drill(db_factory):
    async def go():
        async with db_factory() as db:
            teams = await svc.ensure_teams(db, 1, 4)
            await svc.assign_member(db, 1, 1, teams[0].id)
            with pytest.raises(svc.TeamError):
                await svc.assign_member(db, 1, 99, teams[0].id)  # not enrolled
            with pytest.raises(svc.TeamError):
                await svc.assign_member(db, 1, 1, 9999)  # unknown team
            members = await svc.members_by_team(db, 1)
            await svc.assign_member(db, 1, 1, None)  # remove
            return members, await svc.members_by_team(db, 1)

    before, after = run(go())
    assert [m["sub"] for m in before[1]] == ["ana"]
    assert after == {}


def test_rename_rejects_duplicates_and_blanks(db_factory):
    async def go():
        async with db_factory() as db:
            teams = await svc.ensure_teams(db, 1, 4)
            await svc.update_team(db, 1, teams[0].id, name="Falcons", color=None)
            with pytest.raises(svc.TeamError):
                await svc.update_team(db, 1, teams[1].id, name="Falcons", color=None)
            with pytest.raises(svc.TeamError):
                await svc.update_team(db, 1, teams[1].id, name="   ", color=None)

    run(go())


def test_swap_assignments_flip_each_round():
    r1 = svc.plan_assignments([1, 2, 3, 4], 1)
    r2 = svc.plan_assignments([1, 2, 3, 4], 2)
    assert [r1[str(i)]["side"] for i in (1, 2, 3, 4)] == ["red", "red", "blue", "blue"]
    assert [r2[str(i)]["side"] for i in (1, 2, 3, 4)] == ["blue", "blue", "red", "red"]
    with pytest.raises(svc.TeamError):
        svc.plan_assignments([1, 2, 3], 1)  # odd team count cannot be split evenly


def test_rounds_run_in_order_one_at_a_time(db_factory):
    async def go():
        async with db_factory() as db:
            await svc.ensure_teams(db, 1, 4)
            rounds = await svc.plan_rounds(db, 1, 2)
            with pytest.raises(svc.TeamError):
                await svc.start_round(db, 1, 2)  # round 1 first
            await svc.start_round(db, 1, 1)
            with pytest.raises(svc.TeamError):
                await svc.start_round(db, 1, 2)  # round 1 still running
            with pytest.raises(svc.TeamError):
                await svc.plan_rounds(db, 1, 3)  # cannot re-plan after a start
            await svc.finish_round(db, 1, 1)
            await svc.start_round(db, 1, 2)
            return [r.number for r in rounds], (await svc.active_round(db, 1)).number

    numbers, active = run(go())
    assert numbers == [1, 2] and active == 2


def test_effective_side_follows_the_round_and_swaps(db_factory):
    async def go():
        async with db_factory() as db:
            teams = await svc.ensure_teams(db, 1, 4)
            await svc.assign_member(db, 1, 1, teams[0].id)  # Alpha: red then blue
            await svc.assign_member(db, 1, 3, teams[2].id)  # Charlie: blue then red
            await svc.plan_rounds(db, 1, 2)
            idle = await svc.effective_side(db, 1, 1)
            await svc.start_round(db, 1, 1)
            r1 = (await svc.effective_side(db, 1, 1), await svc.effective_side(db, 1, 3))
            await svc.finish_round(db, 1, 1)
            await svc.start_round(db, 1, 2)
            r2 = (await svc.effective_side(db, 1, 1), await svc.effective_side(db, 1, 3))
            no_team = await svc.effective_side(db, 1, 2)
            return idle, r1, r2, no_team

    idle, r1, r2, no_team = run(go())
    assert idle is None  # no running round: callers fall back to the enrolled side
    assert r1 == ("red", "blue")
    assert r2 == ("blue", "red")
    assert no_team is None  # a player without a team keeps their enrolled side


def test_penalties_always_subtract_and_unknown_kinds_are_rejected(db_factory):
    async def go():
        async with db_factory() as db:
            await svc.ensure_teams(db, 1, 4)
            event = await svc.add_score_event(
                db, 1, kind="penalty", points=50, reason="broke DNS", team_id=1
            )
            with pytest.raises(svc.TeamError):
                await svc.add_score_event(db, 1, kind="bonus-ish", points=5)
            return event.points

    assert run(go()) == -50


def test_scoreboard_totals_per_round_and_tie_break(db_factory):
    async def go():
        async with db_factory() as db:
            teams = await svc.ensure_teams(db, 1, 4)
            await svc.plan_rounds(db, 1, 2)
            rounds = await svc.list_rounds(db, 1)
            a, b, c = teams[0].id, teams[1].id, teams[2].id
            await svc.add_score_event(
                db, 1, kind="flag", points=100, team_id=a, user_id=1, round_id=rounds[0].id
            )
            await svc.add_score_event(
                db, 1, kind="flag", points=100, team_id=b, user_id=2, round_id=rounds[0].id
            )
            await svc.add_score_event(
                db, 1, kind="flag", points=40, team_id=a, user_id=1, round_id=rounds[1].id
            )
            await svc.add_score_event(
                db,
                1,
                kind="penalty",
                points=-10,
                reason="rule break",
                team_id=a,
                round_id=rounds[1].id,
            )
            await svc.add_score_event(
                db,
                1,
                kind="award",
                points=30,
                reason="clear report",
                team_id=c,
                round_id=rounds[1].id,
            )
            return await svc.scoreboard(db, 1, privileged=False), rounds

    board, rounds = run(go())
    by_name = {t["name"]: t for t in board["teams"]}
    assert by_name["Alpha"]["total"] == 130
    assert by_name["Alpha"]["by_round"] == {str(rounds[0].id): 100, str(rounds[1].id): 30}
    assert board["teams"][0]["name"] == "Alpha" and board["teams"][0]["rank"] == 1
    assert by_name["Bravo"]["total"] == 100 and by_name["Charlie"]["total"] == 30
    assert by_name["Delta"]["total"] == 0
    assert {p["name"] for p in board["players"]} == {"ana", "ben"}


def test_equal_scores_are_ranked_by_who_got_there_first(db_factory):
    async def go():
        async with db_factory() as db:
            teams = await svc.ensure_teams(db, 1, 4)
            now = datetime.now(UTC)
            late = await svc.add_score_event(db, 1, kind="flag", points=100, team_id=teams[0].id)
            early = await svc.add_score_event(db, 1, kind="flag", points=100, team_id=teams[1].id)
            late.created_at = now
            early.created_at = now - timedelta(minutes=5)
            await db.commit()
            return await svc.scoreboard(db, 1, privileged=False)

    board = run(go())
    assert [t["name"] for t in board["teams"][:2]] == ["Bravo", "Alpha"]


def test_freeze_hides_late_points_from_the_public_until_the_round_ends(db_factory):
    async def go():
        async with db_factory() as db:
            teams = await svc.ensure_teams(db, 1, 4)
            await svc.plan_rounds(db, 1, 2)
            rnd = (await svc.list_rounds(db, 1))[0]
            await svc.start_round(db, 1, 1)
            now = datetime.now(UTC)
            await svc.set_freeze(db, 1, 1, now - timedelta(minutes=10))
            before = await svc.add_score_event(
                db, 1, kind="flag", points=100, team_id=teams[0].id, round_id=rnd.id
            )
            after = await svc.add_score_event(
                db, 1, kind="flag", points=50, team_id=teams[0].id, round_id=rnd.id
            )
            before.created_at = now - timedelta(minutes=20)
            after.created_at = now - timedelta(minutes=2)
            await db.commit()
            public = await svc.scoreboard(db, 1, privileged=False, now=now)
            referee = await svc.scoreboard(db, 1, privileged=True, now=now)
            await svc.finish_round(db, 1, 1)
            revealed = await svc.scoreboard(db, 1, privileged=False, now=now)
            return public, referee, revealed

    public, referee, revealed = run(go())
    assert public["frozen"] is True and public["teams"][0]["total"] == 100
    assert referee["frozen"] is False and referee["teams"][0]["total"] == 150
    assert revealed["frozen"] is False and revealed["teams"][0]["total"] == 150


def test_captain_is_elected_moved_and_must_be_a_member(db_factory):
    async def go():
        async with db_factory() as db:
            alpha, bravo = (await svc.ensure_teams(db, 1, 2))[:2]
            await svc.assign_member(db, 1, 2, alpha.id)
            await svc.assign_member(db, 1, 3, alpha.id)
            assert (
                alpha.captain_user_id == 2
            )  # first member is elected, a later one does not change it

            await svc.assign_member(
                db, 1, 2, bravo.id
            )  # the captain leaves: the next member takes over
            assert alpha.captain_user_id == 3 and bravo.captain_user_id == 2

            with pytest.raises(svc.TeamError):
                await svc.set_captain(db, 1, alpha.id, 2)  # not in Alpha any more
            await svc.assign_member(db, 1, 1, alpha.id)
            await svc.set_captain(db, 1, alpha.id, 1)
            assert alpha.captain_user_id == 1

            await svc.assign_member(db, 1, 1, None)
            await svc.assign_member(db, 1, 3, None)
            assert alpha.captain_user_id is None  # an empty team has no captain

    run(go())
