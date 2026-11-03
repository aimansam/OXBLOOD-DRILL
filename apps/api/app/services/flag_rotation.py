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

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import models as catalog_models
from app.db.models_drill import Drill, DrillFlag, DrillRound, DrillTeam, DrillTeamFlag
from app.modules.drills.lifecycle import provision_run_id
from app.runners.adapter import SeedSpec
from app.services import matches as match_svc

log = logging.getLogger("app.services.flag_rotation")

FLAG_DIR = "/opt/divide/flags"
_SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]")


def derive_flag_value(seed: str, round_number: int, name: str, team_id: int | None = None) -> str:
    """``FLAG{<name>_r<round>_<10 hex>}``, stable for a (drill secret, round, flag[, team])."""
    message = f"{round_number}:{name}" + (f":{team_id}" if team_id is not None else "")
    digest = hmac.new(seed.encode(), message.encode(), hashlib.sha256).hexdigest()
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


def _name_side(name: str) -> str | None:
    lowered = name.lower()
    return "red" if lowered.startswith("red-") else "blue" if lowered.startswith("blue-") else None


async def _plant(adapter: Any, machines: list[Any], name: str, value: str, old: str) -> str | None:
    """Write ``value`` on every machine. On failure put ``old`` back where the new one landed."""
    done: list[Any] = []
    try:
        for asset in machines:
            await adapter.apply_guest_seed(
                asset.pve_vmid,
                asset.pve_node,
                SeedSpec(
                    role=asset.role,
                    files={f"{FLAG_DIR}/{name}.txt": value + "\n"},
                    runcmd=[f"chmod -R 700 {FLAG_DIR.rsplit('/', 1)[0]}"],
                ),
            )
            done.append(asset)
    except Exception as exc:  # noqa: BLE001 - guest agent errors vary
        log.warning("flag_rotation.plant_failed flag=%s err=%s", name, exc)
        for asset in done:
            try:
                await adapter.apply_guest_seed(
                    asset.pve_vmid,
                    asset.pve_node,
                    SeedSpec(role=asset.role, files={f"{FLAG_DIR}/{name}.txt": old + "\n"}),
                )
            except Exception:  # noqa: BLE001
                pass
        return str(exc)
    return None


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
        runs = match_svc.run_ids(drill)
        separate = match_svc.is_separate(drill)
        assets_by_run: dict[int, list[Any]] = {rid: [] for rid in runs.values()}
        for asset in (
            (
                await db.execute(
                    select(catalog_models.Asset).where(
                        catalog_models.Asset.run_id.in_(list(runs.values()) or [-1])
                    )
                )
            )
            .scalars()
            .all()
        ):
            assets_by_run[asset.run_id].append(asset)
        env = dict(drill.environment_config or {})
        seed = str(env.get("flag_seed") or secrets.token_hex(16))
        flags = (
            (await db.execute(select(DrillFlag).where(DrillFlag.drill_id == drill.id)))
            .scalars()
            .all()
        )
        teams: list[DrillTeam] = []
        sides: dict[str, str] = {}
        if separate:
            teams = list(
                (await db.execute(select(DrillTeam).where(DrillTeam.drill_id == drill.id)))
                .scalars()
                .all()
            )
            current = (
                await db.execute(
                    select(DrillRound).where(
                        DrillRound.drill_id == drill.id, DrillRound.number == round_number
                    )
                )
            ).scalar_one_or_none()
            sides = {
                tid: str((info or {}).get("side"))
                for tid, info in ((current.assignments if current else None) or {}).items()
            }
        for flag in flags:
            role = planted_on.get(flag.name, "")
            if not role:
                continue
            side = _name_side(flag.name)
            if separate and side is not None:
                # One value per team, planted only on that team's own range copy.
                for copy, run_id in sorted(runs.items()):
                    owner = next(
                        (
                            t
                            for t in teams
                            if t.match_number == copy and sides.get(str(t.id)) == side
                        ),
                        None,
                    )
                    machines = _targets(assets_by_run.get(run_id, []), role)
                    if owner is None or not machines:
                        continue
                    label = f"{flag.name} (match {copy})"
                    value = derive_flag_value(seed, round_number, flag.name, owner.id)
                    error = await _plant(adapter, machines, flag.name, value, flag.value)
                    if error:
                        report["failed"].append({"flag": label, "error": error})
                        continue
                    await db.execute(
                        delete(DrillTeamFlag).where(
                            DrillTeamFlag.drill_id == drill.id,
                            DrillTeamFlag.round_number == round_number,
                            DrillTeamFlag.team_id == owner.id,
                            DrillTeamFlag.flag_name == flag.name,
                        )
                    )
                    db.add(
                        DrillTeamFlag(
                            drill_id=drill.id,
                            round_number=round_number,
                            team_id=owner.id,
                            flag_name=flag.name,
                            value=value,
                        )
                    )
                    report["rotated"].append(label)
                continue
            # A value shared by everyone who can reach the machine(s), on every range copy.
            machines = [m for rid in runs.values() for m in _targets(assets_by_run[rid], role)]
            if not machines:
                continue  # nothing to plant on: leave the value alone
            new_value = derive_flag_value(seed, round_number, flag.name)
            error = await _plant(adapter, machines, flag.name, new_value, flag.value)
            if error:
                report["failed"].append({"flag": flag.name, "error": error})
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
