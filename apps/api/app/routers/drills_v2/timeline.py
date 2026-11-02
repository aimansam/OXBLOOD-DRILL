"""Timeline and milestone endpoints."""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import TokenData, current_token
from app.db import models as catalog_models
from app.db.session import get_session
from app.services.drill_service import (
    get_drill,
    list_drill_events,
    record_drill_event,
)
from app.services.submission_service import record_milestone_score

router = APIRouter()
log = logging.getLogger("app.routers.drills_v2")


# ============================================================================
# Exercise timeline (unified per-drill event feed)
# ============================================================================


class TimelineNote(BaseModel):
    title: str
    detail: str | None = None
    side: str | None = None


class MilestoneCreate(BaseModel):
    milestone: str
    detail: str | None = None


@router.get("/{drill_id}/timeline")
async def get_timeline(
    drill_id: int,
    limit: int = 100,
    db: AsyncSession = Depends(get_session),
):
    """Chronological exercise timeline for one drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    events = await list_drill_events(db, drill_id, limit)
    return {
        "events": [
            {
                "id": e.id,
                "kind": e.kind,
                "title": e.title,
                "detail": e.detail,
                "side": e.side,
                "actor": e.actor,
                "created_at": e.created_at.isoformat() if e.created_at else None,
            }
            for e in events
        ]
    }


@router.post("/{drill_id}/timeline")
async def post_timeline_note(
    drill_id: int,
    data: TimelineNote,
    db: AsyncSession = Depends(get_session),
):
    """Lead appends an exercise note to the drill timeline."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        event = await record_drill_event(
            db,
            drill_id,
            "note",
            data.title,
            data.detail,
            data.side,
        )
        return {"message": "Note recorded", "event_id": event.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/{drill_id}/milestones")
async def post_milestone(
    drill_id: int,
    data: MilestoneCreate,
    db: AsyncSession = Depends(get_session),
    token: TokenData | None = Depends(current_token),
):
    """Record a detection or containment milestone with elapsed time."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    milestone = data.milestone.strip().lower()
    if milestone not in {"detection", "containment"}:
        raise HTTPException(
            status_code=422,
            detail="milestone must be detection or containment",
        )
    elapsed_seconds = None
    if drill.actual_start_at:
        elapsed_seconds = max(
            0,
            int(
                (datetime.now(drill.actual_start_at.tzinfo) - drill.actual_start_at).total_seconds()
            ),
        )
    score_result = {"points_awarded": 0, "already_recorded": False}
    if elapsed_seconds is not None and token and token.sub:
        user_result = await db.execute(
            select(catalog_models.User).where(catalog_models.User.sub == token.sub)
        )
        user = user_result.scalar_one_or_none()
        if user:
            score_result = await record_milestone_score(
                db,
                user.id,
                drill_id,
                milestone,
                elapsed_seconds,
            )
    try:
        event = await record_drill_event(
            db,
            drill_id,
            "milestone",
            milestone.title() + " milestone recorded",
            detail=data.detail,
            side="blue",
            actor=(token.sub if token else None),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {
        "event_id": event.id,
        "milestone": milestone,
        "elapsed_seconds": elapsed_seconds,
        **score_result,
    }
