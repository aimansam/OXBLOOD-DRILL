"""Fresh flag values for every round.

Scenario flags are fixed strings, so a flag learned in round 1 would still score in round 2 and
teams could pass them around. At the start of each round every flag that has a machine to live on
gets a new value derived from a per-drill secret and the round number. The value is written to
the machine through the QEMU guest agent *before* it is saved: a flag whose planting failed keeps
its old value, so the database and the machines never disagree.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import models as catalog_models
from app.db.models_drill import Drill, DrillFlag
from app.modules.drills.lifecycle import provision_run_id
from app.runners.adapter import SeedSpec

log = logging.getLogger("app.services.flag_rotation")

FLAG_DIR = "/opt/divide/flags"
_SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]")


def derive_flag_value(seed: str, round_number: int, name: str) -> str:
    """``FLAG{<name>_r<round>_<10 hex>}``, stable for a (drill secret, round, flag)."""
    digest = hmac.new(seed.encode(), f"{round_number}:{name}".encode(), hashlib.sha256).hexdigest()
    slug = _SAFE_NAME.sub("_", name)
    return f"FLAG{{{slug}_r{round_number}_{digest[:10]}}}"


def earlier_round_values(seed: str, round_number: int, name: str) -> set[str]:
    return {derive_flag_value(seed, n, name) for n in range(1, round_number)}


def _targets(assets: list[Any], planted_on_role: str) -> list[Any]:
    return [
        a
        for a in assets
        if a.pve_vmid is not None
        and a.pve_node
        and (
            a.role == planted_on_role
            or a.role.startswith(planted_on_role + "_")
            or re.sub(r"_\d+$", "", a.role) == planted_on_role
        )
    ]


async def rotate_round_flags(
    db: AsyncSession, drill: Drill, round_number: int, adapter: Any
) -> dict[str, Any]:
    """Plant and save this round's flag values. Returns a report; never raises."""
    report: dict[str, Any] = {
        "round": round_number,
        "status": "skipped",
        "rotated": [],
        "failed": [],
    }
    try:
        run_id = provision_run_id(drill)
        if run_id is None or drill.scenario_id is None:
            report["detail"] = "No prepared range, so the flags keep their scenario values."
            return report
        scenario = await db.get(catalog_models.Scenario, drill.scenario_id)
        doc = (scenario.spec if scenario else None) or {}
        planted_on = {
            str(f.get("id") or f.get("name")): str(f.get("planted_on_role") or "")
            for f in (doc.get("spec") or doc).get("flags") or []
            if isinstance(f, dict)
        }
        assets = list(
            (
                await db.execute(
                    select(catalog_models.Asset).where(catalog_models.Asset.run_id == run_id)
                )
            )
            .scalars()
            .all()
        )
        env = dict(drill.environment_config or {})
        seed = str(env.get("flag_seed") or secrets.token_hex(16))
        flags = (
            (await db.execute(select(DrillFlag).where(DrillFlag.drill_id == drill.id)))
            .scalars()
            .all()
        )
        for flag in flags:
            role = planted_on.get(flag.name, "")
            machines = _targets(assets, role) if role else []
            if not machines:
                continue  # nothing to plant on: leave the value alone
            new_value = derive_flag_value(seed, round_number, flag.name)
            done: list[Any] = []
            try:
                for asset in machines:
                    await adapter.apply_guest_seed(
                        asset.pve_vmid,
                        asset.pve_node,
                        SeedSpec(
                            role=asset.role,
                            files={f"{FLAG_DIR}/{flag.name}.txt": new_value + "\n"},
                            runcmd=[f"chmod -R 700 {FLAG_DIR.rsplit('/', 1)[0]}"],
                        ),
                    )
                    done.append(asset)
            except Exception as exc:  # noqa: BLE001 - guest agent errors vary
                log.warning("flag_rotation.plant_failed flag=%s err=%s", flag.name, exc)
                for asset in done:  # put the old value back where the new one landed
                    try:
                        await adapter.apply_guest_seed(
                            asset.pve_vmid,
                            asset.pve_node,
                            SeedSpec(
                                role=asset.role,
                                files={f"{FLAG_DIR}/{flag.name}.txt": flag.value + "\n"},
                            ),
                        )
                    except Exception:  # noqa: BLE001
                        pass
                report["failed"].append({"flag": flag.name, "error": str(exc)})
                continue
            flag.value = new_value
            report["rotated"].append(flag.name)
        env["flag_seed"] = seed
        report["status"] = (
            "failed"
            if report["failed"] and not report["rotated"]
            else "partial"
            if report["failed"]
            else "rotated"
            if report["rotated"]
            else "skipped"
        )
        if report["status"] == "skipped":
            report["detail"] = "No flag has a machine to plant on."
        env["flag_rotation"] = report
        drill.environment_config = env
        await db.commit()
    except Exception as exc:  # noqa: BLE001 - a round must start even if this fails
        log.exception("flag_rotation.failed drill=%s", drill.id)
        await db.rollback()
        report.update(status="failed", detail=f"{type(exc).__name__}: {exc}")
    return report
