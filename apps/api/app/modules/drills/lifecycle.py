"""Pure drill lifecycle helpers shared by the API and orchestration code."""
from __future__ import annotations

from typing import Any


def provision_phase(environment: dict[str, Any] | None) -> str:
    """Translate persisted provisioning fields into a stable UI phase."""
    env = environment or {}
    cleanup = str(env.get("cleanup_status") or "")
    provision = str(env.get("provision_status") or "")
    if cleanup == "stopping":
        return "cleaning"
    if cleanup == "failed":
        return "cleanup_failed"
    if provision in {"waiting", "starting"}:
        return "provisioning"
    if provision in {"validating", "validation_failed"}:
        return provision
    if provision == "started":
        return "ready"
    if provision == "failed":
        return "provision_failed"
    return "not_provisioned"


def lifecycle_snapshot(drill: Any) -> dict[str, Any]:
    """Return the public lifecycle snapshot for a drill model."""
    env = drill.environment_config or {}
    status = drill.status.value if hasattr(drill.status, "value") else str(drill.status)
    phase = provision_phase(env)
    if status == "scheduled" and phase == "ready":
        label = "ready"
    elif status == "scheduled" and phase != "not_provisioned":
        label = phase
    elif status == "scheduled":
        label = "scheduled"
    elif status == "active" and phase in {"provisioning", "provision_failed"}:
        label = phase
    elif status == "active":
        label = "active"
    elif status == "paused":
        label = "paused"
    elif status == "completed":
        label = "ended"
    elif status == "cancelled":
        label = "cancelled"
    else:
        label = status
    return {
        "label": label,
        "drill_status": status,
        "provision_phase": phase,
        "provision_status": env.get("provision_status"),
        "cleanup_status": env.get("cleanup_status"),
        "ready": phase == "ready",
        "blocked": phase in {"provision_failed", "cleanup_failed", "validation_failed"},
    }


def provision_run_id(drill: Any) -> int | None:
    """Read the runner ID from persisted drill environment state."""
    run_id = (drill.environment_config or {}).get("provision_run_id")
    if run_id in (None, ""):
        return None
    try:
        return int(run_id)
    except (TypeError, ValueError):
        return None


def needs_provision_cleanup(drill: Any) -> bool:
    """Whether the drill still owns resources that need cleanup."""
    env = drill.environment_config or {}
    if provision_run_id(drill) is None:
        return False
    return env.get("cleanup_status") not in {"stopped", "stopping"}


def drill_to_dict(drill: Any) -> dict[str, Any]:
    """Serialize a drill without exposing ORM-specific behavior to callers."""
    return {
        "id": drill.id,
        "title": drill.title,
        "description": drill.description,
        "lab_id": drill.lab_id,
        "scenario_id": drill.scenario_id,
        "drill_type": drill.drill_type,
        "status": drill.status.value if hasattr(drill.status, "value") else drill.status,
        "scheduled_start_at": drill.scheduled_start_at.isoformat() if drill.scheduled_start_at else None,
        "scheduled_end_at": drill.scheduled_end_at.isoformat() if drill.scheduled_end_at else None,
        "actual_start_at": drill.actual_start_at.isoformat() if drill.actual_start_at else None,
        "actual_end_at": drill.actual_end_at.isoformat() if drill.actual_end_at else None,
        "duration_limit_minutes": drill.duration_limit_minutes,
        "max_participants": drill.max_participants,
        "rules": drill.rules,
        "environment_config": drill.environment_config,
        "run_owner": (drill.environment_config or {}).get("run_owner_sub"),
        "lifecycle": lifecycle_snapshot(drill),
        "created_by": drill.created_by,
        "created_at": drill.created_at.isoformat() if drill.created_at else None,
        "updated_at": drill.updated_at.isoformat() if drill.updated_at else None,
    }
