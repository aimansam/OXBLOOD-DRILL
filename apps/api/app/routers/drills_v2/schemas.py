"""Pydantic request models shared by the drill endpoints."""

from __future__ import annotations

import logging
from datetime import datetime

from pydantic import BaseModel

log = logging.getLogger("app.routers.drills_v2")


# ============================================================================
# Pydantic Models
# ============================================================================


class DrillCreate(BaseModel):
    title: str
    description: str | None = None
    lab_id: int | None = None  # read-only Learn ref (no FK)
    scenario_id: int | None = None  # Drill catalog (scenarios table)
    drill_type: str = "individual"
    scheduled_start_at: datetime | None = None
    scheduled_end_at: datetime | None = None
    duration_limit_minutes: int | None = None
    max_participants: int | None = 10
    rules: dict | None = None
    environment_config: dict | None = None


class DrillUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    drill_type: str | None = None
    scenario_id: int | None = None
    scheduled_start_at: datetime | None = None
    scheduled_end_at: datetime | None = None
    duration_limit_minutes: int | None = None
    max_participants: int | None = None
    rules: dict | None = None
    environment_config: dict | None = None


class ParticipantAdd(BaseModel):
    user_id: int
    team_id: int | None = None
    role: str = "participant"


class AnnouncementCreate(BaseModel):
    title: str
    content: str
    priority: str = "normal"


class ObjectiveCreate(BaseModel):
    title: str
    description: str | None = None
    points: int = 0
    side: str | None = None
    sort_order: int = 0


class ScenarioLink(BaseModel):
    lab_id: int | None = None  # read-only Learn ref (no FK)
    scenario_id: int | None = None  # Drill catalog (scenarios table)
    scenario_config: dict | None = None


class ConsoleRequest(BaseModel):
    resize: str = "scale"


class ScenarioStartRequest(BaseModel):
    scenario_id: int
    duration_limit_minutes: int | None = None
    max_participants: int | None = 10
