"""Competition endpoints: teams, rounds, the scoreboard and referee score changes."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Role, TokenData, current_token, require_role
from app.db.models import User
from app.db.models_drill import DrillParticipant, DrillRound, DrillTeam
from app.db.session import get_session
from app.services import teams as svc
from app.services.drill_service import get_drill

from .access import _participant_is_enrolled
from .schemas import (
    FreezeUpdate,
    MyTeamOut,
    RoundListOut,
    RoundPlan,
    ScoreboardOut,
    ScoreEventCreate,
    TeamCreate,
    TeamListOut,
    TeamUpdate,
)

router = APIRouter()

_OPERATORS = (Role.ADMIN, Role.LEAD)
# What a referee may record by hand. Flag and first-blood points come from the submission flow.
_MANUAL_KINDS = {"award", "penalty", "report", "detection"}


def _is_operator(token: TokenData | None) -> bool:
    return token is not None and str(token.role or "").lower() in {"admin", "lead"}


async def _drill_or_404(db: AsyncSession, drill_id: int):
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    return drill


def _fail(exc: svc.TeamError) -> HTTPException:
    message = str(exc)
    return HTTPException(status_code=404 if "not found" in message.lower() else 409, detail=message)


def _team_out(team: DrillTeam, members: list[dict], show_members: bool) -> dict:
    return {
        "id": team.id,
        "name": team.name,
        "color": team.color,
        "position": team.position,
        "member_count": len(members),
        "members": members if show_members else [],
    }


def _round_out(r: DrillRound) -> dict:
    def iso(value):
        return svc._utc(value).isoformat() if value else None

    return {
        "id": r.id,
        "number": r.number,
        "name": r.name,
        "status": r.status,
        "assignments": r.assignments or {},
        "started_at": iso(r.started_at),
        "ended_at": iso(r.ended_at),
        "freeze_at": iso(r.freeze_at),
    }


async def _viewer_user_id(db: AsyncSession, token: TokenData | None) -> int | None:
    if token is None:
        return None
    row = await db.execute(select(User.id).where(User.sub == token.sub))
    return row.scalar_one_or_none()


async def _require_viewer(db: AsyncSession, drill_id: int, token: TokenData | None) -> None:
    """Operators see everything; players only for drills they are enrolled in."""
    if token is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if _is_operator(token):
        return
    if not await _participant_is_enrolled(db, drill_id, token):
        raise HTTPException(status_code=403, detail="You are not enrolled in this drill.")


# --- teams ------------------------------------------------------------------


@router.get("/{drill_id}/teams", response_model=TeamListOut, response_model_exclude_unset=True)
async def get_teams(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    await _drill_or_404(db, drill_id)
    await _require_viewer(db, drill_id, token)
    operator = _is_operator(token)
    teams = await svc.list_teams(db, drill_id)
    members = await svc.members_by_team(db, drill_id)
    own = None
    if not operator:
        uid = await _viewer_user_id(db, token)
        own = next(
            (tid for tid, rows in members.items() if any(m["user_id"] == uid for m in rows)), None
        )
    return {"teams": [_team_out(t, members.get(t.id, []), operator or t.id == own) for t in teams]}


@router.post("/{drill_id}/teams", response_model=TeamListOut, response_model_exclude_unset=True)
async def create_teams(
    drill_id: int,
    body: TeamCreate,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(*_OPERATORS)),
):
    await _drill_or_404(db, drill_id)
    try:
        teams = await svc.ensure_teams(db, drill_id, body.count)
    except svc.TeamError as exc:
        raise _fail(exc) from exc
    members = await svc.members_by_team(db, drill_id)
    return {"teams": [_team_out(t, members.get(t.id, []), True) for t in teams]}


@router.put("/{drill_id}/teams/{team_id}")
async def update_team(
    drill_id: int,
    team_id: int,
    body: TeamUpdate,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(*_OPERATORS)),
):
    await _drill_or_404(db, drill_id)
    try:
        team = await svc.update_team(db, drill_id, team_id, name=body.name, color=body.color)
    except svc.TeamError as exc:
        raise _fail(exc) from exc
    return _team_out(team, [], False)


@router.put("/{drill_id}/teams/{team_id}/members/{user_id}")
async def put_team_member(
    drill_id: int,
    team_id: int,
    user_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(*_OPERATORS)),
):
    await _drill_or_404(db, drill_id)
    try:
        await svc.assign_member(db, drill_id, user_id, team_id)
    except svc.TeamError as exc:
        raise _fail(exc) from exc
    return {"ok": True}


@router.delete("/{drill_id}/teams/{team_id}/members/{user_id}")
async def delete_team_member(
    drill_id: int,
    team_id: int,
    user_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(*_OPERATORS)),
):
    await _drill_or_404(db, drill_id)
    row = await db.execute(
        select(DrillParticipant).where(
            DrillParticipant.drill_id == drill_id,
            DrillParticipant.user_id == user_id,
            DrillParticipant.drill_team_id == team_id,
        )
    )
    if row.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="That player is not in this team.")
    await svc.assign_member(db, drill_id, user_id, None)
    return {"ok": True}


@router.get("/{drill_id}/my-team", response_model=MyTeamOut, response_model_exclude_unset=True)
async def my_team(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    """The caller's team and the side it plays in the running round."""
    await _drill_or_404(db, drill_id)
    await _require_viewer(db, drill_id, token)
    uid = await _viewer_user_id(db, token)
    row = await db.execute(
        select(DrillParticipant.drill_team_id).where(
            DrillParticipant.drill_id == drill_id, DrillParticipant.user_id == uid
        )
    )
    team_id = row.scalar_one_or_none()
    current = await svc.active_round(db, drill_id)
    team = None
    if team_id is not None:
        found = await db.get(DrillTeam, team_id)
        if found is not None:
            mates = (await svc.members_by_team(db, drill_id)).get(team_id, [])
            team = _team_out(found, mates, True)
    return {
        "team": team,
        "round": _round_out(current) if current else None,
        "side": svc.side_for_team(current, team_id),
    }


# --- rounds -----------------------------------------------------------------


@router.get("/{drill_id}/rounds", response_model=RoundListOut, response_model_exclude_unset=True)
async def get_rounds(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    await _drill_or_404(db, drill_id)
    await _require_viewer(db, drill_id, token)
    return {"rounds": [_round_out(r) for r in await svc.list_rounds(db, drill_id)]}


@router.post(
    "/{drill_id}/rounds/plan", response_model=RoundListOut, response_model_exclude_unset=True
)
async def plan_rounds(
    drill_id: int,
    body: RoundPlan,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(*_OPERATORS)),
):
    await _drill_or_404(db, drill_id)
    try:
        rounds = await svc.plan_rounds(db, drill_id, body.rounds)
    except svc.TeamError as exc:
        raise _fail(exc) from exc
    return {"rounds": [_round_out(r) for r in rounds]}


@router.post("/{drill_id}/rounds/{number}/start")
async def start_round(
    drill_id: int,
    number: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(*_OPERATORS)),
):
    await _drill_or_404(db, drill_id)
    try:
        return _round_out(await svc.start_round(db, drill_id, number))
    except svc.TeamError as exc:
        raise _fail(exc) from exc


@router.post("/{drill_id}/rounds/{number}/finish")
async def finish_round(
    drill_id: int,
    number: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(*_OPERATORS)),
):
    await _drill_or_404(db, drill_id)
    try:
        return _round_out(await svc.finish_round(db, drill_id, number))
    except svc.TeamError as exc:
        raise _fail(exc) from exc


@router.put("/{drill_id}/rounds/{number}/freeze")
async def freeze_round(
    drill_id: int,
    number: int,
    body: FreezeUpdate,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(*_OPERATORS)),
):
    await _drill_or_404(db, drill_id)
    try:
        return _round_out(await svc.set_freeze(db, drill_id, number, body.freeze_at))
    except svc.TeamError as exc:
        raise _fail(exc) from exc


# --- scoreboard and referee ledger ------------------------------------------


@router.get(
    "/{drill_id}/scoreboard", response_model=ScoreboardOut, response_model_exclude_unset=True
)
async def get_scoreboard(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    """Team standings. Players see the frozen view during a freeze; referees see everything."""
    await _drill_or_404(db, drill_id)
    await _require_viewer(db, drill_id, token)
    return await svc.scoreboard(db, drill_id, privileged=_is_operator(token))


@router.get("/{drill_id}/score-events")
async def get_score_events(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(*_OPERATORS)),
):
    await _drill_or_404(db, drill_id)
    return {"events": await svc.list_score_events(db, drill_id)}


@router.post("/{drill_id}/score-events", status_code=201)
async def post_score_event(
    drill_id: int,
    body: ScoreEventCreate,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(*_OPERATORS)),
):
    """A referee adds or removes points. A written reason is mandatory and kept in the ledger."""
    await _drill_or_404(db, drill_id)
    reason = body.reason.strip()
    if len(reason) < 3:
        raise HTTPException(status_code=422, detail="A reason is required for every score change.")
    if body.kind not in _MANUAL_KINDS:
        raise HTTPException(
            status_code=422, detail=f"Referees can record: {', '.join(sorted(_MANUAL_KINDS))}."
        )
    if body.points == 0:
        raise HTTPException(status_code=422, detail="Points cannot be zero.")
    try:
        await svc.get_team(db, drill_id, body.team_id)
    except svc.TeamError as exc:
        raise _fail(exc) from exc
    current = await svc.active_round(db, drill_id)
    event = await svc.add_score_event(
        db,
        drill_id,
        kind=body.kind,
        points=body.points,
        reason=reason,
        team_id=body.team_id,
        round_id=current.id if current else None,
        created_by=token.sub,
    )
    return {"id": event.id, "points": event.points, "at": datetime.now(UTC).isoformat()}
