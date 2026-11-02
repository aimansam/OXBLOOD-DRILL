"""Expected bridges, SDN status and bridge setup."""

from __future__ import annotations

import ipaddress
from typing import Annotated, Any

import structlog
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    status,
)
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Role, require_role
from app.db.session import get_session

log = structlog.get_logger()

# Router-level gate: every endpoint requires an admin token.
router = APIRouter(dependencies=[Depends(require_role(Role.ADMIN))])


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
