"""Competition teams, rounds and the scoreboard.

A drill can have several named teams. Which side (red or blue) a team plays is decided per
round, so a two-round "swap" competition lets every team attack once and defend once. Points
are an append-only ledger (``drill_score_events``); team and player scores are sums over it.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User
from app.db.models_drill import (
    DrillParticipant,
    DrillRound,
    DrillScoreEvent,
    DrillTeam,
)

# Default team names and colors; enough for the largest drill we expect.
TEAM_PALETTE = [
    ("Alpha", "#e5484d"),
    ("Bravo", "#3e63dd"),
    ("Charlie", "#30a46c"),
    ("Delta", "#f5a524"),
    ("Echo", "#8e4ec6"),
    ("Foxtrot", "#12a594"),
]
MAX_TEAMS = len(TEAM_PALETTE)
SIDES = ("red", "blue")
KINDS = {"flag", "first_blood", "objective", "detection", "report", "award", "penalty"}


class TeamError(ValueError):
    """A request that cannot be honored (wrong state, unknown team, ...)."""


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


# --- teams ------------------------------------------------------------------


async def list_teams(db: AsyncSession, drill_id: int) -> list[DrillTeam]:
    rows = await db.execute(
        select(DrillTeam).where(DrillTeam.drill_id == drill_id).order_by(DrillTeam.position)
    )
    return list(rows.scalars().all())


async def ensure_teams(db: AsyncSession, drill_id: int, count: int = 4) -> list[DrillTeam]:
    """Create teams up to ``count`` (idempotent: existing teams are kept)."""
    if not 2 <= count <= MAX_TEAMS:
        raise TeamError(f"A drill needs between 2 and {MAX_TEAMS} teams.")
    teams = await list_teams(db, drill_id)
    taken = {t.position for t in teams}
    for position in range(1, count + 1):
        if position in taken:
            continue
        name, color = TEAM_PALETTE[position - 1]
        db.add(DrillTeam(drill_id=drill_id, name=name, color=color, position=position))
    await db.flush()
    teams = await list_teams(db, drill_id)
    from app.services.matches import pair_matches  # local: matches imports the drill models too

    pair_matches(teams)
    await db.commit()
    return teams


async def get_team(db: AsyncSession, drill_id: int, team_id: int) -> DrillTeam:
    team = await db.get(DrillTeam, team_id)
    if team is None or team.drill_id != drill_id:
        raise TeamError("Team not found in this drill.")
    return team


async def update_team(
    db: AsyncSession, drill_id: int, team_id: int, *, name: str | None, color: str | None
) -> DrillTeam:
    team = await get_team(db, drill_id, team_id)
    if name is not None:
        cleaned = name.strip()
        if not cleaned:
            raise TeamError("A team needs a name.")
        clash = await db.execute(
            select(DrillTeam.id).where(
                DrillTeam.drill_id == drill_id, DrillTeam.name == cleaned, DrillTeam.id != team_id
            )
        )
        if clash.first() is not None:
            raise TeamError("Another team already has that name.")
        team.name = cleaned
    if color is not None:
        team.color = color.strip() or None
    await db.commit()
    return team


async def assign_member(
    db: AsyncSession, drill_id: int, user_id: int, team_id: int | None
) -> DrillParticipant:
    """Put an enrolled player in a team (or take them out with ``team_id=None``)."""
    if team_id is not None:
        await get_team(db, drill_id, team_id)
    row = await db.execute(
        select(DrillParticipant).where(
            DrillParticipant.drill_id == drill_id, DrillParticipant.user_id == user_id
        )
    )
    participant = row.scalar_one_or_none()
    if participant is None or participant.status in {"removed", "left"}:
        raise TeamError("That player is not enrolled in this drill.")
    previous = participant.drill_team_id
    participant.drill_team_id = team_id
    await db.flush()
    for tid in {previous, team_id} - {None}:
        team = await db.get(DrillTeam, tid)
        if team is not None and await team_captain(db, team) is None:
            await elect_captain(db, team)
    await db.commit()
    return participant


async def _active_member_ids(db: AsyncSession, team: DrillTeam) -> list[int]:
    rows = await db.execute(
        select(DrillParticipant.user_id)
        .where(
            DrillParticipant.drill_id == team.drill_id,
            DrillParticipant.drill_team_id == team.id,
            DrillParticipant.status.notin_(["removed", "left"]),
        )
        .order_by(DrillParticipant.user_id)
    )
    return list(rows.scalars().all())


async def team_captain(db: AsyncSession, team: DrillTeam) -> int | None:
    """The captain, only while they are still an active member (a stale one counts as none)."""
    if team.captain_user_id is None:
        return None
    return (
        team.captain_user_id if team.captain_user_id in await _active_member_ids(db, team) else None
    )


async def elect_captain(db: AsyncSession, team: DrillTeam) -> int | None:
    """Make the lowest-numbered active member captain, or clear it when the team is empty."""
    members = await _active_member_ids(db, team)
    team.captain_user_id = members[0] if members else None
    return team.captain_user_id


async def set_captain(db: AsyncSession, drill_id: int, team_id: int, user_id: int) -> DrillTeam:
    team = await get_team(db, drill_id, team_id)
    if user_id not in await _active_member_ids(db, team):
        raise TeamError("The captain must be a member of the team.")
    team.captain_user_id = user_id
    await db.commit()
    return team


async def members_by_team(db: AsyncSession, drill_id: int) -> dict[int, list[dict[str, Any]]]:
    rows = await db.execute(
        select(DrillParticipant, User.sub)
        .join(User, User.id == DrillParticipant.user_id)
        .where(
            DrillParticipant.drill_id == drill_id,
            DrillParticipant.drill_team_id.is_not(None),
            DrillParticipant.status.notin_(["removed", "left"]),
        )
        .order_by(User.sub)
    )
    out: dict[int, list[dict[str, Any]]] = {}
    for participant, sub in rows.all():
        if participant.drill_team_id is None:
            continue
        out.setdefault(participant.drill_team_id, []).append(
            {"user_id": participant.user_id, "sub": sub}
        )
    return out


# --- rounds -----------------------------------------------------------------


def plan_assignments(team_ids: list[int], round_number: int) -> dict[str, dict[str, str]]:
    """Which side each team plays. The first half of the teams is red in odd rounds."""
    if len(team_ids) < 2 or len(team_ids) % 2:
        raise TeamError("A swap competition needs an even number of teams (2, 4 or 6).")
    half = len(team_ids) // 2
    first, second = ("red", "blue") if round_number % 2 else ("blue", "red")
    return {str(tid): {"side": first if i < half else second} for i, tid in enumerate(team_ids)}


async def list_rounds(db: AsyncSession, drill_id: int) -> list[DrillRound]:
    rows = await db.execute(
        select(DrillRound).where(DrillRound.drill_id == drill_id).order_by(DrillRound.number)
    )
    return list(rows.scalars().all())


async def plan_rounds(db: AsyncSession, drill_id: int, rounds: int = 2) -> list[DrillRound]:
    """(Re)create the schedule. Refused once any round has started."""
    if not 1 <= rounds <= 6:
        raise TeamError("Plan between 1 and 6 rounds.")
    existing = await list_rounds(db, drill_id)
    if any(r.status != "pending" for r in existing):
        raise TeamError("Rounds cannot be re-planned after one has started.")
    teams = await list_teams(db, drill_id)
    team_ids = [t.id for t in teams]
    for old in existing:
        await db.delete(old)
    await db.flush()
    for number in range(1, rounds + 1):
        db.add(
            DrillRound(
                drill_id=drill_id,
                number=number,
                name=f"Round {number}",
                status="pending",
                assignments=plan_assignments(team_ids, number),
            )
        )
    await db.commit()
    return await list_rounds(db, drill_id)


async def active_round(db: AsyncSession, drill_id: int) -> DrillRound | None:
    row = await db.execute(
        select(DrillRound).where(DrillRound.drill_id == drill_id, DrillRound.status == "active")
    )
    return row.scalar_one_or_none()


async def _round(db: AsyncSession, drill_id: int, number: int) -> DrillRound:
    row = await db.execute(
        select(DrillRound).where(DrillRound.drill_id == drill_id, DrillRound.number == number)
    )
    found = row.scalar_one_or_none()
    if found is None:
        raise TeamError(f"Round {number} not found.")
    return found


async def start_round(db: AsyncSession, drill_id: int, number: int) -> DrillRound:
    target = await _round(db, drill_id, number)
    if target.status != "pending":
        raise TeamError(f"Round {number} is already {target.status}.")
    if await active_round(db, drill_id) is not None:
        raise TeamError("Another round is still running. Finish it first.")
    earlier = [r for r in await list_rounds(db, drill_id) if r.number < number]
    if any(r.status != "finished" for r in earlier):
        raise TeamError("Finish the earlier rounds first.")
    target.status = "active"
    target.started_at = datetime.now(UTC)
    await db.commit()
    return target


async def finish_round(db: AsyncSession, drill_id: int, number: int) -> DrillRound:
    target = await _round(db, drill_id, number)
    if target.status != "active":
        raise TeamError(f"Round {number} is not running.")
    target.status = "finished"
    target.ended_at = datetime.now(UTC)
    await db.commit()
    return target


async def set_freeze(
    db: AsyncSession, drill_id: int, number: int, freeze_at: datetime | None
) -> DrillRound:
    target = await _round(db, drill_id, number)
    target.freeze_at = freeze_at
    await db.commit()
    return target


def side_for_team(round_: DrillRound | None, team_id: int | None) -> str | None:
    if round_ is None or team_id is None:
        return None
    entry = (round_.assignments or {}).get(str(team_id))
    return entry.get("side") if isinstance(entry, dict) else None


async def effective_side(db: AsyncSession, drill_id: int, user_id: int) -> str | None:
    """The side a player plays right now: their team's side in the running round, else None.

    ``None`` means "no competition in progress" and callers fall back to the player's
    enrolled side (``drill_participants.role``), which is how non-team drills work.
    """
    current = await active_round(db, drill_id)
    if current is None:
        return None
    row = await db.execute(
        select(DrillParticipant.drill_team_id).where(
            DrillParticipant.drill_id == drill_id, DrillParticipant.user_id == user_id
        )
    )
    return side_for_team(current, row.scalar_one_or_none())


# --- score ledger -----------------------------------------------------------


async def add_score_event(
    db: AsyncSession,
    drill_id: int,
    *,
    kind: str,
    points: int,
    reason: str = "",
    team_id: int | None = None,
    user_id: int | None = None,
    round_id: int | None = None,
    flag_id: int | None = None,
    created_by: str | None = None,
    commit: bool = True,
) -> DrillScoreEvent:
    if kind not in KINDS:
        raise TeamError(f"Unknown score kind {kind!r}.")
    if kind == "penalty" and points > 0:
        points = -points  # penalties always subtract, whatever sign the caller used
    event = DrillScoreEvent(
        drill_id=drill_id,
        round_id=round_id,
        team_id=team_id,
        user_id=user_id,
        kind=kind,
        points=points,
        reason=reason,
        flag_id=flag_id,
        created_by=created_by,
    )
    db.add(event)
    if commit:
        await db.commit()
    else:
        await db.flush()
    return event


async def list_score_events(db: AsyncSession, drill_id: int, limit: int = 200) -> list[dict]:
    rows = await db.execute(
        select(DrillScoreEvent)
        .where(DrillScoreEvent.drill_id == drill_id)
        .order_by(DrillScoreEvent.id.desc())
        .limit(limit)
    )
    return [
        {
            "id": e.id,
            "round_id": e.round_id,
            "team_id": e.team_id,
            "user_id": e.user_id,
            "kind": e.kind,
            "points": e.points,
            "reason": e.reason,
            "flag_id": e.flag_id,
            "created_by": e.created_by,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in rows.scalars().all()
    ]


def _visible(event: DrillScoreEvent, rounds: dict[int, DrillRound], privileged: bool) -> bool:
    """A frozen round hides events after its freeze time from the public until it finishes."""
    if privileged or event.round_id is None:
        return True
    round_ = rounds.get(event.round_id)
    freeze = _utc(round_.freeze_at) if round_ else None
    if round_ is None or freeze is None or round_.status == "finished":
        return True
    created = _utc(event.created_at)
    return created is None or created <= freeze


async def scoreboard(
    db: AsyncSession, drill_id: int, *, privileged: bool, now: datetime | None = None
) -> dict[str, Any]:
    """Team and player standings. ``privileged`` viewers (referees) see through any freeze."""
    now = now or datetime.now(UTC)
    teams = await list_teams(db, drill_id)
    rounds = await list_rounds(db, drill_id)
    rounds_by_id = {r.id: r for r in rounds}
    events = (
        (await db.execute(select(DrillScoreEvent).where(DrillScoreEvent.drill_id == drill_id)))
        .scalars()
        .all()
    )
    shown = [e for e in events if _visible(e, rounds_by_id, privileged)]
    frozen = not privileged and any(
        (freeze := _utc(r.freeze_at)) is not None and freeze <= now and r.status != "finished"
        for r in rounds
    )

    members = await members_by_team(db, drill_id)
    names = {
        u.id: u.sub
        for u in (
            await db.execute(
                select(User).where(User.id.in_({e.user_id for e in shown if e.user_id}))
            )
        )
        .scalars()
        .all()
    }

    team_rows: dict[int, dict[str, Any]] = {
        t.id: {
            "team_id": t.id,
            "name": t.name,
            "color": t.color,
            "position": t.position,
            "members": len(members.get(t.id, [])),
            "total": 0,
            "by_round": {},
            "last_scored_at": None,
        }
        for t in teams
    }
    players: dict[int, dict[str, Any]] = {}
    for event in shown:
        if event.team_id in team_rows:
            row = team_rows[event.team_id]
            row["total"] += event.points
            key = str(event.round_id) if event.round_id is not None else "none"
            row["by_round"][key] = row["by_round"].get(key, 0) + event.points
            if event.points > 0:
                stamp = _utc(event.created_at)
                if stamp and (row["last_scored_at"] is None or stamp > row["last_scored_at"]):
                    row["last_scored_at"] = stamp
        if event.user_id:
            p = players.setdefault(
                event.user_id,
                {
                    "user_id": event.user_id,
                    "name": names.get(event.user_id),
                    "team_id": None,
                    "total": 0,
                },
            )
            p["total"] += event.points
            if event.team_id:
                p["team_id"] = event.team_id

    # Ties go to the team that reached its score first.
    ordered = sorted(
        team_rows.values(),
        key=lambda r: (-r["total"], r["last_scored_at"] or datetime.max.replace(tzinfo=UTC)),
    )
    for rank, row in enumerate(ordered, start=1):
        row["rank"] = rank
        row["last_scored_at"] = row["last_scored_at"].isoformat() if row["last_scored_at"] else None

    return {
        "frozen": frozen,
        "rounds": [
            {
                "id": r.id,
                "number": r.number,
                "name": r.name,
                "status": r.status,
                "freeze_at": freeze.isoformat() if (freeze := _utc(r.freeze_at)) else None,
                "assignments": r.assignments,
            }
            for r in rounds
        ],
        "teams": ordered,
        "players": sorted(players.values(), key=lambda p: -p["total"]),
    }
