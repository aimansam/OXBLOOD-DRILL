"""PVE setup wizard: probe, storage, templates, uploads, first drill."""

from __future__ import annotations

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
from app.db.models_drill import Drill, DrillStatus
from app.db.session import get_session
from app.runners.runner import RunnerError, build_runner
from app.services import admin as admin_svc
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

# Router-level gate: every endpoint requires an admin token.
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
        registered.update(int(vmid) for vmid in vmids if vmid is not None)
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
