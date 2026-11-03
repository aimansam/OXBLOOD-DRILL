"""Flag submission for competition drills (teams and rounds).

The classic path (``submission_service.submit_flag``) is per player and compares against a
single flag. A competition needs more: match the submitted value against *all* of the drill's
flags, only let a team score flags of the side it plays this round, score each flag once per
team per round, give the first team a bonus, and slow down guessing. Points go to the ledger
(``drill_score_events``), so team totals, referee changes and disputes all share one record.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models_drill import (
    Drill,
    DrillFlag,
    DrillFlagSubmission,
    DrillParticipant,
    DrillRound,
    DrillScoreEvent,
    DrillTeam,
    Submission,
    SubmissionStatus,
)
from app.services import teams as team_service
from app.services.flag_rotation import earlier_round_values
from app.services.submission_service import calculate_flag_points, calculate_time_decay

ATTEMPTS_PER_MINUTE = 10
FIRST_BLOOD_FRACTION = 4  # bonus = points // 4 (25%)


class CompetitionError(Exception):
    """A submission that must be refused, with the HTTP status it deserves."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class TeamContext:
    drill_id: int
    user_id: int
    team_id: int
    round: DrillRound
    side: str


def flag_side(flag: DrillFlag) -> str | None:
    """Scenarios name flags ``red-...`` / ``blue-...``; anything else is open to both sides."""
    name = str(flag.name or "").lower()
    if name.startswith("red-"):
        return "red"
    if name.startswith("blue-"):
        return "blue"
    return None


async def team_context(db: AsyncSession, drill_id: int, user_id: int) -> TeamContext | None:
    """The player's competition context, or ``None`` when this is not a team competition.

    A player on a team while no round is running cannot score: that is a clear 409 rather
    than silently falling back to the classic, unscored-by-team path.
    """
    row = await db.execute(
        select(DrillParticipant.drill_team_id).where(
            DrillParticipant.drill_id == drill_id, DrillParticipant.user_id == user_id
        )
    )
    team_id = row.scalar_one_or_none()
    if team_id is None:
        return None
    current = await team_service.active_round(db, drill_id)
    if current is None:
        raise CompetitionError(409, "No round is running. Wait for the referee to start one.")
    side = team_service.side_for_team(current, team_id)
    if side is None:
        raise CompetitionError(409, "Your team is not part of the running round.")
    return TeamContext(drill_id, user_id, team_id, current, side)


async def _recent_attempts(db: AsyncSession, drill_id: int, user_id: int, now: datetime) -> int:
    since = now - timedelta(seconds=60)
    count = await db.execute(
        select(func.count(Submission.id)).where(
            Submission.drill_id == drill_id,
            Submission.user_id == user_id,
            Submission.submitted_at >= since,
        )
    )
    return int(count.scalar() or 0)


async def submit_team_flag(
    db: AsyncSession, ctx: TeamContext, *, flag_value: str, hints_used: int = 0
) -> dict[str, Any]:
    now = datetime.now(UTC)
    if ctx.side == "blue":
        team = await db.get(DrillTeam, ctx.team_id)
        captain = await team_service.team_captain(db, team) if team else None
        if captain is not None and captain != ctx.user_id:
            raise CompetitionError(403, "Only your team captain submits for Blue.")
    if await _recent_attempts(db, ctx.drill_id, ctx.user_id, now) >= ATTEMPTS_PER_MINUTE:
        raise CompetitionError(429, "Too many attempts. Wait a moment before trying again.")

    flags = list(
        (
            await db.execute(
                select(DrillFlag)
                .where(DrillFlag.drill_id == ctx.drill_id)
                .order_by(DrillFlag.sort_order, DrillFlag.id)
            )
        )
        .scalars()
        .all()
    )
    if not flags:
        raise CompetitionError(409, "This drill has no flags yet.")
    submitted = flag_value.strip()
    matched = next((f for f in flags if f.value.strip() == submitted), None)

    message = None
    scoring = matched
    if matched is not None:
        owner = flag_side(matched)
        if owner is not None and owner != ctx.side:
            scoring = None
            message = f"That is a {owner} flag; your team plays {ctx.side} this round."
    if matched is None:
        env = (await db.get(Drill, ctx.drill_id)).environment_config or {}  # type: ignore[union-attr]
        seed = env.get("flag_seed")
        if seed and any(
            submitted in earlier_round_values(seed, ctx.round.number, f.name) for f in flags
        ):
            message = "That flag is from an earlier round and no longer scores."
    attach_to = matched or flags[0]  # a wrong guess is recorded against some flag for the audit

    already = None
    if scoring is not None:
        already = (
            await db.execute(
                select(DrillScoreEvent.id).where(
                    DrillScoreEvent.drill_id == ctx.drill_id,
                    DrillScoreEvent.round_id == ctx.round.id,
                    DrillScoreEvent.team_id == ctx.team_id,
                    DrillScoreEvent.flag_id == scoring.id,
                    DrillScoreEvent.kind == "flag",
                )
            )
        ).first()

    is_correct = scoring is not None
    points = 0
    decay = 1.0
    if scoring is not None and already is None:
        started = team_service._utc(ctx.round.started_at) or now
        decay = calculate_time_decay(
            int((now - started).total_seconds()), scoring.decay_window_seconds
        )
        points = calculate_flag_points(scoring, decay, hints_used)

    submission = Submission(
        user_id=ctx.user_id,
        drill_id=ctx.drill_id,
        team_id=ctx.team_id,  # legacy int column, kept as an audit hint (no FK)
        submission_type="flag",
        status=SubmissionStatus.CORRECT if is_correct else SubmissionStatus.INCORRECT,
    )
    db.add(submission)
    await db.flush()
    attempts = (
        await db.execute(
            select(func.count(DrillFlagSubmission.id)).where(
                DrillFlagSubmission.lab_flag_id == attach_to.id
            )
        )
    ).scalar() or 0
    db.add(
        DrillFlagSubmission(
            submission_id=submission.id,
            lab_flag_id=attach_to.id,
            flag_value=flag_value,
            is_correct=is_correct,
            points_earned=points,
            time_decay_factor=decay,
            attempt_number=int(attempts) + 1,
            hints_used=hints_used,
        )
    )

    first_blood = False
    bonus = 0
    if scoring is not None and already is None and points > 0:
        await team_service.add_score_event(
            db,
            ctx.drill_id,
            kind="flag",
            points=points,
            reason=f"Captured {scoring.name}",
            team_id=ctx.team_id,
            user_id=ctx.user_id,
            round_id=ctx.round.id,
            flag_id=scoring.id,
            commit=False,
        )
        taken = (
            await db.execute(
                select(DrillScoreEvent.id).where(
                    DrillScoreEvent.drill_id == ctx.drill_id,
                    DrillScoreEvent.round_id == ctx.round.id,
                    DrillScoreEvent.flag_id == scoring.id,
                    DrillScoreEvent.kind == "first_blood",
                )
            )
        ).first()
        if taken is None:
            first_blood = True
            bonus = max(1, points // FIRST_BLOOD_FRACTION)
            await team_service.add_score_event(
                db,
                ctx.drill_id,
                kind="first_blood",
                points=bonus,
                reason=f"First team to capture {scoring.name}",
                team_id=ctx.team_id,
                user_id=ctx.user_id,
                round_id=ctx.round.id,
                flag_id=scoring.id,
                commit=False,
            )
    await db.commit()

    team = await db.get(DrillTeam, ctx.team_id)
    return {
        "submission_id": submission.id,
        "is_correct": is_correct,
        "points_earned": points,
        "first_blood_bonus": bonus,
        "first_blood": first_blood,
        "already_captured": already is not None,
        "objective_completed": False,
        "objective_id": scoring.objective_id if scoring else None,
        "team": team.name if team else None,
        "round": ctx.round.number,
        "message": message
        or ("Your team already captured this flag." if already is not None else None),
    }
