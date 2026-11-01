"""Admin/setup endpoints for the PVE setup wizard.

Exposed at ``/api/v1/admin/*``. All routes in this module require an
``X-Divide-Token`` header carrying a token whose role is in the
``admin`` allow-list (see :class:`app.core.auth.Role` and
:func:`app.core.auth.require_role`). The gate is registered at the
router level so it's applied uniformly to every endpoint here,
including future additions. Routes:

  * ``GET  /probe``                         — one-shot PVE snapshot
  * ``GET  /storage``                       — list storage pools
  * ``POST /upload-qcow2``                  — upload a cloud image (multipart)
  * ``POST /create-template``               — turn an uploaded qcow2 into a template
  * ``POST /set-template/{vmid}``           — flip template=1 on existing VM
  * ``GET  /progress/{kind}/{job_id}``      — poll a job's status
  * ``GET  /progress``                      — list in-flight jobs
  * ``GET  /drill-template-status``         — does the canonical template exist?
  * ``POST /start-first-drill``             — convenience: run first-live-drill

Security note: this whole module used to be LAN-only. As of L2 2.9
it's hard-gated on admin role. The setup wizard runs in the
operator's browser, mints an admin token via ``tools/issue_token.py``
during step 1, and forwards it on every ``fetch()`` call (see
``README.md §8``). The user-facing portals (``/``)
do not hit any ``/admin/*`` endpoint.
"""

from __future__ import annotations

import ipaddress
import os
from pathlib import Path
from typing import Annotated, Any

import structlog
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Role, TokenData, current_token, require_role
from app.db import models as db_models
from app.db.models_oxblood import Drill, DrillStatus
from app.db.session import get_session
from app.runners.runner import RunnerError, build_runner
from app.services import admin as admin_svc
from app.services import orphan_cleanup as orphan_svc
from app.services import pve_config as pve_config_svc
from app.services.proxmox import (
    ProxmoxAPIError,
    ProxmoxNotConfiguredError,
    list_storage,
    list_virtual_machines,
)
from app.services.proxmox import (
    clear_cache as clear_proxmox_cache,
)

log = structlog.get_logger()

# Router-level gate: every endpoint in this module requires an admin
# token. ``dependencies=`` is a FastAPI feature that runs the listed
# dependencies before each route handler, but doesn't inject their
# return value into the handler signature. That's exactly what we
# want here -- the handler shouldn't care about the token, only the
# framework's auth check does. The ``require_role`` factory chains
# ``require_token`` underneath, so missing-header is 401 and
# wrong-role is 403.
router = APIRouter(dependencies=[Depends(require_role(Role.ADMIN))])


class ProbeResponse(BaseModel):
    reachable: bool
    version: str | None
    pve_user: str
    has_drill_privs: bool
    has_setup_privs: bool
    drill_privs_present: list[str]
    drill_privs_missing: list[str]
    setup_privs_present: list[str]
    setup_privs_missing: list[str]
    storage: list[dict[str, Any]]
    nodes: list[str]
    error: str | None = None


class CreateTemplateRequest(BaseModel):
    template_name: str
    source_volid: str
    node: str
    disk_storage: str = "local-lvm"
    cores: int = 2
    memory_mb: int = 2048
    disk_gb: int = 20
    # Optional bridge for net0. If unset, ``net0`` is omitted from the
    # VM config -- this lets the operator wire the network after creation
    # (or use the template with the runner's own bridge discovery). On
    # PVE hosts with SDN-managed bridges the default ``vmbr0`` requires
    # ``SDN.Use`` which drill tokens don't have.
    bridge: str | None = None
    job_id: str | None = None


class SetTemplateRequest(BaseModel):
    node: str


class StartFirstDrillRequest(BaseModel):
    """Body for ``POST /admin/start-first-drill``.

    Q14: added optional ``team`` field so the operator can name the
    team running the drill (matches POST /drills's team binding).
    """

    timeout_s: int = 300
    team: str | None = Field(
        default=None,
        max_length=128,
        description=(
            "Optional team name for the run (e.g. 'blue', 'red-team-A'). "
            "Matches the ``team`` field accepted by POST /api/v1/drills."
        ),
    )


class SnapshotBaselineRequest(BaseModel):
    snapshot_name: str = Field(default="clean-baseline", pattern=r"^[A-Za-z0-9_-]{1,40}$")


@router.get(
    "/probe",
    response_model=ProbeResponse,
    summary="One-shot PVE health + permissions snapshot for the wizard",
)
async def probe() -> ProbeResponse:
    """Probe PVE connectivity, version, perms, storage, nodes."""
    result = admin_svc.probe_pve()
    return ProbeResponse(**result.to_dict())


@router.get("/storage", summary="List PVE storage pools (for the wizard UI)")
async def storage_pools() -> dict[str, Any]:
    """Return list of storage pools for the upload dropdown."""
    try:
        clear_proxmox_cache()
        items = list_storage()
    except ProxmoxNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except ProxmoxAPIError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PVE unreachable: {exc}",
        ) from exc
    return {"items": items, "total": len(items)}


@router.post(
    "/snapshot-baselines/from-run/{run_id}",
    summary="Capture persistent scenario snapshots from a verified range",
)
async def capture_snapshot_baselines(
    run_id: int,
    data: SnapshotBaselineRequest,
    db: AsyncSession = Depends(get_session),
    token: TokenData = Depends(current_token),
) -> dict[str, Any]:
    """Stop a ready range once and capture its clean PVE snapshots."""
    run = await db.get(db_models.Run, run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")
    try:
        baselines = await build_runner().promote_run_to_snapshot_baseline(
            run_id,
            db,
            actor=token.sub,
            snapshot_name=data.snapshot_name,
        )
    except RunnerError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return {
        "scenario_id": run.scenario_id,
        "snapshot_name": data.snapshot_name,
        "baselines": [
            {"role": item.role, "vmid": item.pve_vmid, "node": item.pve_node, "status": item.status}
            for item in baselines
        ],
    }


UPLOAD_TMP_DIR = Path(os.environ.get("DIVIDE_UPLOAD_TMP_DIR", "/tmp/divide-uploads"))


@router.post(
    "/upload-qcow2",
    summary="Upload a cloud image (.qcow2) to PVE storage",
)
async def upload_qcow2(
    file: UploadFile = File(..., description="The .qcow2 file to upload"),  # noqa: B008
    node: str = Form(..., description="PVE node name (e.g. 'pve')"),  # noqa: B008
    storage: str = Form(..., description="Target storage (e.g. 'local')"),  # noqa: B008
    filename: str | None = Form(  # noqa: B008
        default=None,
        description="Override the filename PVE stores under. Defaults to the upload's name.",
    ),
) -> dict[str, Any]:
    """Stream the uploaded qcow2 to PVE, returning a job_id for progress polling."""
    # mkdir is a one-shot at the start of an upload; do it via os to
    # avoid the async-pathlib lint (this isn't on the hot path).
    os.makedirs(UPLOAD_TMP_DIR, exist_ok=True)
    target = UPLOAD_TMP_DIR / (filename or file.filename or "upload.qcow2")

    written = 0
    with target.open("wb") as fh:
        while True:
            chunk = await file.read(64 * 1024)
            if not chunk:
                break
            fh.write(chunk)
            written += len(chunk)

    if written == 0:
        target.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="empty upload",
        )

    try:
        progress = await admin_svc.upload_qcow2(
            local_path=target,
            node=node,
            storage=storage,
            filename=filename or file.filename,
        )
    finally:
        target.unlink(missing_ok=True)

    if progress.status == "error":
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=progress.error or "PVE upload failed",
        )

    return progress.to_dict()


@router.post(
    "/create-template",
    summary="Create a PVE template VM from an uploaded qcow2",
)
async def create_template(
    body: CreateTemplateRequest, background_tasks: BackgroundTasks
) -> dict[str, Any]:
    """Kick off template creation. Returns immediately with a job_id.

    The actual creation runs in a background task (the import step alone
    can take 30s+ for a 270 MB image). Poll ``/progress/template/{job_id}``.
    """
    background_tasks.add_task(
        admin_svc.create_template_from_qcow2,
        body.template_name,
        body.source_volid,
        body.node,
        disk_storage=body.disk_storage,
        cores=body.cores,
        memory_mb=body.memory_mb,
        disk_gb=body.disk_gb,
        bridge=body.bridge,
        job_id=body.job_id,
    )
    return {
        "job_id": body.job_id,
        "status": "pending",
        "step": "queued",
        "template_name": body.template_name,
        "vmid": None,
        "message": "creation queued; poll /api/v1/admin/progress/template/{job_id}",
    }


@router.post(
    "/set-template/{vmid}",
    summary="Flip template=1 on an existing VM (manual-install path)",
)
async def set_template(vmid: int, body: SetTemplateRequest) -> dict[str, Any]:
    """The wizard uses this when the operator chose 'manual install via ISO'."""
    try:
        await admin_svc.set_template_flag(vmid, body.node)
    except ProxmoxAPIError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PVE error: {exc}",
        ) from exc
    except ProxmoxNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    return {"vmid": vmid, "template": True, "node": body.node}


@router.get(
    "/progress/{kind}/{job_id}",
    summary="Poll a setup job's progress",
)
async def get_job_progress(kind: str, job_id: str) -> dict[str, Any]:
    if kind not in ("upload", "template"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unknown kind: {kind!r} (expected 'upload' or 'template')",
        )
    progress = await admin_svc.get_progress(job_id, kind=kind)
    if progress is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"job {job_id!r} ({kind}) not found or expired",
        )
    return progress


@router.get(
    "/progress",
    summary="List in-flight setup jobs",
)
async def list_progress() -> dict[str, Any]:
    items = await admin_svc.list_in_progress()
    return {"items": items, "total": len(items)}


@router.get(
    "/drill-template-status",
    summary="Is the current drill template set ready?",
)
async def drill_template_status() -> dict[str, Any]:
    """Check that the role-specific catalog has at least one PVE template."""
    from app.services.proxmox import list_templates

    try:
        templates = list_templates()
    except (ProxmoxAPIError, ProxmoxNotConfiguredError) as exc:
        return {
            "ready": False,
            "template": None,
            "error": f"{exc.__class__.__name__}: {exc}",
        }

    available = sorted(str(t.get("name")) for t in templates if t.get("name"))
    return {
        "ready": bool(available),
        "template": None,
        "available": available,
        "error": None if available else "no PVE templates found",
    }


@router.get("/pve-guests", summary="Current Proxmox guest inventory")
async def pve_guest_inventory(
    drill_only: bool = False,
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Read live guest state for the operator dashboard (admin-only router)."""
    try:
        items = list_virtual_machines()
    except ProxmoxNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ProxmoxAPIError as exc:
        raise HTTPException(
            status_code=502, detail=f"Proxmox inventory unavailable: {exc}"
        ) from exc
    if not drill_only:
        return {"items": items, "total": len(items)}

    # Snapshot baselines are persistent drill VMs. Include assets from current
    # drill runs for scenarios that still use disposable provisioning.
    registered = {
        int(vmid)
        for vmid in (await db.execute(select(db_models.SnapshotBaseline.pve_vmid))).scalars()
    }
    environments = (
        await db.execute(
            select(Drill.environment_config).where(
                Drill.status.in_((DrillStatus.SCHEDULED, DrillStatus.ACTIVE, DrillStatus.PAUSED)),
                Drill.deleted_at.is_(None),
            )
        )
    ).scalars()
    run_ids = {
        int(env["provision_run_id"])
        for env in environments
        if isinstance(env, dict) and env.get("provision_run_id")
    }
    if run_ids:
        vmids = (
            await db.execute(
                select(db_models.Asset.pve_vmid).where(
                    db_models.Asset.run_id.in_(run_ids),
                    db_models.Asset.pve_vmid.is_not(None),
                    db_models.Asset.cleaned_at.is_(None),
                )
            )
        ).scalars()
        registered.update(int(vmid) for vmid in vmids)
    scoped = [guest for guest in items if int(guest["vmid"]) in registered]
    return {"items": scoped, "total": len(scoped), "total_registered": len(registered)}


@router.post(
    "/start-first-drill",
    summary="Convenience: start the first-live-drill scenario",
)
async def start_first_drill(
    body: StartFirstDrillRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    token=Depends(current_token),
) -> dict[str, Any]:
    """Run the canonical L1 demo drill.

    Q14: was a loopback HTTP call to ``/api/v1/drills`` which
    required ``X-Divide-Token`` to be forwarded. The forward
    was missing, so every call returned a doubly-nested 401.
    Rewritten to call the runner in-process:
      * look up the scenario in the same DB session,
      * build a RunRequest with the caller's token.sub,
      * call ``runner.start_run()`` directly,
      * return the result RunResult as JSON.

    This keeps the wizard's "Start first drill" button working
    without leaking auth tokens into a self-call.
    """
    from sqlalchemy import select

    from app.db import models as db_models
    from app.runners.runner import (
        RunnerError,
        RunRequest,
        build_runner,
    )
    from app.services.proxmox import ProxmoxAPIError
    from app.services.pve_sdn import SdnPermissionError

    scenario_name = "first-live-drill"
    scenario = (
        await session.execute(
            select(db_models.Scenario).where(
                db_models.Scenario.name == scenario_name,
                db_models.Scenario.archived_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if scenario is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"scenario {scenario_name!r} not in DB or is archived -- "
                "run 'make sync-scenarios' or restore it first"
            ),
        )

    runner = build_runner()
    try:
        result = await runner.start_run(
            RunRequest(
                scenario_id=scenario.id,
                started_by=token.sub,
                exercise_id=None,
                team=body.team,
                template_id=None,
            ),
            session,
        )
    except RunnerError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    except SdnPermissionError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "message": str(exc),
                "required_role": getattr(exc, "required_role", None),
                "pveum_hint": getattr(exc, "pveum_hint", None),
                "pve_path": getattr(exc, "pve_path", None),
            },
        ) from exc
    except ProxmoxAPIError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PVE unreachable: {exc}",
        ) from exc
    return {
        "run_id": result.run_id,
        "status": result.status.value,
        "scenario_id": scenario.id,
        "scenario_name": scenario_name,
        "team": body.team,
        "started_by": token.sub,
    }


# ---------------------------------------------------------------------------
# F-pve-bridge-wizard: PVE bridge provisioning
# ---------------------------------------------------------------------------
#
# Three endpoints, used by the wizard's Step 0 + by the CLI escape
# hatch (tools/pve_setup_bridges.py):
#
#   GET  /api/v1/admin/expected-bridges   -- pure DB read
#   GET  /api/v1/admin/pve-bridge-status  -- expected vs actual on PVE
#   POST /api/v1/admin/pve-setup-bridges  -- SSH into PVE, write drop-in


class ExpectedBridge(BaseModel):
    name: str
    cidr: str
    gateway_ip: str
    scenario: str
    network: str


class ExpectedBridgesResponse(BaseModel):
    bridges: list[ExpectedBridge]
    conflicts: list[str]


class PveBridgeStatusResponse(BaseModel):
    node: str
    expected: list[str]
    present: list[str]
    missing: list[str]
    ready: bool


class PveSetupBridgesRequest(BaseModel):
    """Body for ``POST /admin/pve-setup-bridges``.

    F-pve-bridge-wizard (SDN variant): the wizard no longer collects
    SSH credentials in the browser. The credentials are whatever was
    saved in Step -1 (``POST /admin/pve-config``) or the env-var
    fallback. The request body only carries operational flags.
    """

    dry_run: bool = Field(
        default=False,
        description=(
            "If true, return the would-be SDN POST list without "
            "actually calling PVE. Useful for the wizard's pre-flight."
        ),
    )
    node: str = Field(
        default="pve",
        max_length=64,
        description=(
            "PVE node name to verify bridges on. Defaults to 'pve'; "
            "override when the runner is pinned to a specific node."
        ),
    )


@router.get(
    "/expected-bridges",
    summary="List the bridges the runner expects on PVE",
)
async def get_expected_bridges(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ExpectedBridgesResponse:
    """Pure DB read; no PVE interaction."""
    from app.services.pve_bridges import plan_bridges_from_db

    plan = await plan_bridges_from_db(session)
    return ExpectedBridgesResponse(
        bridges=[
            ExpectedBridge(
                name=b.name,
                cidr=b.cidr,
                gateway_ip=b.gateway_ip,
                scenario=b.scenario,
                network=b.network,
            )
            for b in plan.bridges
        ],
        conflicts=plan.conflicts,
    )


@router.get(
    "/pve-bridge-status",
    summary="Which expected bridges are missing on PVE?",
)
async def get_pve_bridge_status(
    node: str = "pve",
    session: Annotated[AsyncSession, Depends(get_session)] = None,  # type: ignore[assignment]
) -> PveBridgeStatusResponse:
    """Cross-reference expected with actual PVE state."""
    from app.services.pve_bridges import (
        fetch_present_bridges,
        plan_bridges_from_db,
    )

    plan = await plan_bridges_from_db(session)
    expected = [b.name for b in plan.bridges]
    present = await fetch_present_bridges(node)
    missing = [n for n in expected if n not in present]
    return PveBridgeStatusResponse(
        node=node,
        expected=expected,
        present=sorted(present),
        missing=missing,
        ready=not missing,
    )


# --- SDN readiness probe (F-pve-bridge-wizard, SDN variant) -------------
#
# The wizard's Step 0 needs to know whether the active PVE token has
# ``SDN.Allocate`` permission *before* the operator clicks the
# "Set up bridges" button. This endpoint runs the same probe the
# applier uses, but in read-only form, and returns a structured
# SdnReadiness the UI can render directly.
#
# Returns 200 even on permission failure -- the wizard needs the
# error structure, not a 4xx, so it can render the remediation card.


@router.get(
    "/pve-sdn-status",
    summary="Are PVE drill bridges present for active scenarios?",
)
async def get_pve_sdn_status(
    session: Annotated[AsyncSession, Depends(get_session)],
    node: str = "pve",
) -> dict[str, Any]:
    """Probe PVE's node bridge state without creating anything.

    The setup UI applies bridges with the direct node network API, so
    readiness must check that same surface. We keep the legacy
    ``vnets_*`` response keys for UI/test compatibility, but the values
    are Linux bridge interface names.
    """
    from app.services.pve_bridges import plan_bridges_from_db
    from app.services.pve_sdn import (
        SdnError,
        SdnPermissionError,
        get_active_auth,
        list_node_ifaces,
    )

    plan = await plan_bridges_from_db(session)
    expected = [b.name for b in plan.bridges]

    try:
        auth = get_active_auth(node=node)
    except SdnError as exc:
        # No creds configured -- operator must complete Step -1 first.
        return {
            "reachable": False,
            "zone_present": False,
            "zone_name": "divide",
            "vnets_present": [],
            "vnets_missing": expected,
            "error": str(exc),
            "pveum_hint": None,
            "required_role": None,
        }

    try:
        ifaces = await list_node_ifaces(auth)
        by_iface = {
            i.get("iface"): i
            for i in ifaces
            if i.get("iface") and (i.get("type") or "").lower() == "bridge"
        }
        present_set = set()
        for bridge in plan.bridges:
            iface = by_iface.get(bridge.name)
            if not iface or str(iface.get("active")) != "1":
                continue
            # VLAN scenarios intentionally keep the shared bridge unnumbered;
            # the guest VLAN tags, not a host gateway address, provide the
            # isolation. An IP/CIDR check would falsely mark vmbr200 missing.
            if bridge.network == "vlan-aware":
                present_set.add(bridge.name)
                continue
            try:
                expected_gateway = str(
                    next(ipaddress.ip_network(bridge.cidr, strict=False).hosts())
                )
            except (StopIteration, ValueError):
                expected_gateway = ""
            pve_cidr = str(iface.get("cidr") or "")
            pve_address = str(iface.get("address") or "")
            if (
                not expected_gateway
                or pve_address == expected_gateway
                or pve_cidr.startswith(f"{expected_gateway}/")
            ):
                present_set.add(bridge.name)
        return {
            "reachable": True,
            "zone_present": True,
            "zone_name": "direct",
            "vnets_present": [n for n in expected if n in present_set],
            "vnets_missing": [n for n in expected if n not in present_set],
            "error": None,
            "pveum_hint": None,
            "required_role": None,
        }
    except SdnPermissionError as exc:
        return {
            "reachable": True,
            "zone_present": False,
            "zone_name": "direct",
            "vnets_present": [],
            "vnets_missing": expected,
            "error": str(exc),
            "pveum_hint": exc.pveum_hint,
            "required_role": exc.required_role,
        }
    except SdnError as exc:
        log.warning("pve_sdn.status_failed", error=str(exc))
        return {
            "reachable": False,
            "zone_present": False,
            "zone_name": "direct",
            "vnets_present": [],
            "vnets_missing": expected,
            "error": str(exc),
            "pveum_hint": None,
            "required_role": None,
        }


class PveSetupBridgesResponse(BaseModel):
    ok: bool
    added: list[str]
    already_present: list[str]
    reload_ok: bool
    reload_method: str
    verify_ok: bool
    config_path: str
    dry_run: bool
    message: str


@router.post(
    "/pve-setup-bridges",
    summary="Create the F3 bridges on PVE",
)
async def post_pve_setup_bridges(
    body: PveSetupBridgesRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PveSetupBridgesResponse:
    """Realize the bridge plan on PVE.

    The default implementation (PVE 9 single-node friendly) POSTs
    directly to PVE's node-level network API
    (``/nodes/{n}/network``) which creates Linux bridges on the node
    without requiring an external SDN controller. Set
    ``method="sdn"`` in the request to fall back to the legacy
    SDN zone/vnet path (needs ``SDN.Allocate`` and a controller
    that materializes the bridges on PVE 9).

    Uses the credentials already saved in Step -1 of the wizard
    (``pve_config`` DB row, with env-var fallback).

    Errors:
      * 403 -- PVE rejected the create POST due to a missing
        privilege (``Sys.Modify`` for the direct path,
        ``SDN.Allocate`` for the SDN path). The response carries a
        copy-pasteable ``pveum`` remediation hint.
      * 409 -- bridge plan has conflicts (resolve scenario CIDRs first)
      * 502 -- PVE rejected the request for a non-permission reason.
      * 503 -- no PVE creds configured yet (complete Step -1 first)
    """
    from app.services.pve_bridges import (
        BridgePlanError,
        plan_bridges_from_db,
    )
    from app.services.pve_sdn import (
        SdnError,
        SdnPermissionError,
        apply_direct_plan,
        get_active_auth,
    )

    plan = await plan_bridges_from_db(session)
    if plan.conflicts:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "bridge plan has conflicts; resolve before applying: " + "; ".join(plan.conflicts)
            ),
        )
    if not plan.bridges:
        return PveSetupBridgesResponse(
            ok=True,
            added=[],
            already_present=[],
            reload_ok=True,
            reload_method="none",
            verify_ok=True,
            config_path="",
            dry_run=body.dry_run,
            message="no bridges required by any active scenario",
        )

    try:
        auth = get_active_auth(node=body.node)
    except SdnError as exc:
        # No creds yet -- wizard must complete Step -1 first.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                f"{exc} -- complete wizard Step -1 (PVE credentials) "
                "or set PROXMOX_* env vars in deploy/.env."
            ),
        ) from exc

    if body.dry_run:
        return PveSetupBridgesResponse(
            ok=True,
            added=[],
            already_present=[],
            reload_ok=True,
            reload_method="direct-dry-run",
            verify_ok=True,
            config_path=f"/nodes/{auth.node}/network",
            dry_run=True,
            message=(
                f"dry_run: would create {len(plan.bridges)} bridge(s) on PVE node "
                f"{auth.node} ({auth.base_url})"
            ),
        )

    try:
        sdn = await apply_direct_plan(plan, auth=auth)
    except SdnPermissionError as exc:
        # PVE said "Permission check failed (/nodes/{n}, Sys.Modify)"
        # (or /sdn if method=sdn). Surface the literal PVE message
        # + a copy-pasteable pveum hint so the wizard can render a
        # remediation card.
        log.warning(
            "pve_sdn.apply.permission_denied",
            host=auth.base_url,
            role=exc.required_role,
            error=str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "message": str(exc),
                "required_role": exc.required_role,
                "pveum_hint": exc.pveum_hint,
                "pve_path": exc.pve_path,
            },
        ) from exc
    except SdnError as exc:
        log.warning(
            "pve_sdn.apply.failed",
            host=auth.base_url,
            error=str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PVE rejected the request: {exc}",
        ) from exc
    except BridgePlanError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    reload_method = "direct" if sdn.vnets_created else "direct-noop"
    return PveSetupBridgesResponse(
        ok=sdn.propagate_ok,
        added=sdn.vnets_created,
        already_present=sdn.vnets_already_present,
        reload_ok=sdn.propagate_ok,
        reload_method=reload_method,
        verify_ok=sdn.propagate_ok,
        config_path=f"/nodes/{auth.node}/network",
        dry_run=False,
        message=(
            f"created {len(sdn.vnets_created)} Linux bridge(s) on PVE "
            f"node {auth.node}; propagation "
            f"{'ok' if sdn.propagate_ok else 'TIMED OUT'} after "
            f"{sdn.propagation_wait_s:.1f}s"
        ),
    )


# ---------------------------------------------------------------------------
# PVE runtime config (day-1 web setup; precedes Step0 in the wizard)
# ---------------------------------------------------------------------------
#
# These three endpoints let the onboarding wizard collect the PVE host /
# user / token from the browser instead of requiring ``deploy/.env``
# edits + container restart. ``POST`` probes PVE first (so a typo is
# surfaced before commit), then writes the singleton row in
# ``pve_config``. The very next PVE call (admin probe, run start,
# template upload, etc.) honors the new credentials because the
# admin router calls ``set_db_overlay`` after the commit, which
# drops both ``get_proxmox_client``'s LRU cache and the TTL cache.
#
# ``GET`` returns either the DB row (token_secret masked) or the env-var
# fallback if no row exists, with ``source`` set accordingly so the
# wizard can render a banner.
#
# ``DELETE`` drops the DB row and reverts to env-var resolution. Useful
# as an escape hatch: an operator who wants to "go back to .env" can do
# it from the admin UI without touching the host.


class PveConfigPayload(BaseModel):
    """Request body for ``POST /api/v1/admin/pve-config``.

    The token_secret is in the clear because we need to hand it to
    proxmoxer; the response always masks it. We never log it.
    """

    host: str = Field(..., min_length=1, max_length=255, description="e.g. https://192.168.0.10")
    port: int = Field(default=8006, ge=1, le=65535)
    user: str = Field(..., min_length=1, max_length=255, description="e.g. divide@pve@pam")
    token_id: str = Field(
        ..., min_length=1, max_length=255, description="e.g. divide@pve@pam!drill-token"
    )
    token_secret: str = Field(..., min_length=1, max_length=255)
    verify_ssl: bool = Field(
        default=False, description="False for self-signed certs (default for home/lab PVE)"
    )
    node: str | None = Field(
        default=None, max_length=64, description="Optional node name; auto-detected when omitted"
    )
    clone_storage: str = Field(default="", max_length=64)
    seed_snippet_storage: str = Field(default="", max_length=64)


def _storage_check(
    storages: list[dict[str, Any]],
    storage_name: str,
    required_content: str,
) -> dict[str, Any]:
    match = next(
        (
            item
            for item in storages
            if str(item.get("storage") or item.get("name") or "") == storage_name
        ),
        None,
    )
    if match is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"storage {storage_name!r} does not exist on PVE",
        )
    content = match.get("content") or []
    if isinstance(content, str):
        content = [part.strip() for part in content.split(",") if part.strip()]
    active = bool(match.get("active", True))
    if not active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"storage {storage_name!r} is not active",
        )
    if required_content not in content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"storage {storage_name!r} must allow {required_content!r} "
                f"content; current content={content}"
            ),
        )
    free_bytes = match.get("free_bytes")
    total_bytes = match.get("total_bytes")
    warn_low_space = (
        isinstance(free_bytes, int)
        and isinstance(total_bytes, int)
        and total_bytes > 0
        and free_bytes / total_bytes < 0.15
    )
    return {
        "storage": storage_name,
        "required_content": required_content,
        "content": content,
        "active": active,
        "free_bytes": free_bytes,
        "total_bytes": total_bytes,
        "warn_low_space": warn_low_space,
    }


@router.get(
    "/pve-config",
    summary="Get the active PVE connection config (DB or env).",
    description=(
        "Returns the singleton PVE config the API is currently using. "
        "If a row exists in `pve_config`, that's returned with "
        "`source=db` and `token_secret` masked as `***`. If no row "
        "exists, the env-var fallback is returned with `source=env` "
        "and `token_secret=***` (we don't have the env value here)."
    ),
)
async def get_pve_config(
    db: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    row = await pve_config_svc.get_config(db)
    if row is not None:
        return row.to_public_dict()
    return pve_config_svc.env_source_dict()


@router.post(
    "/pve-config",
    summary="Write (or replace) the PVE runtime config.",
    description=(
        "Probes PVE with the supplied credentials first; commits only "
        "if the probe succeeds. After commit, the in-process overlay "
        "is refreshed so the next PVE call picks up the new creds -- "
        "no container restart required. Use `DELETE` to revert to the "
        "env-var fallback."
    ),
)
async def post_pve_config(
    body: PveConfigPayload,
    db: Annotated[AsyncSession, Depends(get_session)],
    token: Annotated[TokenData, Depends(require_role(Role.ADMIN))],
) -> dict[str, Any]:
    """Validate, probe, persist, hydrate.

    Status codes:
      * 200 -- creds accepted, row written
      * 400 -- validation failed (Pydantic or service-level)
      * 502 -- PVE rejected the creds (probe-before-commit caught it)
    """
    # Write the new creds into the overlay so the probe uses them
    # (without committing to the DB yet). If the probe fails the
    # operator sees the actual PVE error and we abort -- no DB churn.
    from app.core.config import settings as _settings
    from app.services.proxmox import set_db_overlay

    clone_storage = (
        (body.clone_storage or "").strip() or _settings.proxmox.clone_storage or "local-lvm"
    )
    seed_snippet_storage = (
        (body.seed_snippet_storage or "").strip()
        or _settings.proxmox.seed_snippet_storage
        or "local"
    )

    set_db_overlay(
        {
            "host": body.host,
            "port": body.port,
            "user": body.user,
            "token_id": body.token_id,
            "token_secret": body.token_secret,
            "verify_ssl": body.verify_ssl,
            "node": body.node,
            "clone_storage": clone_storage,
            "seed_snippet_storage": seed_snippet_storage,
        }
    )
    from app.services.proxmox import ProxmoxAPIError, ProxmoxNotConfiguredError, get_version

    try:
        get_version()
        storages = list_storage()
    except (ProxmoxNotConfiguredError, ProxmoxAPIError) as exc:
        # Probe failed. Roll overlay back to None so the next call
        # goes to env vars (whichever was active before). Better than
        # leaving a partial overlay hanging around.
        set_db_overlay(None)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PVE rejected the supplied credentials: {exc}",
        ) from exc
    try:
        storage_checks = {
            "clone_storage": _storage_check(storages, clone_storage, "images"),
            "seed_snippet_storage": _storage_check(storages, seed_snippet_storage, "snippets"),
        }
    except HTTPException:
        set_db_overlay(None)
        raise
    # Probe ok. Persist.
    try:
        row = await pve_config_svc.upsert_config(
            db,
            host=body.host,
            port=body.port,
            user=body.user,
            token_id=body.token_id,
            token_secret=body.token_secret,
            verify_ssl=body.verify_ssl,
            node=body.node,
            updated_by=token.sub,
            clone_storage=clone_storage,
            seed_snippet_storage=seed_snippet_storage,
        )
    except pve_config_svc.PveConfigError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    log.info(
        "pve_config.upsert",
        host=body.host,
        user=body.user,
        token_id=body.token_id,
        updated_by=token.sub,
    )
    return {
        **row.to_public_dict(),
        "probed": True,
        "storage_checks": storage_checks,
        "message": "PVE accepted the credentials. Wizard can advance.",
    }


@router.delete(
    "/pve-config",
    summary="Drop the PVE config row; revert to env-var resolution.",
    description=(
        "Useful for operators who want to 'go back to deploy/.env' "
        "without touching the host. After delete, the API falls back "
        "to the `PROXMOX_*` env vars on the next PVE call. No-op if "
        "no row exists."
    ),
)
async def delete_pve_config(
    db: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    deleted = await pve_config_svc.delete_config(db)
    # Refresh overlay so the next PVE call goes back to env.
    from app.services.proxmox import set_db_overlay

    set_db_overlay(None)
    log.info("pve_config.delete", deleted=deleted)
    return {
        "deleted": deleted,
        "message": (
            "DB row deleted; API now resolves PVE creds from PROXMOX_* env vars."
            if deleted
            else "No DB row to delete; API is already on env-var fallback."
        ),
    }


# -- orphan-asset janitor (Q22) -------------------------------------------
#
# Iterates Asset rows where status == ORPHANED (set by the Q17 teardown
# loop when destroy_vm failed) and retries the destroy. Two flavours:
#
#   * GET  /assets/orphans   -- dry-run preview, used by the UI's modal
#   * POST /assets/cleanup   -- actually calls destroy_vm. Idempotent.
#
# Both honour the same skip rules (grace period, live runs, missing
# VMID). The runner gives us the same adapter that started the drill,
# so credentials + node config match.


class OrphanCandidate(BaseModel):
    """One asset row that's a cleanup candidate."""

    source: str = "db_orphan"
    asset_id: int
    run_id: int
    run_status: str
    role: str
    pve_vmid: int | None
    pve_node: str | None
    pve_name: str | None = None
    reason: str | None = None
    error: str | None
    age_seconds: int


class OrphanListResponse(BaseModel):
    items: list[OrphanCandidate]
    total: int


class CleanupFailureItem(BaseModel):
    asset_id: int
    run_id: int
    pve_vmid: int | None
    error: str


class CleanupRequest(BaseModel):
    """Body for POST /assets/cleanup.

    ``asset_ids``: when set, only these ids are considered; ``null``
    means "every orphan" (subject to grace + run-status filters).
    ``grace_minutes``: skip orphans younger than this; default 5.
    """

    asset_ids: list[int] | None = None
    pve_vms: list[dict[str, Any]] | None = None
    grace_minutes: int = Field(default=5, ge=0, le=1440)


class CleanupResponse(BaseModel):
    scanned: int
    destroyed: int
    destroyed_pve: int = 0
    failed: list[CleanupFailureItem]
    skipped_running: list[int]


@router.get(
    "/assets/orphans",
    summary="List Asset rows in ORPHANED state (dry-run cleanup preview)",
)
async def list_orphan_assets(
    db: Annotated[AsyncSession, Depends(get_session)],
    grace_minutes: int = 5,
    asset_ids: str | None = None,
    token: Annotated[TokenData, Depends(require_role(Role.ADMIN))] = None,
) -> OrphanListResponse:
    """Preview what ``POST /assets/cleanup`` would do.

    ``asset_ids`` is a comma-separated list (query string), ``null``
    means every orphan.
    """
    ids: list[int] | None = None
    if asset_ids:
        try:
            ids = [int(s) for s in asset_ids.split(",") if s.strip()]
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"asset_ids must be comma-separated ints: {exc}",
            ) from exc
    candidates = await orphan_svc.list_orphans(db, grace_minutes=grace_minutes, asset_ids=ids)
    pve_candidates = (
        []
        if ids is not None
        else await orphan_svc.list_pve_unused_vms(db, grace_minutes=grace_minutes)
    )
    return OrphanListResponse(
        items=[
            OrphanCandidate(
                source="db_orphan",
                asset_id=c.asset_id,
                run_id=c.run_id,
                run_status=c.run_status,
                role=c.role,
                pve_vmid=c.pve_vmid,
                pve_node=c.pve_node,
                reason="DB asset status is orphaned",
                error=c.error,
                age_seconds=c.age_seconds,
            )
            for c in candidates
        ]
        + [
            OrphanCandidate(
                source="pve_unused",
                asset_id=c.asset_id or 0,
                run_id=c.run_id or 0,
                run_status="unused",
                role=c.role or "unknown",
                pve_vmid=c.vmid,
                pve_node=c.node,
                pve_name=c.name,
                reason=c.reason,
                error=None,
                age_seconds=c.age_seconds,
            )
            for c in pve_candidates
        ],
        total=len(candidates) + len(pve_candidates),
    )


@router.post(
    "/assets/cleanup",
    summary="Retry destroy_vm on ORPHANED assets (idempotent)",
)
async def cleanup_orphan_assets(
    body: CleanupRequest,
    db: Annotated[AsyncSession, Depends(get_session)],
    token: Annotated[TokenData, Depends(require_role(Role.ADMIN))] = None,
) -> CleanupResponse:
    """Best-effort destroy every orphan matching the request body.

    Successful releases flip ``Asset.status`` to STOPPED and stamp
    ``cleaned_at``; failed retries stay ORPHANED with a fresh error.
    Each success writes one ``asset.cleaned`` audit row with
    ``actor = token.sub``.
    """
    actor = getattr(token, "sub", "unknown") if token else "unknown"
    runner = build_runner()
    adapter = runner._adapter  # noqa: SLF001 -- janitor uses the same
    # adapter that runs drills, so credentials + node match.
    try:
        result = await orphan_svc.cleanup_orphans(
            db,
            adapter,
            actor,
            grace_minutes=body.grace_minutes,
            asset_ids=body.asset_ids,
        )
        if body.pve_vms:
            pve_result = await orphan_svc.cleanup_pve_unused_vms(
                db,
                adapter,
                actor,
                targets=body.pve_vms,
            )
            result.scanned += pve_result.scanned
            result.destroyed += pve_result.destroyed
            result.destroyed_pve += pve_result.destroyed_pve
            result.failed.extend(pve_result.failed)
            result.skipped_running.extend(pve_result.skipped_running)
    except ProxmoxAPIError as exc:
        # PVE-side failure: return 502 rather than crashing 500.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"PVE unreachable: {exc}",
        ) from exc
    return CleanupResponse(
        scanned=result.scanned,
        destroyed=result.destroyed,
        destroyed_pve=result.destroyed_pve,
        failed=[
            CleanupFailureItem(
                asset_id=f.asset_id,
                run_id=f.run_id,
                pve_vmid=f.pve_vmid,
                error=f.error,
            )
            for f in result.failed
        ],
        skipped_running=result.skipped_running,
    )


# -- service-status aggregator --------------------------------------------
#
# Aggregates PVE / wg-easy / WireGuard env / disk / audit recency into a
# single read-only snapshot for the Config tab's "Deployment status"
# panel. Authenticated (admin or lead) so we don't leak env-derived
# signals to anonymous callers, but no role gate beyond login -- the
# existing probe endpoints have the same posture.

from app.services import service_status as service_status_svc  # noqa: E402


@router.get(
    "/public-settings",
    summary="Non-secret runtime settings for the Setup page (admin only)",
)
async def get_public_settings() -> dict[str, Any]:
    """Return display-only, non-secret settings.

    Everything here is safe to render in the portal: token TTL,
    timeouts, sync intervals, scenario dirs, WG host/subnet (no
    secrets), CORS origins. Secrets (WG peer secret, MinIO keys,
    PVE creds) are never included — PVE creds live behind
    GET /admin/pve-config (masked), the rest are env-only.
    """
    from app.core.config import settings as _settings

    return {
        "env": _settings.env,
        "login_token_ttl_s": _settings.login_token_ttl_s,
        "drill_timeout_enabled": _settings.drill_timeout_enabled,
        "drill_timeout_min": _settings.drill_timeout_min,
        "pve_sync_interval_sec": _settings.pve_sync_interval_sec,
        "pve_clone_storage": _settings.proxmox.clone_storage,
        "pve_seed_snippet_storage": _settings.proxmox.seed_snippet_storage,
        "orphan_janitor_enabled": _settings.orphan_janitor_enabled,
        "scenarios_dir": _settings.scenarios_dir,
        "wg_host": _settings.wg_host or None,
        "wg_subnet": _settings.wg_subnet,
        "wg_dns": _settings.wg_dns,
        "wg_port": _settings.wg_port,
        "cors_allow_origins": _settings.cors_allow_origins,
    }


@router.get(
    "/service-status",
    summary="Aggregated runtime status for the Config tab's deployment panel",
)
async def get_service_status(
    db: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    """Read-only aggregator. Fails soft: one bad probe never blocks
    the rest. Polled on every Config tab Refresh.
    """
    return await service_status_svc.get_service_status(db)
