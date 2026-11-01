"""Q22: orphan-asset janitor.

Background
----------

Q17 wired the ``Asset.status`` flip to ``AssetStatus.ORPHANED``
when the teardown loop fails to ``destroy_vm``. The comment at
runner.py:736-744 explicitly says "an operator + future janitor
can clean up". The janitor didn't ship with Q17.

What this module does:

  * ``cleanup_orphans()`` -- iterate every asset where
    ``status == ORPHANED``, retry ``stop_vm(force=True) +
    destroy_vm``, flip to ``STOPPED`` on success and stamp
    ``cleaned_at``. Writes one ``asset.cleaned`` audit row per
    success.
  * ``list_orphans()`` -- dry-run variant used by the UI's
    preview pane and the janitor's own guard rails.

Policy:

  * ``asset.pve_vmid`` must be set -- an orphan that never got a
    VMID (e.g. clone failed at allocation) can't be cleaned via
    PVE; we leave those rows alone and skip with a note.
  * The owning run must be in a terminal status -- if a drill is
    still RUNNING/PENDING, the operator meant something else, so
    409 + skip.
  * ``grace_minutes`` (default 5) -- refuse to clean orphans
    younger than that. Avoids racing with in-progress teardown.
  * Idempotent -- destroy_vm on a missing VM is a no-op per
    ``adapter.py:118``; calling it twice is safe.

Audit:

  * One ``asset.cleaned`` row per asset successfully released.
  * Failed assets get ``asset.error`` updated with the new error
    text (overwriting the previous); they stay ``ORPHANED``.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Asset,
    AssetStatus,
    AuditAction,
    AuditLog,
    Run,
    RunStatus,
    SnapshotBaseline,
)
from app.runners.adapter import ProxmoxAdapter
from app.services.proxmox import ProxmoxAPIError, get_proxmox_client

log = structlog.get_logger(__name__)


# Default grace period before an orphan is eligible for cleanup.
# Tunable via the endpoint query param.
DEFAULT_GRACE_MINUTES = 5


async def _snapshot_baseline_vmids(session: AsyncSession) -> set[int]:
    """Return every VM reserved as persistent snapshot infrastructure.

    A baseline can be attached to a completed source run, so run and asset
    status alone are not a safe signal for destructive cleanup.  The baseline
    registry is the authority: registered VMIDs are never cleanup candidates.
    """
    rows = await session.execute(select(SnapshotBaseline.pve_vmid))
    return {int(vmid) for vmid in rows.scalars().all()}


@dataclass
class OrphanCandidate:
    """One asset row that's eligible for cleanup."""

    asset_id: int
    run_id: int
    run_status: str
    role: str
    pve_vmid: int | None
    pve_node: str | None
    error: str | None
    orphaned_at: datetime | None  # best-known "when did it become an orphan"
    age_seconds: int


@dataclass
class CleanupFailure:
    asset_id: int
    run_id: int
    pve_vmid: int | None
    error: str


@dataclass
class CleanupResult:
    scanned: int
    destroyed: int
    failed: list[CleanupFailure]
    skipped_running: list[int]  # asset ids we refused to touch
    destroyed_pve: int = 0

    def as_dict(self) -> dict:
        return {
            "scanned": self.scanned,
            "destroyed": self.destroyed,
            "failed": [
                {
                    "asset_id": f.asset_id,
                    "run_id": f.run_id,
                    "pve_vmid": f.pve_vmid,
                    "error": f.error,
                }
                for f in self.failed
            ],
            "skipped_running": list(self.skipped_running),
            "destroyed_pve": self.destroyed_pve,
        }


@dataclass
class PveVmCandidate:
    """A platform-owned VM found in PVE, not just via Asset.status=ORPHANED."""

    vmid: int
    node: str
    name: str
    status: str | None
    run_id: int | None
    asset_id: int | None
    role: str | None
    reason: str
    age_seconds: int


async def list_orphans(
    session: AsyncSession,
    *,
    grace_minutes: int = DEFAULT_GRACE_MINUTES,
    asset_ids: Iterable[int] | None = None,
) -> list[OrphanCandidate]:
    """Return the orphans that ``cleanup_orphans`` would act on.

    Honours the same skip rules as cleanup itself:

      * ``run.status in (RUNNING, PENDING)``  -- don't touch
      * ``asset.pve_vmid IS NULL``           -- nothing to destroy on PVE
      * ``asset.created_at`` newer than grace -- too fresh; teardown
                                              might still be in flight
    """
    now = datetime.now(UTC)
    grace_cutoff = now.timestamp() - grace_minutes * 60
    baseline_vmids = await _snapshot_baseline_vmids(session)
    stmt = (
        select(Asset, Run)
        .join(Run, Asset.run_id == Run.id)
        .where(Asset.status == AssetStatus.ORPHANED)
    )
    if asset_ids is not None:
        ids = list(asset_ids)
        if not ids:
            return []
        stmt = stmt.where(Asset.id.in_(ids))
    rows = (await session.execute(stmt)).all()
    out: list[OrphanCandidate] = []
    for asset, run in rows:
        # Orphaned-when is best-approximated by updated_at, falling
        # back to created_at when updated_at isn't set (older rows).
        stamp = asset.updated_at or asset.created_at
        if stamp is not None and stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=UTC)
        age = int(now.timestamp() - stamp.timestamp()) if stamp is not None else 0
        if run.status in (RunStatus.RUNNING, RunStatus.PENDING):
            continue
        if asset.pve_vmid is None:
            continue
        if int(asset.pve_vmid) in baseline_vmids:
            # Snapshot baselines are reusable range infrastructure, never
            # disposable orphan assets, even when their source run is done.
            continue
        # Only skip when younger than grace. Older orphans are fair game.
        if stamp is not None and stamp.timestamp() > grace_cutoff:
            continue
        out.append(
            OrphanCandidate(
                asset_id=asset.id,
                run_id=asset.run_id,
                run_status=run.status.value,
                role=asset.role,
                pve_vmid=asset.pve_vmid,
                pve_node=asset.pve_node,
                error=asset.error,
                orphaned_at=stamp,
                age_seconds=age,
            )
        )
    out.sort(key=lambda c: c.orphaned_at or now, reverse=False)
    return out


def _is_terminal_run(status: RunStatus | None) -> bool:
    return status in {
        RunStatus.SUCCEEDED,
        RunStatus.FAILED,
        RunStatus.CANCELLED,
        RunStatus.TIMEOUT,
    }


def _parse_divide_vm_name(name: str) -> tuple[int | None, str | None]:
    parts = str(name or "").split("-", 2)
    if len(parts) != 3 or parts[0] != "divide":
        return None, None
    try:
        return int(parts[1]), parts[2]
    except ValueError:
        return None, parts[2]


def _list_pve_divide_vms() -> list[dict]:
    try:
        raw = get_proxmox_client().cluster.resources.get(type="vm")
    except Exception as exc:  # noqa: BLE001
        raise ProxmoxAPIError(f"{type(exc).__name__}: {exc}") from exc
    out: list[dict] = []
    for vm in raw:
        name = str(vm.get("name") or "")
        if not name.startswith("divide-"):
            continue
        if vm.get("template"):
            continue
        vmid = vm.get("vmid")
        node = vm.get("node")
        if vmid is None or not node:
            continue
        out.append(
            {
                "vmid": int(vmid),
                "node": str(node),
                "name": name,
                "status": vm.get("status"),
            }
        )
    return out


async def list_pve_unused_vms(
    session: AsyncSession,
    *,
    grace_minutes: int = DEFAULT_GRACE_MINUTES,
) -> list[PveVmCandidate]:
    """Discover platform-owned VMs still present in PVE.

    This catches leaks that DB-orphan cleanup misses: assets marked failed or
    stopped without ``cleaned_at``, and VMs whose DB rows are missing.
    """
    now = datetime.now(UTC)
    grace_cutoff = now.timestamp() - grace_minutes * 60
    vms = _list_pve_divide_vms()
    if not vms:
        return []

    baseline_vmids = await _snapshot_baseline_vmids(session)
    vmids = [vm["vmid"] for vm in vms]
    asset_rows = (
        await session.execute(
            select(Asset, Run)
            .join(Run, Asset.run_id == Run.id, isouter=True)
            .where(Asset.pve_vmid.in_(vmids))
        )
    ).all()
    by_vmid: dict[int, list[tuple[Asset, Run | None]]] = {}
    by_vmid_run: dict[tuple[int, int], tuple[Asset, Run | None]] = {}
    for asset, run in asset_rows:
        if not asset.pve_vmid:
            continue
        vmid = int(asset.pve_vmid)
        by_vmid.setdefault(vmid, []).append((asset, run))
        by_vmid_run[(vmid, asset.run_id)] = (asset, run)

    out: list[PveVmCandidate] = []
    for vm in vms:
        vmid = int(vm["vmid"])
        if vmid in baseline_vmids:
            # A registered baseline is intentionally stopped between drills.
            # Do not expose it in cleanup, and therefore never permit it in
            # cleanup_pve_unused_vms()'s server-side allow-list.
            continue
        name = vm["name"]
        parsed_run_id, parsed_role = _parse_divide_vm_name(name)
        asset_run = by_vmid_run.get((vmid, parsed_run_id)) if parsed_run_id is not None else None
        if asset_run is None and len(by_vmid.get(vmid, [])) == 1:
            asset_run = by_vmid[vmid][0]
        if asset_run is None:
            reason = "not tracked in DB"
            run_id = parsed_run_id
            asset_id = None
            role = parsed_role
            age = grace_minutes * 60
        else:
            asset, run = asset_run
            run_id = asset.run_id
            asset_id = asset.id
            role = asset.role
            stamp = asset.updated_at or asset.created_at
            if stamp is not None and stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=UTC)
            age = int(now.timestamp() - stamp.timestamp()) if stamp else 0
            if run is not None and run.status in (RunStatus.RUNNING, RunStatus.PENDING):
                continue
            if stamp is not None and stamp.timestamp() > grace_cutoff:
                continue
            if asset.status == AssetStatus.ORPHANED:
                # Already listed by DB-orphan preview; avoid duplicate rows.
                continue
            if asset.cleaned_at is not None:
                reason = "DB says cleaned but VM still exists in PVE"
            elif run is not None and _is_terminal_run(run.status):
                reason = f"terminal run with leftover asset status {asset.status.value}"
            else:
                reason = f"unused asset status {asset.status.value}"
        out.append(
            PveVmCandidate(
                vmid=vmid,
                node=str(vm["node"]),
                name=name,
                status=vm.get("status"),
                run_id=run_id,
                asset_id=asset_id,
                role=role,
                reason=reason,
                age_seconds=age,
            )
        )
    out.sort(key=lambda c: (c.run_id or 0, c.vmid))
    return out


async def cleanup_orphans(
    session: AsyncSession,
    adapter: ProxmoxAdapter,
    actor: str,
    *,
    grace_minutes: int = DEFAULT_GRACE_MINUTES,
    asset_ids: Iterable[int] | None = None,
) -> CleanupResult:
    """Best-effort destroy every eligible orphan.

    Returns a CleanupResult summarising what was attempted. The
    endpoint translates this to JSON; the UI uses ``destroyed``
    and ``failed`` lengths for the toast.
    """
    candidates = await list_orphans(
        session,
        grace_minutes=grace_minutes,
        asset_ids=asset_ids,
    )
    failures: list[CleanupFailure] = []
    skipped: list[int] = []
    destroyed = 0

    # Re-query candidate asset rows so we have ORM-bound instances
    # to mutate + commit. ``list_orphans`` already validated the
    # shape; this is just the load-for-write step.
    if not candidates:
        return CleanupResult(scanned=0, destroyed=0, failed=[], skipped_running=[])
    cand_ids = [c.asset_id for c in candidates]
    rows = (await session.execute(select(Asset).where(Asset.id.in_(cand_ids)))).scalars().all()

    for asset in rows:
        if asset.pve_vmid is None or not asset.pve_node:
            skipped.append(asset.id)
            continue
        # Re-check the run-status gate at write time so we don't
        # race a drill that became RUNNING between list and act.
        run = await session.get(Run, asset.run_id)
        if run is not None and run.status in (
            RunStatus.RUNNING,
            RunStatus.PENDING,
        ):
            skipped.append(asset.id)
            continue
        try:
            try:
                await adapter.stop_vm(asset.pve_vmid, asset.pve_node, force=True)
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "orphan_cleanup.stop_failed asset_id=%s vmid=%s err=%s",
                    asset.id,
                    asset.pve_vmid,
                    exc,
                )
                # Don't bail: destroy may still succeed on a stopped VM.
            await adapter.destroy_vm(asset.pve_vmid, asset.pve_node)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "orphan_cleanup.destroy_failed asset_id=%s vmid=%s err=%s",
                asset.id,
                asset.pve_vmid,
                exc,
            )
            asset.status = AssetStatus.ORPHANED
            asset.error = f"cleanup retry failed: {exc}"
            failures.append(
                CleanupFailure(
                    asset_id=asset.id,
                    run_id=asset.run_id,
                    pve_vmid=asset.pve_vmid,
                    error=str(exc),
                )
            )
            continue
        # Success: flip status + stamp cleaned_at + audit row.
        now = datetime.now(UTC)
        previous_error = asset.error
        asset.status = AssetStatus.STOPPED
        asset.error = None
        asset.cleaned_at = now
        session.add(
            AuditLog(
                action=AuditAction.ASSET_CLEANED,
                actor=actor,
                run_id=asset.run_id,
                asset_id=asset.id,
                details={
                    "vmid": asset.pve_vmid,
                    "node": asset.pve_node,
                    "previous_error": previous_error,
                },
            )
        )
        destroyed += 1

    if destroyed or failures:
        await session.commit()

    return CleanupResult(
        scanned=len(candidates),
        destroyed=destroyed,
        failed=failures,
        skipped_running=skipped,
    )


async def cleanup_pve_unused_vms(
    session: AsyncSession,
    adapter: ProxmoxAdapter,
    actor: str,
    *,
    targets: Iterable[dict],
) -> CleanupResult:
    """Destroy explicit PVE VM targets discovered by ``list_pve_unused_vms``."""
    target_list = list(targets or [])
    failures: list[CleanupFailure] = []
    destroyed = 0
    if not target_list:
        return CleanupResult(scanned=0, destroyed=0, failed=[], skipped_running=[])

    allowed = {(c.vmid, c.node): c for c in await list_pve_unused_vms(session, grace_minutes=0)}
    now = datetime.now(UTC)

    for target in target_list:
        vmid = int(target.get("vmid") or 0)
        node = str(target.get("node") or "")
        cand = allowed.get((vmid, node))
        if vmid <= 0 or not node or cand is None:
            failures.append(
                CleanupFailure(
                    asset_id=int((cand.asset_id if cand else 0) or 0),
                    run_id=int((cand.run_id if cand else 0) or 0),
                    pve_vmid=vmid or None,
                    error="VM is not an eligible unused Divide VM",
                )
            )
            continue
        try:
            try:
                await adapter.stop_vm(vmid, node, force=True)
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "pve_unused_cleanup.stop_failed vmid=%s node=%s err=%s",
                    vmid,
                    node,
                    exc,
                )
            await adapter.destroy_vm(vmid, node)
        except Exception as exc:  # noqa: BLE001
            failures.append(
                CleanupFailure(
                    asset_id=int(cand.asset_id or 0),
                    run_id=int(cand.run_id or 0),
                    pve_vmid=vmid,
                    error=str(exc),
                )
            )
            continue

        asset = None
        if cand.asset_id:
            asset = await session.get(Asset, cand.asset_id)
        if asset is not None:
            previous_error = asset.error
            asset.status = AssetStatus.STOPPED
            asset.error = None
            asset.cleaned_at = now
            session.add(
                AuditLog(
                    action=AuditAction.ASSET_CLEANED,
                    actor=actor,
                    run_id=asset.run_id,
                    asset_id=asset.id,
                    details={
                        "vmid": vmid,
                        "node": node,
                        "previous_error": previous_error,
                        "source": "pve-unused-scan",
                    },
                )
            )
        else:
            session.add(
                AuditLog(
                    action=AuditAction.ASSET_CLEANED,
                    actor=actor,
                    run_id=cand.run_id,
                    details={
                        "vmid": vmid,
                        "node": node,
                        "name": cand.name,
                        "source": "pve-unused-scan",
                    },
                )
            )
        destroyed += 1

    if destroyed or failures:
        await session.commit()
    return CleanupResult(
        scanned=len(target_list),
        destroyed=destroyed,
        destroyed_pve=destroyed,
        failed=failures,
        skipped_running=[],
    )
