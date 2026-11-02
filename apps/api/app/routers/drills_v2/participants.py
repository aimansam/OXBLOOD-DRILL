"""Participant roster and announcement endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Role, TokenData, require_role
from app.db.models import User
from app.db.models_drill import (
    DrillEvent,
    DrillParticipant,
    DrillStatus,
)
from app.db.session import get_session
from app.services.drill_service import (
    add_participant,
    create_announcement,
    get_drill,
    list_drill_announcements,
    list_drill_participants,
    remove_participant,
)

from .schemas import AnnouncementCreate, ParticipantAdd

router = APIRouter()
log = logging.getLogger("app.routers.drills_v2")


# ============================================================================
# Participants
# ============================================================================


@router.get("/{drill_id}/participants")
async def get_participants(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Get all participants in a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    participants = await list_drill_participants(db, drill_id)
    user_ids = [p.user_id for p in participants]
    users_by_id = {}
    if user_ids:
        result = await db.execute(select(User).where(User.id.in_(user_ids)))
        users_by_id = {u.id: u for u in result.scalars().all()}
    return {
        "participants": [
            {
                "id": p.id,
                "user_id": p.user_id,
                "sub": users_by_id[p.user_id].sub if p.user_id in users_by_id else None,
                "username": users_by_id[p.user_id].sub if p.user_id in users_by_id else None,
                "team_id": p.team_id,
                "role": p.role,
                "status": p.status,
                "joined_at": p.joined_at.isoformat() if p.joined_at else None,
                "last_login_at": (
                    users_by_id[p.user_id].last_login_at.isoformat()  # type: ignore[union-attr]
                    if p.user_id in users_by_id and users_by_id[p.user_id].last_login_at
                    else None
                ),
            }
            for p in participants
        ]
    }


@router.get("/{drill_id}/roster-candidates")
async def get_roster_candidates(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Return eligible Red/Blue accounts for the operator roster."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    enrolled_ids = (
        (
            await db.execute(
                select(DrillParticipant.user_id).where(DrillParticipant.drill_id == drill_id)
            )
        )
        .scalars()
        .all()
    )
    users = (
        (
            await db.execute(
                select(User)
                .where(User.role.in_([Role.RED.value, Role.BLUE.value]), User.disabled.is_(False))
                .order_by(User.role, User.sub)
            )
        )
        .scalars()
        .all()
    )
    enrolled = {int(user_id) for user_id in enrolled_ids}
    return {
        "drill_id": drill.id,
        "drill_status": drill.status.value,
        "candidates": [
            {
                "id": user.id,
                "sub": user.sub,
                "role": user.role,
                "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
            }
            for user in users
            if user.id not in enrolled
        ],
    }


@router.post("/{drill_id}/participants")
async def post_participant(
    drill_id: int,
    data: ParticipantAdd,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Add a participant to a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    if drill.status != DrillStatus.SCHEDULED:
        raise HTTPException(status_code=409, detail="Roster is locked after the drill starts.")
    side = str(data.role or "").lower()
    if side not in {"red", "blue"}:
        raise HTTPException(status_code=422, detail="Participant side must be red or blue.")
    user = await db.get(User, data.user_id)
    if user is None or user.disabled:
        raise HTTPException(status_code=404, detail="Eligible participant account not found")
    if str(user.role or "").lower() != side:
        raise HTTPException(
            status_code=422,
            detail=f"Account {user.sub!r} has role {user.role!r}; enroll it on the matching side.",
        )
    try:
        participant = await add_participant(db, drill_id, data.user_id, data.team_id, side)
        db.add(
            DrillEvent(
                drill_id=drill_id,
                kind="roster",
                title=f"{side.title()} participant enrolled",
                detail=user.sub,
                side=side,
                actor=token.sub,
            )
        )
        await db.commit()
        return {"message": "Participant added", "participant_id": participant.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/{drill_id}/participants/{user_id}")
async def delete_participant(
    drill_id: int,
    user_id: int,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    """Remove a participant from a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    if drill.status != DrillStatus.SCHEDULED:
        raise HTTPException(status_code=409, detail="Roster is locked after the drill starts.")
    participant = (
        await db.execute(
            select(DrillParticipant).where(
                DrillParticipant.drill_id == drill_id,
                DrillParticipant.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    removed = await remove_participant(db, drill_id, user_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Participant not found")
    db.add(
        DrillEvent(
            drill_id=drill_id,
            kind="roster",
            title="Participant removed from roster",
            detail=str(user_id),
            side=participant.role if participant else None,
            actor=token.sub,
        )
    )
    await db.commit()
    return {"message": "Participant removed"}


# ============================================================================
# Announcements
# ============================================================================


@router.get("/{drill_id}/announcements")
async def get_announcements(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Get all announcements for a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    announcements = await list_drill_announcements(db, drill_id)
    return {
        "announcements": [
            {
                "id": a.id,
                "title": a.title,
                "content": a.content,
                "priority": a.priority,
                "published_by": a.published_by,
                "published_at": a.published_at.isoformat() if a.published_at else None,
            }
            for a in announcements
        ]
    }


@router.post("/{drill_id}/announcements")
async def post_announcement(
    drill_id: int,
    data: AnnouncementCreate,
    db: AsyncSession = Depends(get_session),
):
    """Create a drill announcement."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        announcement = await create_announcement(
            db, drill_id, data.title, data.content, data.priority
        )
        return {"message": "Announcement created", "announcement_id": announcement.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
