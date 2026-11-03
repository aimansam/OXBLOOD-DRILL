"""Separate matches: teams that play each other share one range copy.

Default is one shared range for everybody (``match_mode`` unset or ``shared``): behaviour is exactly
as before. With ``separate`` the teams are paired (team 1 with team 1 + half, ...; the same pairs the
side swap uses) and each pair gets its own range copy, so a flag or a backdoor on one range cannot
help a team on another. Copy 1 is the drill's primary run (``provision_run_id``); copies 2.. live in
``environment_config["match_runs"]``.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import TokenData
from app.db.models import User
from app.db.models_drill import Drill, DrillParticipant, DrillTeam
from app.modules.drills.lifecycle import provision_run_id

MODE_KEY = "match_mode"
RUNS_KEY = "match_runs"


def is_separate(drill: Any) -> bool:
    return (drill.environment_config or {}).get(MODE_KEY) == "separate"


def match_count(teams: list[DrillTeam]) -> int:
    return max((t.match_number for t in teams), default=1)


def pair_matches(teams: list[DrillTeam]) -> None:
    """Pair team i with team i + half; with two teams there is a single match."""
    ordered = sorted(teams, key=lambda t: t.position)
    half = max(1, len(ordered) // 2)
    for index, team in enumerate(ordered):
        team.match_number = index % half + 1


def run_ids(drill: Any) -> dict[int, int]:
    """Match number -> run id for every copy that has been provisioned."""
    env = drill.environment_config or {}
    out: dict[int, int] = {}
    primary = provision_run_id(drill)
    if primary is not None:
        out[1] = primary
    for number, run_id in (env.get(RUNS_KEY) or {}).items():
        try:
            out[int(number)] = int(run_id)
        except (TypeError, ValueError):
            continue
    return out


async def team_of_user(db: AsyncSession, drill_id: int, user_id: int) -> DrillTeam | None:
    team_id = (
        await db.execute(
            select(DrillParticipant.drill_team_id).where(
                DrillParticipant.drill_id == drill_id, DrillParticipant.user_id == user_id
            )
        )
    ).scalar_one_or_none()
    return await db.get(DrillTeam, team_id) if team_id is not None else None


async def match_for_viewer(
    db: AsyncSession, drill: Drill, token: TokenData | None, requested: int | None = None
) -> int:
    """Which range copy this viewer sees. Operators may ask for any; players get their team's."""
    if not is_separate(drill):
        return 1
    if token is not None and str(token.role or "").lower() in {"admin", "lead", "observer"}:
        return requested or 1
    if token is None:
        return 1
    uid = (await db.execute(select(User.id).where(User.sub == token.sub))).scalar_one_or_none()
    team = await team_of_user(db, drill.id, uid) if uid is not None else None
    return team.match_number if team is not None else 1


async def run_id_for_viewer(
    db: AsyncSession, drill: Drill, token: TokenData | None, requested: int | None = None
) -> int | None:
    return run_ids(drill).get(await match_for_viewer(db, drill, token, requested))
