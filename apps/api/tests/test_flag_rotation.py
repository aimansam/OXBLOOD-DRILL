"""Per-round flag rotation: derived values, planting through the guest agent, safe failure."""

from __future__ import annotations

import pytest
from app.db import models
from app.db.base import Base
from app.db.models_drill import Drill, DrillFlag
from app.runners.mock_adapter import MockProxmoxAdapter
from app.runners.runner import Runner, RunRequest
from app.services.flag_rotation import derive_flag_value, earlier_round_values, rotate_round_flags
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine


def test_values_are_stable_and_differ_by_round_flag_and_drill_secret() -> None:
    a = derive_flag_value("seed", 1, "red-web")
    assert a == derive_flag_value("seed", 1, "red-web")
    assert a.startswith("FLAG{red-web_r1_") and a.endswith("}")
    assert (
        len({a, derive_flag_value("seed", 2, "red-web"), derive_flag_value("seed", 1, "blue-x")})
        == 3
    )
    assert derive_flag_value("other", 1, "red-web") != a
    assert earlier_round_values("seed", 3, "red-web") == {
        derive_flag_value("seed", 1, "red-web"),
        derive_flag_value("seed", 2, "red-web"),
    }


@pytest.fixture
def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    yield eng
    import asyncio

    asyncio.run(eng.dispose())


@pytest.fixture
async def world(engine):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as session:
        scenario = models.Scenario(
            name="rot",
            title="rot",
            version=1,
            difficulty="beginner",
            duration_min=30,
            spec={
                "spec": {
                    "networks": [{"name": "n", "cidr": "10.10.0.0/24"}],
                    "assets": [
                        {"role": "web", "kind": "vm", "template": "tpl-x", "networks": ["n"]},
                        {"role": "db", "kind": "vm", "template": "tpl-x", "networks": ["n"]},
                    ],
                    "flags": [
                        {"id": "red-web", "side": "red", "planted_on_role": "web"},
                        {"id": "red-db", "side": "red", "planted_on_role": "db"},
                        {"id": "open-note", "side": "red"},
                    ],
                }
            },
        )
        session.add(scenario)
        await session.commit()
        adapter = MockProxmoxAdapter()
        adapter.seed_template("tpl-x", 9000)
        result = await Runner(adapter=adapter).start_run(
            RunRequest(scenario_id=scenario.id), session
        )
        drill = Drill(
            title="d",
            max_participants=20,
            scenario_id=scenario.id,
            environment_config={"provision_run_id": result.run_id},
        )
        session.add(drill)
        await session.flush()
        for i, name in enumerate(("red-web", "red-db", "open-note")):
            session.add(
                DrillFlag(drill_id=drill.id, name=name, value=f"FLAG{{old{i}}}", sort_order=i)
            )
        await session.commit()
        yield session, drill, adapter


async def _values(session, drill):
    from sqlalchemy import select

    rows = (
        await session.execute(select(DrillFlag).where(DrillFlag.drill_id == drill.id))
    ).scalars()
    return {f.name: f.value for f in rows}


@pytest.mark.asyncio
async def test_rotation_plants_then_saves_and_leaves_machineless_flags_alone(world) -> None:
    session, drill, adapter = world
    before = len(getattr(adapter, "seeds_applied", []))
    report = await rotate_round_flags(session, drill, 1, adapter)

    assert report["status"] == "rotated" and sorted(report["rotated"]) == ["red-db", "red-web"]
    values = await _values(session, drill)
    assert values["open-note"] == "FLAG{old2}"  # nothing to plant on: untouched
    seed = drill.environment_config["flag_seed"]
    assert values["red-web"] == derive_flag_value(seed, 1, "red-web")
    planted = {
        seed_spec.files["/opt/divide/flags/red-web.txt"].strip()
        for (_vm, _node, seed_spec) in adapter.seeds_applied[before:]
        if seed_spec.files and "/opt/divide/flags/red-web.txt" in seed_spec.files
    }
    assert planted == {values["red-web"]}  # the machine holds exactly what the database holds

    second = await rotate_round_flags(session, drill, 2, adapter)
    assert second["status"] == "rotated"
    assert (await _values(session, drill))["red-web"] != values["red-web"]
    assert drill.environment_config["flag_seed"] == seed  # one secret per drill


@pytest.mark.asyncio
async def test_a_failed_plant_keeps_the_old_value(world) -> None:
    session, drill, adapter = world
    real = adapter.apply_guest_seed

    async def flaky(vmid, node, seed):
        if "/opt/divide/flags/red-db.txt" in (seed.files or {}):
            raise RuntimeError("guest agent timeout")
        await real(vmid, node, seed)

    adapter.apply_guest_seed = flaky  # type: ignore[method-assign]
    report = await rotate_round_flags(session, drill, 1, adapter)

    assert report["status"] == "partial"
    assert report["rotated"] == ["red-web"]
    assert report["failed"][0]["flag"] == "red-db" and "timeout" in report["failed"][0]["error"]
    values = await _values(session, drill)
    assert values["red-db"] == "FLAG{old1}"  # still matches what is on the machine
    assert values["red-web"].startswith("FLAG{red-web_r1_")


@pytest.mark.asyncio
async def test_no_range_means_no_rotation(world) -> None:
    session, drill, _ = world
    drill.environment_config = {}
    report = await rotate_round_flags(session, drill, 1, None)
    assert report["status"] == "skipped"
    assert (await _values(session, drill))["red-web"] == "FLAG{old0}"
