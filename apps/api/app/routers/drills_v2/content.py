"""Objective, flag and scenario endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import models as catalog_models
from app.db.session import get_session
from app.services.drill_service import (
    create_drill_flag,
    create_drill_objective,
    delete_drill_flag,
    get_drill,
    link_scenario,
    list_drill_flags,
    list_drill_objectives,
    list_drill_scenarios,
    record_drill_event,
    set_objective_status,
)

from .schemas import ObjectiveCreate, ScenarioLink

router = APIRouter()
log = logging.getLogger("app.routers.drills_v2")


# ============================================================================
# Objectives
# ============================================================================


@router.get("/{drill_id}/objectives")
async def get_objectives(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Get all objectives for a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    objectives = await list_drill_objectives(db, drill_id)
    return {
        "objectives": [
            {
                "id": o.id,
                "title": o.title,
                "description": o.description,
                "points": o.points,
                "side": o.side,
                "status": getattr(o, "status", "pending") or "pending",
                "sort_order": o.sort_order,
            }
            for o in objectives
        ]
    }


@router.post("/{drill_id}/objectives")
async def post_objective(
    drill_id: int,
    data: ObjectiveCreate,
    db: AsyncSession = Depends(get_session),
):
    """Create a drill objective."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        objective = await create_drill_objective(
            db, drill_id, data.title, data.description, data.points, data.side, data.sort_order
        )
        return {"message": "Objective created", "objective_id": objective.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# ============================================================================
# Flags (Drill-native; values never returned by list)
# ============================================================================


class FlagCreate(BaseModel):
    value: str
    name: str = "flag"
    points: int = 100
    objective_id: int | None = None
    decay_window_seconds: int = 1800
    sort_order: int = 0


@router.get("/{drill_id}/flags")
async def get_flags(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
):
    """List flags for a drill (metadata only — values are secret)."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    flags = await list_drill_flags(db, drill_id)
    return {
        "flags": [
            {
                "id": f.id,
                "name": f.name,
                "points": f.points,
                "objective_id": f.objective_id,
                "sort_order": f.sort_order,
            }
            for f in flags
        ]
    }


@router.post("/{drill_id}/flags")
async def post_flag(
    drill_id: int,
    data: FlagCreate,
    db: AsyncSession = Depends(get_session),
):
    """Create a Drill-native flag."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        flag = await create_drill_flag(
            db,
            drill_id,
            data.value,
            data.name,
            data.points,
            data.objective_id,
            data.decay_window_seconds,
            data.sort_order,
        )
        return {"message": "Flag created", "flag_id": flag.id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/{drill_id}/flags/{flag_id}")
async def remove_flag(
    drill_id: int,
    flag_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Delete a Drill flag."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    ok = await delete_drill_flag(db, drill_id, flag_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Flag not found")
    return {"message": "Flag deleted"}


# ============================================================================
# Scenarios
# ============================================================================


@router.get("/{drill_id}/scenarios")
async def get_scenarios(
    drill_id: int,
    db: AsyncSession = Depends(get_session),
):
    """Get all scenarios linked to a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    scenarios = await list_drill_scenarios(db, drill_id)
    scenario_ids = [s.scenario_id for s in scenarios if s.scenario_id is not None]
    catalog_by_id = {}
    if scenario_ids:
        catalog_rows = (
            (
                await db.execute(
                    select(catalog_models.Scenario).where(
                        catalog_models.Scenario.id.in_(scenario_ids)
                    )
                )
            )
            .scalars()
            .all()
        )
        catalog_by_id = {row.id: row for row in catalog_rows}
    return {
        "scenarios": [
            {
                "id": s.id,
                "lab_id": s.lab_id,
                "scenario_id": s.scenario_id,
                "name": catalog_by_id[s.scenario_id].name
                if s.scenario_id in catalog_by_id
                else None,
                "title": catalog_by_id[s.scenario_id].title
                if s.scenario_id in catalog_by_id
                else None,
                "scenario_config": s.scenario_config,
                "is_active": s.is_active,
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
            for s in scenarios
        ]
    }


@router.post("/{drill_id}/scenarios")
async def post_scenario(
    drill_id: int,
    data: ScenarioLink,
    db: AsyncSession = Depends(get_session),
):
    """Link a lab scenario to a drill."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        scenario = await link_scenario(
            db, drill_id, data.lab_id, data.scenario_id, data.scenario_config
        )
        return {
            "message": "Scenario linked",
            "link_id": scenario.id,
            "scenario_id": scenario.scenario_id,
            "lab_id": scenario.lab_id,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# ============================================================================
# Objective status (exercise flow: pending/in-progress/completed)
# ============================================================================


class ObjectiveStatusUpdate(BaseModel):
    status: str


@router.patch("/{drill_id}/objectives/{objective_id}")
async def patch_objective_status(
    drill_id: int,
    objective_id: int,
    data: ObjectiveStatusUpdate,
    db: AsyncSession = Depends(get_session),
):
    """Lead marks an objective pending / in-progress / completed."""
    drill = await get_drill(db, drill_id)
    if not drill:
        raise HTTPException(status_code=404, detail="Drill not found")
    try:
        objective = await set_objective_status(db, drill_id, objective_id, data.status)
        try:
            await record_drill_event(
                db,
                drill_id,
                "objective",
                "Objective %s: %s" % (objective.status, objective.title),
            )
        except ValueError:
            pass
        return {
            "message": "Objective updated",
            "objective_id": objective.id,
            "status": objective.status,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
