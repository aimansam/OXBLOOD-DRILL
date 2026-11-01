"""Submissions and scoring router for OxBlood v2.

Provides endpoints for flag submissions, evidence uploads, scoring, leaderboards, and statistics.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_token
from app.db.models_oxblood import DrillFlag, EvidenceType
from app.db.session import get_session
from app.services.drill_service import record_drill_event
from app.services.submission_service import (
    get_drill_first_bloods,
    get_drill_scores,
    get_drill_stats,
    get_flag_submission,
    get_leaderboard,
    get_score_history,
    get_submission,
    get_user_first_bloods,
    get_user_scores,
    get_user_stats,
    list_submission_evidence,
    list_user_submissions,
    submit_flag,
    upload_evidence,
)

router = APIRouter(prefix="/api/v2", tags=["Submissions & Scoring v2"])


# ============================================================================
# Pydantic Models
# ============================================================================


class FlagSubmissionCreate(BaseModel):
    drill_id: int | None = None
    lab_id: int | None = None
    lab_flag_id: int
    flag_value: str
    hints_used: int = 0
    team_id: int | None = None


class EvidenceUpload(BaseModel):
    evidence_type: EvidenceType
    file_path: str
    file_size: int
    mime_type: str | None = None
    description: str | None = None
    objective_id: int | None = None


# ============================================================================
# Helper Functions
# ============================================================================


def submission_to_dict(submission) -> dict:
    """Convert submission to dict."""
    return {
        "id": submission.id,
        "user_id": submission.user_id,
        "drill_id": submission.drill_id,
        "lab_id": submission.lab_id,
        "team_id": submission.team_id,
        "submission_type": submission.submission_type,
        "status": submission.status.value
        if hasattr(submission.status, "value")
        else submission.status,
        "submitted_at": submission.submitted_at.isoformat() if submission.submitted_at else None,
        "reviewed_at": submission.reviewed_at.isoformat() if submission.reviewed_at else None,
    }


def flag_submission_to_dict(fs) -> dict:
    """Convert flag submission to dict."""
    return {
        "id": fs.id,
        "submission_id": fs.submission_id,
        "lab_flag_id": fs.lab_flag_id,
        "flag_value": fs.flag_value,
        "is_correct": fs.is_correct,
        "points_earned": fs.points_earned,
        "time_decay_factor": float(fs.time_decay_factor),
        "attempt_number": fs.attempt_number,
        "hints_used": fs.hints_used,
    }


def score_to_dict(score) -> dict:
    """Convert score to dict."""
    return {
        "id": score.id,
        "user_id": score.user_id,
        "drill_id": score.drill_id,
        "team_id": score.team_id,
        "total_points": score.total_points,
        "flags_captured": score.flags_captured,
        "objectives_completed": score.objectives_completed,
        "hints_used": score.hints_used,
        "penalty_points": score.penalty_points,
        "time_bonus_points": score.time_bonus_points,
        "first_blood_bonus": score.first_blood_bonus,
        "completion_time_seconds": score.completion_time_seconds,
        "rank_position": score.rank_position,
        "last_updated_at": score.last_updated_at.isoformat() if score.last_updated_at else None,
    }


def evidence_to_dict(evidence) -> dict:
    """Convert evidence to dict."""
    return {
        "id": evidence.id,
        "submission_id": evidence.submission_id,
        "objective_id": evidence.objective_id,
        "evidence_type": evidence.evidence_type.value
        if hasattr(evidence.evidence_type, "value")
        else evidence.evidence_type,
        "file_path": evidence.file_path,
        "file_size": evidence.file_size,
        "mime_type": evidence.mime_type,
        "description": evidence.description,
        "captured_at": evidence.captured_at.isoformat() if evidence.captured_at else None,
    }


def first_blood_to_dict(fb) -> dict:
    """Convert first blood to dict."""
    return {
        "id": fb.id,
        "drill_id": fb.drill_id,
        "lab_flag_id": fb.lab_flag_id,
        "user_id": fb.user_id,
        "team_id": fb.team_id,
        "captured_at": fb.captured_at.isoformat() if fb.captured_at else None,
    }


def score_history_to_dict(sh) -> dict:
    """Convert score history to dict."""
    return {
        "id": sh.id,
        "user_id": sh.user_id,
        "drill_id": sh.drill_id,
        "team_id": sh.team_id,
        "action": sh.action,
        "points_change": sh.points_change,
        "previous_total": sh.previous_total,
        "new_total": sh.new_total,
        "recorded_at": sh.recorded_at.isoformat() if sh.recorded_at else None,
    }


# ============================================================================
# Submissions Endpoints
# ============================================================================


@router.post("/submissions")
async def post_submission(
    data: FlagSubmissionCreate,
    user_id: int = Query(..., description="User ID (0 = resolve from X-Divide-Token sub)"),
    session: AsyncSession = Depends(get_session),
    token=Depends(current_token),
):
    """Submit a flag.

    Drill play loop sends lab_flag_id=0 + drill_id + flag_value; the server
    resolves the drill's first objective-linked flag so the portal never
    guesses flag IDs. Explicit lab_flag_id > 0 keeps working as before.
    """
    try:
        # Drill-native identity: user_id=0 means "resolve from token sub".
        # Creates the Drill users row on first submit (sub is the identity).
        from app.db.models import User as _DrillUser

        if not user_id:
            sub = token.sub if token else None
            if not sub:
                raise ValueError("Authentication required (missing X-Divide-Token)")
            existing = await session.execute(select(_DrillUser).where(_DrillUser.sub == sub))
            user = existing.scalar_one_or_none()
            if user is None:
                # password_hash NOT NULL — mark as token-provisioned; this row
                # can never pass password login (no valid argon2 PHC string).
                user = _DrillUser(sub=sub, password_hash="token-provisioned", role="blue")
                session.add(user)
                await session.flush()
            user_id = user.id
        lab_flag_id = data.lab_flag_id
        drill_flag = None
        if not lab_flag_id and data.drill_id:
            # Drill-native flags (drill_flags table). No Learn lookup.
            r = await session.execute(
                select(DrillFlag)
                .where(DrillFlag.drill_id == data.drill_id)
                .order_by(DrillFlag.sort_order, DrillFlag.id)
                .limit(1)
            )
            drill_flag = r.scalars().first()
            if drill_flag is None:
                raise ValueError("Drill has no flags yet — add one via POST /drills/{id}/flags")
            lab_flag_id = drill_flag.id
        elif lab_flag_id and data.drill_id:
            drill_flag = await session.get(DrillFlag, lab_flag_id)
            if drill_flag is not None and drill_flag.drill_id != data.drill_id:
                raise ValueError("Flag does not belong to this drill")
        result = await submit_flag(
            session,
            user_id=user_id,
            drill_id=data.drill_id,
            lab_id=data.lab_id,
            lab_flag_id=lab_flag_id,
            flag_value=data.flag_value,
            hints_used=data.hints_used,
            drill_flag=drill_flag,
            team_id=data.team_id,
        )
        if result.get("is_correct") and data.drill_id:
            actor = (token.sub if token else None) or ("user-%s" % user_id)
            try:
                if result.get("first_blood"):
                    await record_drill_event(
                        session,
                        data.drill_id,
                        "first-blood",
                        "First blood: %s (+%s pts)"
                        % (
                            (drill_flag.name if drill_flag else "flag"),
                            result.get("points_earned", 0),
                        ),
                        actor=actor,
                    )
                else:
                    await record_drill_event(
                        session,
                        data.drill_id,
                        "flag",
                        "Flag captured: %s (+%s pts)"
                        % (
                            (drill_flag.name if drill_flag else "flag"),
                            result.get("points_earned", 0),
                        ),
                        actor=actor,
                    )
                if result.get("objective_completed"):
                    await record_drill_event(
                        session,
                        data.drill_id,
                        "objective",
                        "Objective completed: %s"
                        % (drill_flag.name if drill_flag else "linked objective"),
                        detail="Completed automatically from a correct flag capture.",
                        side=(
                            "red" if (drill_flag and drill_flag.name.startswith("red-")) else "blue"
                        ),
                        actor=actor,
                    )
            except ValueError:
                pass
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/submissions")
async def get_submissions(
    user_id: int = Query(..., description="User ID"),
    drill_id: int | None = Query(None, description="Filter by drill"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
):
    """List user's submissions."""
    submissions = await list_user_submissions(session, user_id, drill_id, skip, limit)
    return {
        "submissions": [submission_to_dict(s) for s in submissions],
        "count": len(submissions),
    }


@router.get("/submissions/{submission_id}")
async def get_submission_details(
    submission_id: int,
    session: AsyncSession = Depends(get_session),
):
    """Get submission details."""
    submission = await get_submission(session, submission_id)
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    result = submission_to_dict(submission)

    # Add flag submission details if applicable
    if submission.submission_type == "flag":
        flag_sub = await get_flag_submission(session, submission_id)
        if flag_sub:
            result["flag_details"] = flag_submission_to_dict(flag_sub)

    return result


@router.post("/submissions/{submission_id}/evidence")
async def post_evidence(
    submission_id: int,
    data: EvidenceUpload,
    session: AsyncSession = Depends(get_session),
    token=Depends(current_token),
):
    """Upload evidence for a submission."""
    try:
        evidence = await upload_evidence(
            session,
            submission_id=submission_id,
            evidence_type=data.evidence_type,
            file_path=data.file_path,
            file_size=data.file_size,
            mime_type=data.mime_type,
            description=data.description,
            objective_id=data.objective_id,
        )
        quality_points = int(getattr(evidence, "_quality_points", 0) or 0)
        if data.objective_id:
            try:
                await record_drill_event(
                    session,
                    (await get_submission(session, submission_id)).drill_id,
                    "milestone",
                    "Evidence submitted",
                    detail=(data.description or "Evidence attached to an objective.")[:500],
                    side="blue",
                    actor=(token.sub if token else None),
                )
            except (AttributeError, ValueError):
                pass
        return {
            "message": "Evidence uploaded",
            "evidence_id": evidence.id,
            "quality_points": quality_points,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/submissions/{submission_id}/evidence")
async def get_evidence(
    submission_id: int,
    session: AsyncSession = Depends(get_session),
):
    """List evidence for a submission."""
    evidence_list = await list_submission_evidence(session, submission_id)
    return {
        "evidence": [evidence_to_dict(e) for e in evidence_list],
        "count": len(evidence_list),
    }


@router.get("/drills/{drill_id}/submissions")
async def get_drill_submissions(
    drill_id: int,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
):
    """List all submissions for a drill."""
    from sqlalchemy import select

    from app.db.models_oxblood import Submission

    query = select(Submission).where(Submission.drill_id == drill_id)
    query = query.order_by(Submission.submitted_at.desc()).offset(skip).limit(limit)
    result = await session.execute(query)
    submissions = result.scalars().all()

    return {
        "submissions": [submission_to_dict(s) for s in submissions],
        "count": len(submissions),
    }


# ============================================================================
# Scoring Endpoints
# ============================================================================


@router.get("/drills/{drill_id}/scores")
async def get_drill_scores_endpoint(
    drill_id: int,
    session: AsyncSession = Depends(get_session),
):
    """Get all scores for a drill."""
    scores = await get_drill_scores(session, drill_id)
    return {
        "scores": [score_to_dict(s) for s in scores],
        "count": len(scores),
    }


@router.get("/users/{user_id}/scores")
async def get_user_scores_endpoint(
    user_id: int,
    session: AsyncSession = Depends(get_session),
):
    """Get all scores for a user."""
    scores = await get_user_scores(session, user_id)
    return {
        "scores": [score_to_dict(s) for s in scores],
        "count": len(scores),
    }


@router.get("/leaderboard")
async def get_global_leaderboard(
    limit: int = Query(100, ge=1, le=500),
    session: AsyncSession = Depends(get_session),
):
    """Get global leaderboard."""
    leaderboard = await get_leaderboard(session, drill_id=None, limit=limit)
    return {
        "leaderboard": leaderboard,
        "count": len(leaderboard),
    }


@router.get("/leaderboard/drill/{drill_id}")
async def get_drill_leaderboard(
    drill_id: int,
    limit: int = Query(100, ge=1, le=500),
    session: AsyncSession = Depends(get_session),
):
    """Get drill-specific leaderboard."""
    leaderboard = await get_leaderboard(session, drill_id=drill_id, limit=limit)
    return {
        "leaderboard": leaderboard,
        "count": len(leaderboard),
    }


@router.get("/scores/history")
async def get_score_history_endpoint(
    user_id: int = Query(..., description="User ID"),
    drill_id: int | None = Query(None, description="Filter by drill"),
    session: AsyncSession = Depends(get_session),
):
    """Get score change history."""
    history = await get_score_history(session, user_id, drill_id)
    return {
        "history": [score_history_to_dict(h) for h in history],
        "count": len(history),
    }


# ============================================================================
# First Blood Endpoints
# ============================================================================


@router.get("/drills/{drill_id}/first-blood")
async def get_drill_first_bloods_endpoint(
    drill_id: int,
    session: AsyncSession = Depends(get_session),
):
    """Get first blood records for a drill."""
    first_bloods = await get_drill_first_bloods(session, drill_id)
    return {
        "first_bloods": [first_blood_to_dict(fb) for fb in first_bloods],
        "count": len(first_bloods),
    }


@router.get("/users/{user_id}/first-blood")
async def get_user_first_bloods_endpoint(
    user_id: int,
    session: AsyncSession = Depends(get_session),
):
    """Get first bloods achieved by a user."""
    first_bloods = await get_user_first_bloods(session, user_id)
    return {
        "first_bloods": [first_blood_to_dict(fb) for fb in first_bloods],
        "count": len(first_bloods),
    }


# ============================================================================
# Statistics Endpoints
# ============================================================================


@router.get("/drills/{drill_id}/stats")
async def get_drill_stats_endpoint(
    drill_id: int,
    session: AsyncSession = Depends(get_session),
):
    """Get statistics for a drill."""
    stats = await get_drill_stats(session, drill_id)
    return stats


@router.get("/users/{user_id}/stats")
async def get_user_stats_endpoint(
    user_id: int,
    session: AsyncSession = Depends(get_session),
):
    """Get statistics for a user."""
    stats = await get_user_stats(session, user_id)
    return stats
