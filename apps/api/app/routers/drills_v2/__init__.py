"""Drill router for OxBlood v2.

Provides endpoints for drill management, lifecycle, participants, teams, and announcements.
Sub-routers are included in the original declaration order, which matters for
overlapping paths such as ``/environment-lock`` and ``/{drill_id}``.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import (
    access,
    content,
    crud,
    health,
    lifecycle,
    participants,
    provisioning,
    schemas,
    timeline,
)
from .health import _provision_checks_ready, _range_health
from .lifecycle import prepare_drill_endpoint, start_drill_endpoint
from .provisioning import _PROVISION_JOBS, ProvisionJob, _stop_drill_provision_run

# Modules that hold patchable module-level names (see tests).
SUBMODULES = (
    access,
    content,
    crud,
    health,
    lifecycle,
    participants,
    provisioning,
    schemas,
    timeline,
)

router = APIRouter()
for _module in (crud, lifecycle, participants, content, timeline):
    router.include_router(_module.router, prefix="/api/v2/drills", tags=["Drills v2"])

__all__ = [
    "SUBMODULES",
    "ProvisionJob",
    "_PROVISION_JOBS",
    "_provision_checks_ready",
    "_range_health",
    "_stop_drill_provision_run",
    "prepare_drill_endpoint",
    "router",
    "start_drill_endpoint",
]
