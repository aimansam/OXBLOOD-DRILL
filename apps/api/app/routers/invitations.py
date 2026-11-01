"""Operator-issued, single-use participant enrollment links."""
from __future__ import annotations

import hashlib
import secrets
import time
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Role, TokenData, require_role, sign_token
from app.db.models import User
from app.db.models_oxblood import Drill, DrillEvent, DrillInvitation, DrillParticipant, DrillStatus
from app.db.session import get_session
from app.services.users import DuplicateSubError, create_user

router = APIRouter(prefix="/api/v2", tags=["Drill invitations"])
_LIFETIME = timedelta(hours=24)
_UNAVAILABLE = "This invitation is no longer available. Ask the operator for a new link."


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _digest(secret: str) -> str:
    return hashlib.sha256(secret.encode("ascii")).hexdigest()


def _public(invite: DrillInvitation) -> dict:
    now = datetime.now(UTC)
    state = "used" if invite.redeemed_at else "revoked" if invite.revoked_at else "expired" if _utc(invite.expires_at) <= now else "pending"
    return {
        "id": invite.id,
        "side": invite.side,
        "status": state,
        "expires_at": invite.expires_at.isoformat(),
        "created_at": invite.created_at.isoformat(),
    }


def _valid(invite: DrillInvitation | None, drill: Drill | None) -> bool:
    return bool(
        invite and drill and drill.deleted_at is None
        and drill.status == DrillStatus.SCHEDULED
        and invite.redeemed_at is None and invite.revoked_at is None
        and _utc(invite.expires_at) > datetime.now(UTC)
    )


async def _find(db: AsyncSession, secret: str) -> tuple[DrillInvitation | None, Drill | None]:
    if len(secret) != 43:
        return None, None
    invite = (await db.execute(select(DrillInvitation).where(DrillInvitation.token_hash == _digest(secret)))).scalar_one_or_none()
    drill = await db.get(Drill, invite.drill_id) if invite else None
    return invite, drill


class IssueRequest(BaseModel):
    side: str = Field(pattern="^(red|blue)$")


class SecretRequest(BaseModel):
    token: str = Field(min_length=43, max_length=43)


class RedeemRequest(SecretRequest):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
    password: str = Field(min_length=8, max_length=512)


@router.get("/drills/{drill_id}/invitations")
async def list_invitations(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
    _: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    drill = await db.get(Drill, drill_id)
    if drill is None or drill.deleted_at is not None:
        raise HTTPException(404, "Drill not found")
    rows = (await db.execute(select(DrillInvitation).where(DrillInvitation.drill_id == drill_id).order_by(DrillInvitation.id.desc()))).scalars().all()
    return {"invitations": [_public(row) for row in rows]}


@router.post("/drills/{drill_id}/invitations", status_code=201)
async def issue_invitation(
    drill_id: int,
    body: IssueRequest,
    db: AsyncSession = Depends(get_session),
    actor: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    drill = await db.get(Drill, drill_id)
    if drill is None or drill.deleted_at is not None:
        raise HTTPException(404, "Drill not found")
    if drill.status != DrillStatus.SCHEDULED:
        raise HTTPException(409, "Invitations are available before launch only.")
    count = await db.scalar(select(func.count(DrillParticipant.id)).where(DrillParticipant.drill_id == drill_id))
    if int(count or 0) >= (drill.max_participants or 10):
        raise HTTPException(409, "The participant roster is full.")
    pending = (await db.execute(select(DrillInvitation).where(
        DrillInvitation.drill_id == drill_id,
        DrillInvitation.redeemed_at.is_(None),
        DrillInvitation.revoked_at.is_(None),
        DrillInvitation.expires_at > datetime.now(UTC),
    ))).scalars().all()
    if len(pending) >= 20:
        raise HTTPException(409, "Revoke an unused link before creating another.")
    secret = secrets.token_urlsafe(32)
    invite = DrillInvitation(
        drill_id=drill_id, side=body.side, token_hash=_digest(secret),
        created_by=actor.sub, expires_at=datetime.now(UTC) + _LIFETIME,
    )
    db.add(invite)
    await db.commit()
    await db.refresh(invite)
    return {**_public(invite), "token": secret}


@router.delete("/drills/{drill_id}/invitations/{invite_id}")
async def revoke_invitation(
    drill_id: int,
    invite_id: int,
    db: AsyncSession = Depends(get_session),
    _: TokenData = Depends(require_role(Role.ADMIN, Role.LEAD)),
):
    invite = await db.get(DrillInvitation, invite_id)
    if invite is None or invite.drill_id != drill_id:
        raise HTTPException(404, "Invitation not found")
    if invite.redeemed_at is not None:
        raise HTTPException(409, "This invitation has already been used.")
    invite.revoked_at = datetime.now(UTC)
    await db.commit()
    return {"ok": True}


@router.post("/invitations/preview")
async def preview_invitation(body: SecretRequest, db: AsyncSession = Depends(get_session)):
    invite, drill = await _find(db, body.token)
    if not _valid(invite, drill):
        raise HTTPException(404, _UNAVAILABLE)
    return {"title": drill.title, "side": invite.side, "expires_at": invite.expires_at.isoformat()}


@router.post("/invitations/redeem", status_code=201)
async def redeem_invitation(body: RedeemRequest, db: AsyncSession = Depends(get_session)):
    invite, drill = await _find(db, body.token)
    if not _valid(invite, drill):
        raise HTTPException(404, _UNAVAILABLE)
    now = datetime.now(UTC)
    # Claim by conditional UPDATE. A concurrent request cannot claim the same
    # invitation; account creation and enrollment share this transaction.
    claimed = await db.execute(update(DrillInvitation).where(
        DrillInvitation.id == invite.id,
        DrillInvitation.redeemed_at.is_(None),
        DrillInvitation.revoked_at.is_(None),
        DrillInvitation.expires_at > now,
    ).values(redeemed_at=now).execution_options(synchronize_session=False))
    if claimed.rowcount != 1:
        await db.rollback()
        raise HTTPException(404, _UNAVAILABLE)
    # Serialize redemptions for this drill before checking roster capacity.
    # PostgreSQL locks the drill row; SQLite already serializes the UPDATE above.
    drill = (await db.execute(select(Drill).where(Drill.id == drill.id).with_for_update())).scalar_one()
    if drill.status != DrillStatus.SCHEDULED or drill.deleted_at is not None:
        await db.rollback()
        raise HTTPException(404, _UNAVAILABLE)
    count = await db.scalar(select(func.count(DrillParticipant.id)).where(DrillParticipant.drill_id == drill.id))
    if int(count or 0) >= (drill.max_participants or 10):
        await db.rollback()
        raise HTTPException(409, "The participant roster is full. Ask the operator for help.")
    try:
        user = await create_user(db, sub=body.username, password=body.password, role=invite.side)
    except DuplicateSubError as exc:
        raise HTTPException(409, "That username is taken. Choose another.") from exc
    db.add(DrillParticipant(drill_id=drill.id, user_id=user.id, role=invite.side, status="registered"))
    db.add(DrillEvent(
        drill_id=drill.id, kind="roster", title=f"{invite.side.title()} participant joined",
        detail=user.sub, side=invite.side, actor=user.sub,
    ))
    invite.redeemed_by = user.id
    await db.commit()
    issued_at = int(time.time())
    ttl = 8 * 3600
    return {
        "token": sign_token(sub=user.sub, role=user.role, ttl_s=ttl),
        "sub": user.sub, "role": user.role,
        "iat": issued_at, "exp": issued_at + ttl,
        "drill_id": drill.id,
    }
