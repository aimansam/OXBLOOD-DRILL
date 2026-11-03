"""Pydantic request models shared by the drill endpoints."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict

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


# ============================================================================
# Response models (documented in OpenAPI so the web client can be generated).
# ``extra="allow"`` keeps any additional fields, so serialization is unchanged.
# ============================================================================


class DrillOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: int
    title: str
    description: str | None = None
    lab_id: int | None = None
    scenario_id: int | None = None
    drill_type: str
    status: str
    scheduled_start_at: str | None = None
    scheduled_end_at: str | None = None
    actual_start_at: str | None = None
    actual_end_at: str | None = None
    duration_limit_minutes: int | None = None
    max_participants: int | None = None
    rules: Any = None
    environment_config: dict[str, Any] | None = None
    run_owner: str | None = None
    lifecycle: dict[str, Any] | None = None
    created_by: int | None = None
    created_at: str | None = None
    updated_at: str | None = None


class DrillListOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    drills: list[DrillOut]


class ParticipantOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: int | None = None
    user_id: int
    sub: str | None = None
    username: str | None = None
    team_id: int | None = None
    role: str
    status: str | None = None
    joined_at: str | None = None
    last_login_at: str | None = None


class ParticipantListOut(BaseModel):
    participants: list[ParticipantOut]


class CandidateOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: int
    sub: str
    role: str
    last_login_at: str | None = None


class CandidateListOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    drill_id: int | None = None
    drill_status: str | None = None
    candidates: list[CandidateOut]


class ProvisionAssetOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: int | None = None
    role: str
    status: str
    pve_vmid: int | None = None
    pve_node: str | None = None
    ip: str | None = None
    error: str | None = None


class ProvisionOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    run_id: int | None = None
    provision_phase: str | None = None
    lifecycle: dict[str, Any] | None = None
    assets: list[ProvisionAssetOut] = []
    errors: list[Any] = []


class DrillStatusOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    drill_id: int
    status: str
    lifecycle: dict[str, Any] | None = None
    environment_config: dict[str, Any] | None = None
    provision: ProvisionOut | None = None


class RangeCheckOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str | None = None
    label: str
    state: str
    detail: str | None = None
    side: str | None = None
    required: bool = True


class RangeHealthOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    drill_id: int | None = None
    run_id: int | None = None
    scenario: dict[str, Any] | None = None
    mood: str | None = None
    summary: str | None = None
    counts: dict[str, Any] | None = None
    checks: list[RangeCheckOut] = []
    checked_at: str | None = None


class PreflightCheckOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    ready: bool
    detail: str


class ScenarioPreflightOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    ready: bool
    node: str | None = None
    checks: list[PreflightCheckOut] = []
    checked_at: str | None = None


class EnvironmentLockOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    lock_key: str | None = None
    available: bool
    status: str | None = None
    drill_id: int | None = None
    owner_sub: str | None = None
    owner_role: str | None = None
    acquired_at: str | None = None
    released_at: str | None = None


# ============================================================================
# Competition: teams, rounds, scoreboard
# ============================================================================


class TeamMemberOut(BaseModel):
    user_id: int
    sub: str | None = None


class TeamOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: int
    name: str
    color: str | None = None
    position: int
    members: list[TeamMemberOut] = []
    member_count: int = 0


class TeamListOut(BaseModel):
    teams: list[TeamOut]


class RoundOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: int
    number: int
    name: str
    status: str
    assignments: dict[str, Any] = {}
    started_at: str | None = None
    ended_at: str | None = None
    freeze_at: str | None = None


class RoundListOut(BaseModel):
    rounds: list[RoundOut]
    range_reset: dict | None = None


class ScoreboardTeamOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    team_id: int
    name: str
    color: str | None = None
    rank: int
    total: int
    members: int = 0
    by_round: dict[str, int] = {}
    last_scored_at: str | None = None


class ScoreboardPlayerOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    user_id: int
    name: str | None = None
    team_id: int | None = None
    total: int


class ScoreboardOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    frozen: bool
    rounds: list[dict[str, Any]] = []
    teams: list[ScoreboardTeamOut]
    players: list[ScoreboardPlayerOut] = []


class MyTeamOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    team: TeamOut | None = None
    round: RoundOut | None = None
    side: str | None = None


class TeamCreate(BaseModel):
    count: int = 4


class TeamUpdate(BaseModel):
    name: str | None = None
    color: str | None = None


class RoundPlan(BaseModel):
    rounds: int = 2


class FreezeUpdate(BaseModel):
    freeze_at: datetime | None = None


class ScoreEventCreate(BaseModel):
    team_id: int
    points: int
    reason: str
    kind: str = "award"
