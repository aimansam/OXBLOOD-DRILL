"""Range health probes and provision-state refresh."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import TokenData
from app.db import models as catalog_models
from app.db.models import AssetStatus, RunStatus
from app.db.models_drill import (
    DrillFlag,
    DrillObjective,
    DrillParticipant,
)
from app.modules.drills.lifecycle import (
    lifecycle_snapshot as _drill_lifecycle,
)
from app.modules.drills.lifecycle import (
    provision_phase as _provision_phase,
)
from app.modules.drills.lifecycle import (
    provision_run_id as _drill_provision_run_id,
)
from app.services.proxmox import ProxmoxAPIError

from .access import _asset_side, _get_runner

log = logging.getLogger("app.routers.drills_v2")


async def _refresh_drill_provision_state(db: AsyncSession, drill) -> dict:
    """Refresh asset VM state from PVE and return a role-by-role snapshot."""
    env = dict(drill.environment_config or {})
    run_id = _drill_provision_run_id(drill)
    preparation_at = env.get("preparation_started_at")
    if run_id is None and (preparation_at or drill.actual_start_at):
        # A background task can be interrupted after the runner commits its
        # Run but before it publishes provision_run_id to the drill. Recover
        # that association from the run created for this drill, including a
        # terminal run, so the UI never remains stuck at "preparing".
        run_query = (
            select(catalog_models.Run)
            .where(catalog_models.Run.scenario_id == drill.scenario_id)
            .order_by(catalog_models.Run.id.desc())
            .limit(1)
        )
        since = datetime.fromisoformat(preparation_at) if preparation_at else drill.actual_start_at
        if since is not None:
            run_query = run_query.where(catalog_models.Run.started_at >= since)
        active_run = (await db.execute(run_query)).scalar_one_or_none()
        if active_run is not None:
            run_id = active_run.id
            env["provision_run_id"] = run_id
            if active_run.status == RunStatus.FAILED:
                env["provision_status"] = "failed"
                env["provision_error"] = active_run.error or "Provisioning failed."
            drill.environment_config = env
            await db.commit()
    if run_id is None:
        return {
            "run_id": None,
            "provision_phase": _provision_phase(env),
            "assets": [],
            "errors": [],
        }

    # Keep the drill lifecycle aligned with the authoritative runner state.
    # A prior readiness check may have marked the drill started before a
    # later asset failed, so terminal run state must always win.
    changed = False
    live_run = await db.get(catalog_models.Run, run_id)
    if live_run is not None and live_run.status == RunStatus.FAILED:
        env["provision_status"] = "failed"
        env["provision_error"] = live_run.error or "Provisioning failed."
        drill.environment_config = env
        changed = True

    assets = (
        (
            await db.execute(
                select(catalog_models.Asset)
                .where(catalog_models.Asset.run_id == run_id)
                .order_by(catalog_models.Asset.role, catalog_models.Asset.id)
            )
        )
        .scalars()
        .all()
    )

    adapter = _get_runner()._adapter  # noqa: SLF001
    errors: list[dict] = []
    rows = []
    for asset in assets:
        # The runner commits each asset progressively, but recover from an
        # older/in-flight transaction by discovering the clone directly in
        # PVE. This keeps the live monitor accurate even during long seeds.
        if not asset.pve_vmid:
            vm_name = f"divide-{run_id}-{asset.role.replace('_', '')}"
            try:
                discovered = await adapter.find_vm(vm_name)
            except ProxmoxAPIError:
                discovered = None
            if discovered is not None:
                asset.pve_vmid = discovered.vmid
                asset.pve_node = discovered.node
                asset.pve_ip = discovered.ip or asset.pve_ip
                asset.status = (
                    AssetStatus.RUNNING if discovered.status == "running" else AssetStatus.BOOTING
                )
                changed = True
        status_value = asset.status.value if hasattr(asset.status, "value") else str(asset.status)
        if asset.pve_vmid and asset.pve_node and status_value not in {"planned", "cloning"}:
            try:
                state = await adapter.get_vm_state(int(asset.pve_vmid), asset.pve_node)
                next_status = (
                    AssetStatus.RUNNING
                    if state.status == "running"
                    else AssetStatus.STOPPED
                    if state.status == "stopped"
                    else AssetStatus.BOOTING
                )
                if asset.status != next_status:
                    asset.status = next_status
                    changed = True
                if state.ip and state.ip != asset.pve_ip:
                    asset.pve_ip = state.ip
                    changed = True
            except KeyError:
                if asset.status != AssetStatus.STOPPED:
                    asset.status = AssetStatus.STOPPED
                    changed = True
            except ProxmoxAPIError as exc:
                errors.append({"asset_id": asset.id, "role": asset.role, "error": str(exc)})
        rows.append(
            {
                "id": asset.id,
                "role": asset.role,
                "status": asset.status.value
                if hasattr(asset.status, "value")
                else str(asset.status),
                "pve_vmid": asset.pve_vmid,
                "pve_node": asset.pve_node,
                "ip": asset.pve_ip,
                "error": asset.error,
            }
        )

    ready_count = sum(1 for row in rows if row["status"] == "running")
    current = next(
        (row for row in rows if row["status"] not in {"running", "stopped"}),
        None,
    )
    # Power state is not evidence that guest seeding or validation completed.
    if changed:
        await db.commit()
        await db.refresh(drill)
    return {
        "run_id": run_id,
        "provision_phase": _provision_phase(drill.environment_config or {}),
        "progress": {
            "ready": ready_count,
            "total": len(rows),
            "current_role": current["role"] if current else None,
            "current_status": current["status"] if current else None,
        },
        "lifecycle": _drill_lifecycle(drill),
        "assets": rows,
        "errors": errors,
    }


def _role_base(role: str) -> str:
    parts = str(role or "").rsplit("_", 1)
    if len(parts) == 2 and parts[1].isdigit():
        return parts[0]
    return str(role or "")


def _human_role(role: str) -> str:
    text = _role_base(role).replace("_", " ")
    return " ".join(part.capitalize() for part in text.split()) or "Machine"


async def _tcp_connect_ok(host: str, port: int, timeout_s: float = 1.5) -> tuple[bool, str]:
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=timeout_s,
        )
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        _ = reader
        return True, f"Port {port} is reachable."
    except TimeoutError:
        return False, f"Port {port} did not answer before timeout."
    except OSError as exc:
        return False, f"Port {port} is not reachable: {exc.strerror or exc}"


async def _http_status_ok(
    host: str,
    port: int,
    path: str,
    expected_status: int,
    timeout_s: float = 2.0,
) -> tuple[bool, str]:
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=timeout_s,
        )
        req = f"GET {path or '/'} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
        writer.write(req.encode("ascii", errors="ignore"))
        await asyncio.wait_for(writer.drain(), timeout=timeout_s)
        line = await asyncio.wait_for(reader.readline(), timeout=timeout_s)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        text = line.decode("iso-8859-1", errors="ignore").strip()
        parts = text.split()
        status = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0
        if status == expected_status:
            return True, f"HTTP {expected_status} answered on {path or '/'}."
        return False, f"Expected HTTP {expected_status}, got {status or 'no status'}."
    except TimeoutError:
        return False, "HTTP service did not answer before timeout."
    except OSError as exc:
        return False, f"HTTP service is not reachable: {exc.strerror or exc}"


def _asset_visible_for_probe(side: str, token: TokenData | None) -> bool:
    if token is None:
        return True
    role = str(token.role or "").lower()
    if role in {"admin", "lead", "observer"}:
        return True
    if side in {"shared", role}:
        return True
    return False


def _provision_checks_ready(health: dict) -> bool:
    """Team enrollment gates exercise start, not VM preparation."""
    return all(
        check.get("state") == "ready"
        for check in health.get("checks", [])
        if check.get("required") and check.get("id") != "mission-roster"
    )


async def _range_health(db: AsyncSession, drill, token: TokenData | None = None) -> dict:
    scenario = None
    if drill.scenario_id:
        scenario = (
            await db.execute(
                select(catalog_models.Scenario).where(
                    catalog_models.Scenario.id == drill.scenario_id
                )
            )
        ).scalar_one_or_none()
    scenario_spec = ((scenario.spec if scenario else None) or {}).get("spec") or (
        (scenario.spec if scenario else None) or {}
    )
    run_id = _drill_provision_run_id(drill)
    assets = []
    if run_id is not None:
        assets = (
            (
                await db.execute(
                    select(catalog_models.Asset)
                    .where(catalog_models.Asset.run_id == run_id)
                    .order_by(catalog_models.Asset.role, catalog_models.Asset.id)
                )
            )
            .scalars()
            .all()
        )
    assets_by_base: dict[str, list] = {}
    for asset in assets:
        assets_by_base.setdefault(_role_base(asset.role), []).append(asset)

    flags_expected = len(scenario_spec.get("flags") or [])
    flags_loaded = (
        (await db.execute(select(DrillFlag).where(DrillFlag.drill_id == drill.id))).scalars().all()
    )
    objectives_expected = sum(
        len((scenario_spec.get("objectives") or {}).get(side) or []) for side in ("red", "blue")
    )
    objectives_loaded = (
        (await db.execute(select(DrillObjective).where(DrillObjective.drill_id == drill.id)))
        .scalars()
        .all()
    )

    declared = (scenario_spec.get("validation") or {}).get("probes") or []
    if not declared:
        declared = [
            {
                "id": f"{asset.get('role')}-ready",
                "label": f"{_human_role(asset.get('role'))} is ready",
                "type": "role_running",
                "role": asset.get("role"),
                "side": _asset_side(str(asset.get("role") or "")),
            }
            for asset in scenario_spec.get("assets") or []
            if isinstance(asset, dict) and asset.get("role")
        ]
        declared.extend(
            [
                {
                    "id": "flags-loaded",
                    "label": "Scenario flags are loaded",
                    "type": "flag_seeded",
                    "side": "shared",
                },
                {
                    "id": "objectives-loaded",
                    "label": "Mission objectives are loaded",
                    "type": "objectives_seeded",
                    "side": "shared",
                },
            ]
        )

    async def check_probe(probe: dict) -> dict:
        kind = str(probe.get("type") or "")
        side = str(probe.get("side") or "shared")
        label = str(probe.get("label") or probe.get("id") or kind)
        role = str(probe.get("role") or "")
        state = "starting"
        detail = "Waiting for the range to finish preparing."
        if kind == "role_running":
            matches = assets_by_base.get(role, [])
            running = [
                asset
                for asset in matches
                if (asset.status.value if hasattr(asset.status, "value") else str(asset.status))
                == "running"
            ]
            if matches and len(running) == len(matches):
                state = "ready"
                detail = f"{_human_role(role)} is running."
            elif matches and any(asset.error for asset in matches):
                state = "needs_attention"
                detail = next(
                    (asset.error for asset in matches if asset.error),
                    "This machine needs an operator check.",
                )
            elif not matches and run_id is not None:
                state = "needs_attention"
                detail = f"{_human_role(role)} was not created for this run."
        elif kind == "role_address":
            target_roles = [role] if role else list(assets_by_base.keys())
            target_assets = [asset for r in target_roles for asset in assets_by_base.get(r, [])]
            addressed = [asset for asset in target_assets if asset.pve_ip]
            if target_assets and len(addressed) == len(target_assets):
                state = "ready"
                detail = "Connection addresses are available."
            elif target_assets:
                detail = "Waiting for network addresses."
            elif run_id is not None:
                state = "needs_attention"
                detail = "No matching machines found."
        elif kind == "flag_seeded":
            if flags_expected == 0:
                state = "ready"
                detail = "This scenario has no flags."
            elif len(flags_loaded) >= flags_expected:
                state = "ready"
                detail = f"{len(flags_loaded)}/{flags_expected} flags are loaded."
            else:
                state = "needs_attention"
                detail = f"{len(flags_loaded)}/{flags_expected} flags are loaded."
        elif kind == "objectives_seeded":
            if objectives_expected == 0:
                state = "ready"
                detail = "This scenario has no mission objectives."
            elif len(objectives_loaded) >= objectives_expected:
                state = "ready"
                detail = f"{len(objectives_loaded)}/{objectives_expected} objectives are loaded."
            else:
                state = "needs_attention"
                detail = f"{len(objectives_loaded)}/{objectives_expected} objectives are loaded."
        elif kind == "telemetry_declared":
            sinks = (scenario_spec.get("telemetry") or {}).get("sinks") or []
            if sinks:
                state = "ready"
                detail = f"{len(sinks)} telemetry path{'s' if len(sinks) != 1 else ''} declared."
            else:
                state = "needs_attention"
                detail = "No telemetry path is declared."
        elif kind == "artifacts_declared":
            artifacts = scenario_spec.get("artifacts") or {}
            if artifacts.get("sink_to"):
                state = "ready"
                detail = "Evidence collection path is declared."
            else:
                state = "needs_attention"
                detail = "No evidence collection path is declared."
        elif kind in {"tcp_connect", "http_status"}:
            matches = assets_by_base.get(role, [])
            addressed = [asset for asset in matches if asset.pve_ip]
            port = int(probe.get("port") or (80 if kind == "http_status" else 22))
            timeout_s = max(0.2, min(float(probe.get("timeout_ms") or 1500) / 1000.0, 5.0))
            if not matches and run_id is not None:
                state = "needs_attention"
                detail = f"{_human_role(role)} was not created for this run."
            elif not addressed:
                detail = f"Waiting for {_human_role(role)} address."
            else:
                results = []
                for asset in addressed:
                    if kind == "http_status":
                        ok, msg = await _http_status_ok(
                            str(asset.pve_ip),
                            port,
                            str(probe.get("path") or "/"),
                            int(probe.get("expected_status") or 200),
                            timeout_s,
                        )
                    else:
                        ok, msg = await _tcp_connect_ok(
                            str(asset.pve_ip),
                            port,
                            timeout_s,
                        )
                    results.append((ok, msg))
                if len(addressed) != len(matches):
                    state = "starting"
                    detail = "Waiting for addresses on all matching machines."
                elif results and all(ok for ok, _msg in results):
                    state = "ready"
                    detail = results[0][1]
                elif results:
                    state = "needs_attention"
                    detail = next(msg for ok, msg in results if not ok)
        return {
            "id": str(probe.get("id") or kind),
            "label": label,
            "state": state,
            "detail": detail,
            "side": side,
            "required": bool(probe.get("required", True))
            and kind not in {"telemetry_declared", "artifacts_declared"},
        }

    visible_probes = [
        probe
        for probe in declared
        if isinstance(probe, dict)
        and _asset_visible_for_probe(str(probe.get("side") or "shared"), token)
    ]
    checks = list(await asyncio.gather(*(check_probe(probe) for probe in visible_probes)))
    provision = str((drill.environment_config or {}).get("provision_status") or "")
    checks.insert(
        0,
        {
            "id": "guest-setup",
            "label": "Guest setup completed",
            "side": "shared",
            "required": True,
            "state": "ready"
            if provision in {"validating", "validation_failed", "started"}
            else "needs_attention"
            if provision == "failed"
            else "starting",
            "detail": "Guest configuration must finish before the exercise can start.",
        },
    )
    expected_assets = sum(int(asset.get("count") or 1) for asset in scenario_spec.get("assets", []))
    healthy_assets = [
        asset for asset in assets if asset.status == AssetStatus.RUNNING and not asset.error
    ]
    checks.insert(
        1,
        {
            "id": "range-machines",
            "label": "All range machines are running",
            "side": "shared",
            "required": True,
            "state": "ready"
            if expected_assets > 0
            and len(healthy_assets) == expected_assets
            and len(assets) == expected_assets
            else "needs_attention",
            "detail": f"{len(healthy_assets)}/{expected_assets} machines running without provisioning errors.",
        },
    )
    required_sides = [
        side for side in ("red", "blue") if (scenario_spec.get("objectives") or {}).get(side)
    ]
    if required_sides:
        roster = (
            (
                await db.execute(
                    select(DrillParticipant).where(
                        DrillParticipant.drill_id == drill.id,
                        DrillParticipant.status.notin_(["removed", "left"]),
                    )
                )
            )
            .scalars()
            .all()
        )
        assigned = {str(item.role or "").lower() for item in roster}
        missing_sides = [side for side in required_sides if side not in assigned]
        checks.insert(
            2,
            {
                "id": "mission-roster",
                "label": "Required teams are enrolled",
                "side": "shared",
                "required": True,
                "state": "ready" if not missing_sides else "needs_attention",
                "detail": (
                    "Red and Blue teams are enrolled."
                    if not missing_sides
                    else "Enroll at least one "
                    + " and ".join(side.title() for side in missing_sides)
                    + " participant."
                ),
            },
        )
    required = [check for check in checks if check["required"]]
    ready_count = sum(1 for check in checks if check["state"] == "ready")
    issue_count = sum(1 for check in checks if check["state"] == "needs_attention")
    blocking_issue_count = sum(1 for check in required if check["state"] == "needs_attention")
    starting_count = sum(1 for check in checks if check["state"] == "starting")
    if required and all(check["state"] == "ready" for check in required):
        mood = "ready"
        summary = "The range is ready for play."
    elif blocking_issue_count:
        mood = "needs_attention"
        summary = "The range needs an operator check."
    else:
        mood = "starting"
        summary = "The range is still preparing."
    return {
        "drill_id": drill.id,
        "run_id": run_id,
        "scenario": {
            "id": scenario.id if scenario else None,
            "name": scenario.name if scenario else None,
            "title": scenario.title if scenario else None,
        },
        "mood": mood,
        "summary": summary,
        "counts": {
            "ready": ready_count,
            "starting": starting_count,
            "needs_attention": issue_count,
            "total": len(checks),
        },
        "checks": checks,
        "checked_at": datetime.now(UTC).isoformat(),
    }
