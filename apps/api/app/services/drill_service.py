"""Drill service for OxBlood v2.

Handles drill CRUD, lifecycle management, participants, teams, and announcements.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import models as catalog_models
from app.db.models_oxblood import (
    Drill,
    DrillAnnouncement,
    DrillEvent,
    DrillFlag,
    DrillObjective,
    DrillParticipant,
    DrillScenario,
    DrillStatus,
)

# ============================================================================
# Input Sanitization Helper
# ============================================================================


def _sanitize_text(text: str) -> str:
    """Remove potentially dangerous HTML/script tags from text."""
    if not text:
        return text
    # Remove script tags and their content
    text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.IGNORECASE | re.DOTALL)
    # Remove event handlers (onclick, onerror, etc.)
    text = re.sub(r'\s+on\w+\s*=\s*["\'][^"\']*["\']', "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+on\w+\s*=\s*\S+", "", text, flags=re.IGNORECASE)
    # Remove javascript: URLs
    text = re.sub(r"javascript\s*:", "", text, flags=re.IGNORECASE)
    # Remove iframe, object, embed tags
    text = re.sub(
        r"<(iframe|object|embed|form|input|button)[^>]*>.*?</\1>",
        "",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    text = re.sub(
        r"<(iframe|object|embed|form|input|button)[^>]*/?\s*>", "", text, flags=re.IGNORECASE
    )
    return text.strip()


# ============================================================================
# Drill CRUD
# ============================================================================


async def list_drills(
    db: AsyncSession,
    status: DrillStatus | None = None,
    skip: int = 0,
    limit: int = 50,
) -> list[Drill]:
    """List drills with optional status filter."""
    query = select(Drill).where(Drill.deleted_at.is_(None))
    if status:
        query = query.where(Drill.status == status)
    query = query.order_by(Drill.created_at.desc()).offset(skip).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


async def get_drill(db: AsyncSession, drill_id: int) -> Drill | None:
    """Get a drill by ID."""
    result = await db.execute(select(Drill).where(Drill.id == drill_id, Drill.deleted_at.is_(None)))
    return result.scalar_one_or_none()


async def create_drill(
    db: AsyncSession,
    title: str,
    description: str | None = None,
    lab_id: int | None = None,
    scenario_id: int | None = None,
    drill_type: str = "individual",
    scheduled_start_at: datetime | None = None,
    scheduled_end_at: datetime | None = None,
    duration_limit_minutes: int | None = None,
    max_participants: int | None = None,
    rules: dict | None = None,
    environment_config: dict | None = None,
    created_by: int | None = None,
) -> Drill:
    """Create a new drill."""
    # Validate input
    if not title or not title.strip():
        raise ValueError("Title cannot be empty")
    if len(title) > 255:
        raise ValueError("Title cannot exceed 255 characters")
    if duration_limit_minutes is not None and duration_limit_minutes <= 0:
        raise ValueError("Duration limit must be positive")
    max_participants = 10 if max_participants is None else max_participants
    if not 1 <= max_participants <= 10:
        raise ValueError("Max participants must be between 1 and 10 for the MVP")
    catalog_row = None
    if scenario_id is not None:
        catalog_row = (
            await db.execute(
                select(catalog_models.Scenario).where(catalog_models.Scenario.id == scenario_id)
            )
        ).scalar_one_or_none()
        if catalog_row is None:
            raise ValueError(f"Scenario id={scenario_id} not found")
        if catalog_row.archived_at is not None:
            raise ValueError(f"Scenario id={scenario_id} is archived")

    # Sanitize text fields to prevent XSS
    title = _sanitize_text(title)
    description = _sanitize_text(description) if description else description

    drill = Drill(
        title=title,
        description=description,
        lab_id=lab_id,
        scenario_id=scenario_id,
        drill_type=drill_type,
        status=DrillStatus.SCHEDULED,
        scheduled_start_at=scheduled_start_at,
        scheduled_end_at=scheduled_end_at,
        duration_limit_minutes=duration_limit_minutes,
        max_participants=max_participants,
        rules=rules or {},
        environment_config=environment_config or {},
        created_by=created_by,
    )
    db.add(drill)
    await db.commit()
    await db.refresh(drill)
    if catalog_row is not None:
        db.add(
            DrillScenario(
                drill_id=drill.id,
                scenario_id=scenario_id,
                scenario_config={},
            )
        )
        await seed_drill_from_scenario(db, drill, catalog_row)
    return drill


async def update_drill(db: AsyncSession, drill_id: int, **kwargs) -> Drill | None:
    """Update a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        return None
    title = kwargs.get("title")
    if title is not None:
        if not str(title).strip():
            raise ValueError("Title cannot be empty")
        if len(str(title)) > 255:
            raise ValueError("Title cannot exceed 255 characters")
        kwargs["title"] = _sanitize_text(str(title))
    if kwargs.get("description") is not None:
        kwargs["description"] = _sanitize_text(str(kwargs["description"]))
    if kwargs.get("duration_limit_minutes") is not None and kwargs["duration_limit_minutes"] <= 0:
        raise ValueError("Duration limit must be positive")
    if kwargs.get("max_participants") is not None and not 1 <= kwargs["max_participants"] <= 10:
        raise ValueError("Max participants must be between 1 and 10 for the MVP")
    if kwargs.get("drill_type") is not None and kwargs["drill_type"] not in {"individual", "team"}:
        raise ValueError("Invalid drill type")
    for key, value in kwargs.items():
        if hasattr(drill, key) and value is not None:
            setattr(drill, key, value)
    await db.commit()
    await db.refresh(drill)
    return drill


async def cancel_drill(db: AsyncSession, drill_id: int) -> Drill | None:
    """Cancel a drill (soft delete)."""
    drill = await get_drill(db, drill_id)
    if not drill:
        return None
    drill.status = DrillStatus.CANCELLED
    drill.deleted_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(drill)
    return drill


# ============================================================================
# Drill Lifecycle
# ============================================================================


async def start_drill(db: AsyncSession, drill_id: int) -> Drill | None:
    """Start a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        return None
    if drill.status != DrillStatus.SCHEDULED:
        raise ValueError(f"Cannot start drill in {drill.status} state")
    drill.status = DrillStatus.ACTIVE
    drill.actual_start_at = datetime.now(UTC)
    db.add(DrillEvent(drill_id=drill.id, kind="lifecycle", title="Drill started"))
    await db.commit()
    await db.refresh(drill)
    return drill


async def pause_drill(db: AsyncSession, drill_id: int) -> Drill | None:
    """Pause a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        return None
    if drill.status != DrillStatus.ACTIVE:
        raise ValueError(f"Cannot pause drill in {drill.status} state")
    drill.status = DrillStatus.PAUSED
    db.add(DrillEvent(drill_id=drill.id, kind="lifecycle", title="Drill paused"))
    await db.commit()
    await db.refresh(drill)
    return drill


async def resume_drill(db: AsyncSession, drill_id: int) -> Drill | None:
    """Resume a paused drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        return None
    if drill.status != DrillStatus.PAUSED:
        raise ValueError(f"Cannot resume drill in {drill.status} state")
    drill.status = DrillStatus.ACTIVE
    db.add(DrillEvent(drill_id=drill.id, kind="lifecycle", title="Drill resumed"))
    await db.commit()
    await db.refresh(drill)
    return drill


async def stop_drill(db: AsyncSession, drill_id: int) -> Drill | None:
    """Stop a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        return None
    if drill.status not in [DrillStatus.ACTIVE, DrillStatus.PAUSED]:
        raise ValueError(f"Cannot stop drill in {drill.status} state")
    drill.status = DrillStatus.COMPLETED
    drill.actual_end_at = datetime.now(UTC)
    db.add(DrillEvent(drill_id=drill.id, kind="lifecycle", title="Drill completed"))
    await db.commit()
    await db.refresh(drill)
    return drill


def is_drill_overdue(drill: Drill, now: datetime | None = None) -> bool:
    """Return true when an active drill passed its duration limit."""
    if drill.status != DrillStatus.ACTIVE:
        return False
    if not drill.actual_start_at or not drill.duration_limit_minutes:
        return False
    now = now or datetime.now(UTC)
    started = drill.actual_start_at
    if started.tzinfo is None:
        started = started.replace(tzinfo=UTC)
    deadline = started + timedelta(minutes=drill.duration_limit_minutes)
    return now >= deadline


async def timeout_drill(db: AsyncSession, drill_id: int) -> Drill | None:
    """Mark an overdue active drill complete because its time limit expired."""
    drill = await get_drill(db, drill_id)
    if not drill:
        return None
    if not is_drill_overdue(drill):
        return drill
    now = datetime.now(UTC)
    env = dict(drill.environment_config or {})
    env["timeout_status"] = "reached"
    env["timeout_at"] = now.isoformat()
    drill.environment_config = env
    drill.status = DrillStatus.COMPLETED
    drill.actual_end_at = now
    db.add(
        DrillEvent(
            drill_id=drill.id,
            kind="lifecycle",
            title="Drill time limit reached",
            detail="Drill automatically completed after reaching its duration limit.",
        )
    )
    await db.commit()
    await db.refresh(drill)
    return drill


async def timeout_overdue_drills(db: AsyncSession) -> list[Drill]:
    """Sweep active drills and complete any that passed their time limit."""
    result = await db.execute(
        select(Drill).where(
            Drill.deleted_at.is_(None),
            Drill.status == DrillStatus.ACTIVE,
            Drill.actual_start_at.is_not(None),
            Drill.duration_limit_minutes.is_not(None),
        )
    )
    timed_out: list[Drill] = []
    for drill in result.scalars().all():
        if not is_drill_overdue(drill):
            continue
        env = dict(drill.environment_config or {})
        env["timeout_status"] = "reached"
        env["timeout_at"] = datetime.now(UTC).isoformat()
        drill.environment_config = env
        drill.status = DrillStatus.COMPLETED
        drill.actual_end_at = datetime.now(UTC)
        db.add(
            DrillEvent(
                drill_id=drill.id,
                kind="lifecycle",
                title="Drill time limit reached",
                detail="Drill automatically completed after reaching its duration limit.",
            )
        )
        timed_out.append(drill)
    if timed_out:
        await db.commit()
    return timed_out


# ============================================================================
# Participants
# ============================================================================


async def list_drill_participants(db: AsyncSession, drill_id: int) -> list[DrillParticipant]:
    """List all participants in a drill."""
    result = await db.execute(
        select(DrillParticipant)
        .where(DrillParticipant.drill_id == drill_id)
        .order_by(DrillParticipant.joined_at)
    )
    return result.scalars().all()


async def add_participant(
    db: AsyncSession,
    drill_id: int,
    user_id: int,
    team_id: int | None = None,
    role: str = "participant",
) -> DrillParticipant:
    """Add a participant to a drill."""
    drill = await get_drill(db, drill_id)
    if drill is None:
        raise ValueError("Drill not found")
    current_count = await db.scalar(
        select(func.count(DrillParticipant.id)).where(DrillParticipant.drill_id == drill_id)
    )
    if int(current_count or 0) >= (drill.max_participants or 10):
        raise ValueError("This drill has reached its 10-participant limit")
    # Check if already a participant
    existing = await db.execute(
        select(DrillParticipant).where(
            DrillParticipant.drill_id == drill_id, DrillParticipant.user_id == user_id
        )
    )
    if existing.scalar_one_or_none():
        raise ValueError("User is already a participant in this drill")

    participant = DrillParticipant(
        drill_id=drill_id,
        user_id=user_id,
        team_id=team_id,
        role=role,
        status="registered",
    )
    db.add(participant)
    await db.commit()
    await db.refresh(participant)
    return participant


async def remove_participant(db: AsyncSession, drill_id: int, user_id: int) -> bool:
    """Remove a participant from a drill."""
    result = await db.execute(
        delete(DrillParticipant).where(
            DrillParticipant.drill_id == drill_id, DrillParticipant.user_id == user_id
        )
    )
    await db.commit()
    return result.rowcount > 0


# ============================================================================
# Teams
# ============================================================================

# ============================================================================
# Announcements
# ============================================================================


async def list_drill_announcements(db: AsyncSession, drill_id: int) -> list[DrillAnnouncement]:
    """List all announcements for a drill."""
    result = await db.execute(
        select(DrillAnnouncement)
        .where(DrillAnnouncement.drill_id == drill_id)
        .order_by(DrillAnnouncement.published_at.desc())
    )
    return result.scalars().all()


async def create_announcement(
    db: AsyncSession,
    drill_id: int,
    title: str,
    content: str,
    priority: str = "normal",
    published_by: int | None = None,
) -> DrillAnnouncement:
    """Create a drill announcement."""
    # Validate and sanitize input
    if not title or not title.strip():
        raise ValueError("Title cannot be empty")
    if not content or not content.strip():
        raise ValueError("Content cannot be empty")
    if len(title) > 255:
        raise ValueError("Title cannot exceed 255 characters")

    # Sanitize to prevent XSS
    title = _sanitize_text(title)
    content = _sanitize_text(content)

    announcement = DrillAnnouncement(
        drill_id=drill_id,
        title=title,
        content=content,
        priority=priority,
        published_by=published_by,
    )
    db.add(announcement)
    db.add(
        DrillEvent(
            drill_id=drill_id,
            kind="announcement",
            title="Announcement: %s" % title[:200],
            detail=content[:500] if content else None,
        )
    )
    await db.commit()
    await db.refresh(announcement)
    return announcement


async def delete_announcement(db: AsyncSession, announcement_id: int) -> bool:
    """Delete an announcement by ID."""
    result = await db.execute(
        select(DrillAnnouncement).where(DrillAnnouncement.id == announcement_id)
    )
    announcement = result.scalar_one_or_none()
    if not announcement:
        return False
    await db.delete(announcement)
    await db.commit()
    return True


# ============================================================================
# Drill Objectives
# ============================================================================


async def list_drill_objectives(db: AsyncSession, drill_id: int) -> list[DrillObjective]:
    """List all objectives for a drill."""
    result = await db.execute(
        select(DrillObjective)
        .where(DrillObjective.drill_id == drill_id)
        .order_by(DrillObjective.sort_order)
    )
    return result.scalars().all()


async def create_drill_objective(
    db: AsyncSession,
    drill_id: int,
    title: str,
    description: str | None = None,
    points: int = 0,
    side: str | None = None,
    sort_order: int = 0,
) -> DrillObjective:
    """Create a drill objective."""
    # Validate input
    if not title or not title.strip():
        raise ValueError("Title cannot be empty")
    if len(title) > 255:
        raise ValueError("Title cannot exceed 255 characters")
    if points < 0:
        raise ValueError("Points cannot be negative")

    # Sanitize text fields to prevent XSS
    title = _sanitize_text(title)
    description = _sanitize_text(description) if description else description

    objective = DrillObjective(
        drill_id=drill_id,
        title=title,
        description=description,
        points=points,
        side=side,
        sort_order=sort_order,
    )
    db.add(objective)
    await db.commit()
    await db.refresh(objective)
    return objective


# ============================================================================
# Drill Flags (Drill-native; replaces Learn LabFlag dependency)
# ============================================================================


async def list_drill_flags(db: AsyncSession, drill_id: int) -> list[DrillFlag]:
    """List all flags for a drill."""
    result = await db.execute(
        select(DrillFlag)
        .where(DrillFlag.drill_id == drill_id)
        .order_by(DrillFlag.sort_order, DrillFlag.id)
    )
    return list(result.scalars().all())


async def create_drill_flag(
    db: AsyncSession,
    drill_id: int,
    value: str,
    name: str = "flag",
    points: int = 100,
    objective_id: int | None = None,
    decay_window_seconds: int = 1800,
    sort_order: int = 0,
) -> DrillFlag:
    """Create a Drill-native flag. Value is the secret (never returned by list)."""
    if not value or not value.strip():
        raise ValueError("Flag value cannot be empty")
    if points < 0:
        raise ValueError("Points cannot be negative")
    flag = DrillFlag(
        drill_id=drill_id,
        objective_id=objective_id,
        name=_sanitize_text(name) if name else "flag",
        value=value.strip(),
        points=points,
        decay_window_seconds=decay_window_seconds,
        sort_order=sort_order,
    )
    db.add(flag)
    await db.commit()
    await db.refresh(flag)
    return flag


def _scenario_runtime_spec(scenario: catalog_models.Scenario) -> dict:
    spec = scenario.spec or {}
    inner = spec.get("spec") if isinstance(spec, dict) else None
    return inner if isinstance(inner, dict) else spec


async def seed_drill_from_scenario(
    db: AsyncSession,
    drill: Drill,
    scenario: catalog_models.Scenario,
) -> dict[str, int]:
    """Seed drill-native objectives and flags from a catalog scenario.

    The seed is idempotent by side/title for objectives and name for flags.
    Operators can still edit or add drill-native content after seeding.
    """
    runtime = _scenario_runtime_spec(scenario)
    objectives = runtime.get("objectives") or {}
    flags = runtime.get("flags") or []

    existing_objectives = (
        (await db.execute(select(DrillObjective).where(DrillObjective.drill_id == drill.id)))
        .scalars()
        .all()
    )
    existing_objective_keys = {((row.side or "").lower(), row.title) for row in existing_objectives}

    created_objectives = 0
    objective_sort = len(existing_objectives)
    for side in ("red", "blue"):
        for title in objectives.get(side, []) or []:
            title_text = str(title).strip()
            if not title_text or (side, title_text) in existing_objective_keys:
                continue
            db.add(
                DrillObjective(
                    drill_id=drill.id,
                    title=_sanitize_text(title_text),
                    description=f"Seeded from scenario {scenario.name}",
                    points=100,
                    side=side,
                    sort_order=objective_sort,
                )
            )
            objective_sort += 1
            created_objectives += 1
            existing_objective_keys.add((side, title_text))

    existing_flag_names = set(
        (await db.execute(select(DrillFlag.name).where(DrillFlag.drill_id == drill.id)))
        .scalars()
        .all()
    )
    objective_rows = (
        (await db.execute(select(DrillObjective).where(DrillObjective.drill_id == drill.id)))
        .scalars()
        .all()
    )
    objectives_by_key = {((row.side or "").lower(), row.title): row.id for row in objective_rows}
    created_flags = 0
    flag_sort = len(existing_flag_names)
    for flag in flags:
        if not isinstance(flag, dict):
            continue
        name = str(flag.get("id") or flag.get("name") or "flag").strip()
        value = str(flag.get("value") or "").strip()
        if not name or not value or name in existing_flag_names:
            continue
        db.add(
            DrillFlag(
                drill_id=drill.id,
                objective_id=objectives_by_key.get(
                    (str(flag.get("side") or "").lower(), str(flag.get("objective") or ""))
                ),
                name=_sanitize_text(name),
                value=value,
                points=int(flag.get("base_points") or flag.get("points") or 100),
                decay_window_seconds=int(flag.get("decay_window_seconds") or 1800),
                sort_order=flag_sort,
            )
        )
        flag_sort += 1
        created_flags += 1
        existing_flag_names.add(name)

    env = dict(drill.environment_config or {})
    env["scenario_seed"] = {
        "scenario_id": scenario.id,
        "scenario_name": scenario.name,
        "objectives": created_objectives,
        "flags": created_flags,
    }
    drill.environment_config = env
    await db.commit()
    await db.refresh(drill)
    return {"objectives": created_objectives, "flags": created_flags}


async def delete_drill_flag(db: AsyncSession, drill_id: int, flag_id: int) -> bool:
    """Delete a Drill flag."""
    result = await db.execute(
        select(DrillFlag).where(DrillFlag.id == flag_id, DrillFlag.drill_id == drill_id)
    )
    flag = result.scalar_one_or_none()
    if flag is None:
        return False
    await db.delete(flag)
    await db.commit()
    return True


OBJECTIVE_STATUSES = ("pending", "in-progress", "completed")


async def set_objective_status(
    db: AsyncSession,
    drill_id: int,
    objective_id: int,
    status: str,
) -> DrillObjective:
    """Lead marks an objective pending / in-progress / completed."""
    status = (status or "").strip().lower()
    if status not in OBJECTIVE_STATUSES:
        raise ValueError("Invalid objective status: %r" % (status,))
    result = await db.execute(
        select(DrillObjective).where(
            DrillObjective.id == objective_id,
            DrillObjective.drill_id == drill_id,
        )
    )
    objective = result.scalar_one_or_none()
    if objective is None:
        raise ValueError("Objective not found")
    objective.status = status
    await db.commit()
    await db.refresh(objective)
    return objective


EVENT_KINDS = (
    "lifecycle",
    "flag",
    "first-blood",
    "announcement",
    "objective",
    "note",
    "milestone",
)


async def record_drill_event(
    db: AsyncSession,
    drill_id: int,
    kind: str,
    title: str,
    detail: str | None = None,
    side: str | None = None,
    actor: str | None = None,
) -> DrillEvent:
    """Append one row to the per-drill exercise timeline."""
    kind = (kind or "").strip().lower()
    if kind not in EVENT_KINDS:
        raise ValueError("Invalid event kind: %r" % (kind,))
    if not title or not title.strip():
        raise ValueError("Event title cannot be empty")
    event = DrillEvent(
        drill_id=drill_id,
        kind=kind,
        title=_sanitize_text(title)[:255],
        detail=_sanitize_text(detail) if detail else None,
        side=(side or "").strip().lower() or None,
        actor=_sanitize_text(actor) if actor else None,
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


async def list_drill_events(
    db: AsyncSession,
    drill_id: int,
    limit: int = 100,
) -> list[DrillEvent]:
    """Chronological exercise timeline for one drill."""
    result = await db.execute(
        select(DrillEvent)
        .where(DrillEvent.drill_id == drill_id)
        .order_by(DrillEvent.created_at.asc(), DrillEvent.id.asc())
        .limit(max(1, min(limit, 500)))
    )
    return list(result.scalars().all())


# ============================================================================
# Drill Scenarios
# ============================================================================


async def list_drill_scenarios(db: AsyncSession, drill_id: int) -> list[DrillScenario]:
    """List all scenarios linked to a drill."""
    result = await db.execute(
        select(DrillScenario)
        .where(DrillScenario.drill_id == drill_id)
        .order_by(DrillScenario.created_at)
    )
    return result.scalars().all()


async def link_scenario(
    db: AsyncSession,
    drill_id: int,
    lab_id: int | None = None,
    scenario_id: int | None = None,
    scenario_config: dict | None = None,
) -> DrillScenario:
    """Link a scenario to a drill.

    Prefers scenario_id (Drill catalog). lab_id is a read-only
    Learn-catalog reference for back-compat; no FK is enforced.
    """
    if scenario_id is None and lab_id is None:
        raise ValueError("Either scenario_id or lab_id is required")
    drill = await get_drill(db, drill_id)
    if drill is None:
        raise ValueError("Drill not found")
    if scenario_id is not None:
        catalog_row = (
            await db.execute(
                select(catalog_models.Scenario).where(catalog_models.Scenario.id == scenario_id)
            )
        ).scalar_one_or_none()
        if catalog_row is None:
            raise ValueError(f"Scenario id={scenario_id} not found")
        if catalog_row.archived_at is not None:
            raise ValueError(f"Scenario id={scenario_id} is archived")
    dup_q = select(DrillScenario).where(DrillScenario.drill_id == drill_id)
    if scenario_id is not None:
        dup_q = dup_q.where(DrillScenario.scenario_id == scenario_id)
    else:
        dup_q = dup_q.where(DrillScenario.lab_id == lab_id)
    existing = await db.execute(dup_q)
    if existing.scalar_one_or_none():
        raise ValueError("Scenario is already linked to this drill")

    scenario = DrillScenario(
        drill_id=drill_id,
        lab_id=lab_id,
        scenario_id=scenario_id,
        scenario_config=scenario_config or {},
    )
    db.add(scenario)
    if scenario_id is not None:
        drill.scenario_id = scenario_id
        await seed_drill_from_scenario(db, drill, catalog_row)
    else:
        await db.commit()
    await db.refresh(scenario)
    return scenario
