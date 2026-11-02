"""Asset/credential visibility and participant access checks for drills."""

from __future__ import annotations

import dataclasses
import logging

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import TokenData
from app.db.models import User
from app.db.models_drill import (
    DrillParticipant,
    DrillStatus,
)
from app.runners.runner import build_runner
from app.services import teams as team_service

log = logging.getLogger("app.routers.drills_v2")


_RED_ROLE_HINTS = ("red", "attacker", "kali", "operator")
_BLUE_ROLE_HINTS = ("blue", "analyst", "soc", "siem", "log", "defender")


def _asset_side(role: str, scenario_access: dict | None = None) -> str:
    role_l = str(role or "").lower()
    access = scenario_access or {}
    for side in ("red", "blue"):
        assets = access.get(side) or {}
        allowed = assets.get("assets") if isinstance(assets, dict) else assets
        if isinstance(allowed, list) and role in allowed:
            return side
    if any(hint in role_l for hint in _RED_ROLE_HINTS):
        return "red"
    if any(hint in role_l for hint in _BLUE_ROLE_HINTS):
        return "blue"
    return "shared"


def _asset_credentials(role: str, asset_spec: dict | None = None) -> dict | None:
    spec_access = (asset_spec or {}).get("access") or {}
    role_l = str(role or "").lower()
    if role_l.startswith("red") or "attacker" in role_l or "kali" in role_l:
        return {
            "username": str(spec_access.get("user") or "red"),
            "password": str(spec_access.get("password") or "red-team"),
        }
    if role_l.startswith("blue") or "analyst" in role_l or "soc" in role_l:
        return {
            "username": str(spec_access.get("user") or "blue"),
            "password": str(spec_access.get("password") or "blue-team"),
        }
    if spec_access.get("user") or spec_access.get("password"):
        return {
            "username": str(spec_access.get("user") or "divide"),
            "password": str(spec_access.get("password") or "divide"),
        }
    return None


async def _competitor_token(
    db: AsyncSession, drill_id: int, token: TokenData | None
) -> TokenData | None:
    """In a running competition round a player's team side replaces their account role.

    Accounts are created as red or blue, but teams swap sides between rounds. Everything that
    asks "which machines may this player see" therefore uses the side of the round in progress.
    Outside a round (or for players without a team) the token is returned unchanged.
    """
    if token is None or str(token.role or "").lower() not in {"red", "blue"}:
        return token
    user = (await db.execute(select(User).where(User.sub == token.sub))).scalar_one_or_none()
    if user is None:
        return token
    side = await team_service.effective_side(db, drill_id, user.id)
    return dataclasses.replace(token, role=side) if side else token


def _can_view_asset(side: str, token: TokenData | None) -> bool:
    if token is None:
        return True
    role = str(token.role or "").lower()
    if role in {"admin", "lead", "observer"}:
        return True
    if role == "red":
        return side == "red"
    if role == "blue":
        return side == "blue"
    return False


def _can_view_credentials(side: str, token: TokenData | None) -> bool:
    if token is None:
        return False
    role = str(token.role or "").lower()
    if role in {"admin", "lead"}:
        return True
    return role == side and side in {"red", "blue"}


async def _participant_can_access(
    db: AsyncSession, drill_id: int, token: TokenData | None, side: str
) -> bool:
    """Apply roster access after the broad role/side check.

    Operators and observers can inspect every console. For red/blue users,
    a populated roster becomes the source of truth: an account must be on
    this drill, and an explicitly assigned side must match the asset side.
    The empty-roster fallback keeps the LAN bootstrap usable while an
    operator is still assembling a drill.
    """
    if token is None:
        return False
    role = str(token.role or "").lower()
    if role in {"admin", "lead", "observer"}:
        return True
    if role not in {"red", "blue"}:
        return False
    roster = (
        (await db.execute(select(DrillParticipant).where(DrillParticipant.drill_id == drill_id)))
        .scalars()
        .all()
    )
    if not roster:
        return False
    user = (await db.execute(select(User).where(User.sub == token.sub))).scalar_one_or_none()
    if user is None:
        return False
    participant = next((item for item in roster if item.user_id == user.id), None)
    if participant is None or str(participant.status or "").lower() in {"removed", "left"}:
        return False
    competing = await team_service.effective_side(db, drill_id, user.id)
    if competing is not None:
        return competing == side  # the team's side in the running round decides
    assigned_role = str(participant.role or "").lower()
    return assigned_role not in {"red", "blue"} or assigned_role == side


async def _participant_is_enrolled(
    db: AsyncSession, drill_id: int, token: TokenData | None
) -> bool:
    """Return whether a player account is enrolled in this drill."""
    if token is None or str(token.role or "").lower() not in {"red", "blue"}:
        return False
    user = (await db.execute(select(User).where(User.sub == token.sub))).scalar_one_or_none()
    if user is None:
        return False
    participant = (
        await db.execute(
            select(DrillParticipant).where(
                DrillParticipant.drill_id == drill_id,
                DrillParticipant.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    return participant is not None and str(participant.status or "").lower() not in {
        "removed",
        "left",
    }


async def _require_participant_workspace_access(
    db: AsyncSession, drill, token: TokenData | None
) -> None:
    """Keep the live workspace closed until a player is enrolled and started."""
    role = str(token.role or "").lower() if token else ""
    if role not in {"red", "blue"}:
        return
    if not await _participant_is_enrolled(db, drill.id, token):
        raise HTTPException(
            status_code=403,
            detail="You are not enrolled in this drill.",
        )
    status = drill.status.value if hasattr(drill.status, "value") else str(drill.status)
    if status not in {DrillStatus.ACTIVE.value, DrillStatus.PAUSED.value}:
        raise HTTPException(
            status_code=409,
            detail="The drill workspace opens when the drill starts.",
        )


def _get_runner():
    return build_runner()
