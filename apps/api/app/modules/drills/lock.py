"""Exclusive ownership for the shared cyber-drill environment."""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models_oxblood import Drill, DrillEnvironmentLock, DrillStatus

LOCK_KEY = "default"
ACTIVE_LOCK_STATUSES = {"starting", "provisioning", "validating", "ready", "active", "paused", "cleanup_required"}


async def _other_environment_owner(db: AsyncSession, drill_id: int | None = None):
    candidates = (await db.execute(
        select(Drill).where(Drill.deleted_at.is_(None))
        .where(Drill.id != drill_id if drill_id is not None else True)
        .order_by(Drill.id.desc())
    )).scalars()
    for drill in candidates:
        env = drill.environment_config or {}
        if drill.status in {DrillStatus.ACTIVE, DrillStatus.PAUSED} or (
            env.get("cleanup_status") != "stopped"
            and (env.get("provision_run_id") or env.get("provision_status") in {
                "starting", "waiting", "validating", "validation_failed", "started", "failed"
            })
        ):
            return drill
    return None


def _now() -> datetime:
    return datetime.now(UTC)


async def _lock_row(db: AsyncSession, *, for_update: bool = False) -> DrillEnvironmentLock:
    query = select(DrillEnvironmentLock).where(DrillEnvironmentLock.lock_key == LOCK_KEY)
    if for_update:
        query = query.with_for_update()
    row = (await db.execute(query)).scalar_one_or_none()
    if row is None:
        # The migration seeds this row. Keeping this fallback makes a fresh
        # SQLite/dev database self-healing without weakening the row lock in
        # PostgreSQL deployments.
        row = DrillEnvironmentLock(lock_key=LOCK_KEY, status="released")
        db.add(row)
        await db.flush()
    return row


async def acquire_environment_lock(
    db: AsyncSession,
    *,
    owner_sub: str,
    owner_role: str,
    drill_id: int | None = None,
    commit: bool = True,
) -> DrillEnvironmentLock:
    """Atomically claim the shared environment or raise HTTP 409."""
    row = await _lock_row(db, for_update=True)

    if row.status in ACTIVE_LOCK_STATUSES and (row.drill_id != drill_id or drill_id is None):
        # A completed drill can finish cleanup without reaching the lock
        # release path (for example after an API restart). Heal that stale
        # row before rejecting the next operator run.
        owner = await db.get(Drill, row.drill_id) if row.drill_id is not None else None
        owner_env = owner.environment_config or {} if owner is not None else {}
        owner_is_terminal = (owner is None and row.drill_id is not None) or (owner is not None and (owner.deleted_at is not None or (
            owner.status in {DrillStatus.COMPLETED, DrillStatus.CANCELLED}
            and owner_env.get("cleanup_status") == "stopped"
        )))
        if owner_is_terminal:
            row.drill_id = None
            row.status = "released"
            row.released_at = _now()
            await db.flush()
        else:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "environment_busy",
                    "message": "The drill environment is already in use.",
                    "drill_id": row.drill_id,
                    "owner_sub": row.owner_sub,
                    "status": row.status,
                },
            )

    # A stale/missing lock row must not bypass an existing active drill.
    active = await _other_environment_owner(db, drill_id)
    if active is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "environment_busy",
                "message": "An active drill already owns the environment.",
                "drill_id": active.id,
                "owner_sub": (active.environment_config or {}).get("run_owner_sub"),
                "status": active.status.value,
            },
        )

    row.drill_id = drill_id
    row.owner_sub = owner_sub
    row.owner_role = owner_role
    row.status = "starting" if drill_id is not None else "starting"
    row.acquired_at = _now()
    row.released_at = None
    if commit:
        await db.commit()
        await db.refresh(row)
    else:
        await db.flush()
    return row


async def bind_environment_lock(
    db: AsyncSession,
    *,
    drill_id: int,
    owner_sub: str,
    owner_role: str,
) -> DrillEnvironmentLock:
    """Attach a newly-created drill to the already-claimed lock."""
    row = await _lock_row(db, for_update=True)
    if row.status not in ACTIVE_LOCK_STATUSES or row.drill_id not in (None, drill_id):
        raise HTTPException(status_code=409, detail="The drill environment lock changed before start.")
    row.drill_id = drill_id
    row.owner_sub = owner_sub
    row.owner_role = owner_role
    row.status = "provisioning"
    await db.commit()
    await db.refresh(row)
    return row


async def set_environment_lock_status(
    db: AsyncSession,
    *,
    drill_id: int,
    status: str,
) -> DrillEnvironmentLock | None:
    row = await _lock_row(db, for_update=True)
    if row.drill_id != drill_id:
        return None
    row.status = status
    await db.commit()
    await db.refresh(row)
    return row


async def release_environment_lock(db: AsyncSession, *, drill_id: int) -> bool:
    row = await _lock_row(db, for_update=True)
    if row.drill_id != drill_id:
        return False
    row.drill_id = None
    row.status = "released"
    row.released_at = _now()
    await db.commit()
    return True


async def release_unbound_environment_lock(db: AsyncSession, *, owner_sub: str) -> bool:
    """Release a claim made before the new drill row was created."""
    row = await _lock_row(db, for_update=True)
    if row.drill_id is not None or row.owner_sub != owner_sub:
        return False
    row.status = "released"
    row.released_at = _now()
    await db.commit()
    return True


async def environment_lock_status(db: AsyncSession) -> dict:
    row = await _lock_row(db)
    if row.status in ACTIVE_LOCK_STATUSES and row.drill_id is not None:
        drill = await db.get(Drill, row.drill_id)
        if drill is None or drill.deleted_at is not None or drill.status in {DrillStatus.COMPLETED, DrillStatus.CANCELLED} and (drill.environment_config or {}).get("cleanup_status") == "stopped":
            row.drill_id = None
            row.status = "released"
            row.released_at = _now()
            await db.commit()
    if row.status == "released":
        active = await _other_environment_owner(db)
        if active is not None:
            active_env = active.environment_config or {}
            return {
                "lock_key": row.lock_key,
                "available": False,
                "status": active.status.value,
                "drill_id": active.id,
                "owner_sub": active_env.get("run_owner_sub"),
                "owner_role": active_env.get("run_owner_role"),
                "acquired_at": active.actual_start_at.isoformat() if active.actual_start_at else None,
                "released_at": None,
            }
    return {
        "lock_key": row.lock_key,
        "available": row.status == "released",
        "status": row.status,
        "drill_id": row.drill_id,
        "owner_sub": row.owner_sub,
        "owner_role": row.owner_role,
        "acquired_at": row.acquired_at.isoformat() if row.acquired_at else None,
        "released_at": row.released_at.isoformat() if row.released_at else None,
    }


async def assert_environment_owner(
    db: AsyncSession,
    *,
    drill: Drill,
    owner_sub: str,
    is_admin: bool = False,
) -> None:
    if is_admin:
        return
    current_owner = (drill.environment_config or {}).get("run_owner_sub")
    if current_owner and current_owner != owner_sub:
        raise HTTPException(
            status_code=403,
            detail="Only the operator who owns this drill can control it.",
        )
