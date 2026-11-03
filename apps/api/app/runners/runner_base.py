"""Shared state and primitives for the run orchestrator (see runner.py)."""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.db import models
from app.db.models import AuditAction
from app.runners.adapter import ProxmoxAdapter

log = logging.getLogger("app.runners.runner")


def _vm_name(asset_spec: dict, role: str) -> str | None:
    """Return a stable PVE-safe short name, including counted VM instances."""
    stem = str(asset_spec.get("vm_name") or "").strip()
    if not stem:
        return None
    if int(asset_spec.get("count") or 1) > 1:
        match = re.search(r"_(\d+)$", role)
        if match:
            return f"{stem}{int(match.group(1)):02d}"
    return stem


# VLAN numbers a range copy moves by. Copies keep the same subnets and addresses: VLANs keep them apart.
INSTANCE_VLAN_STRIDE = 20


def instance_spec(spec: dict, instance: int) -> dict:
    """The scenario spec as range copy ``instance`` sees it (copy 1 is the spec unchanged).

    Shifts every ``vlan_id`` and prefixes the short VM names, so two copies of one scenario can
    run side by side on the shared bridge. A router image with its VLANs baked in (OPNsense)
    cannot follow the shift, so such scenarios refuse copies above 1.
    """
    if instance <= 1:
        return spec
    for asset in spec.get("assets") or []:
        if "opnsense" in str(asset.get("template") or "").lower():
            raise RunnerError(
                f"Range copy {instance} is not possible: {asset.get('role')!r} uses an OPNsense "
                "image whose VLANs are fixed. Use a router image configured at seed time."
            )
    shifted = {**spec}
    shifted["networks"] = [
        {**net, "vlan_id": int(net["vlan_id"]) + (instance - 1) * INSTANCE_VLAN_STRIDE}
        if net.get("vlan_id") is not None
        else dict(net)
        for net in spec.get("networks") or []
    ]
    shifted["assets"] = [
        {**asset, "vm_name": f"M{instance}-{asset['vm_name']}"}
        if asset.get("vm_name")
        else dict(asset)
        for asset in spec.get("assets") or []
    ]
    return shifted


def _static_ip_configs(asset: dict, scenario_spec: dict) -> dict[int, str]:
    """Build deterministic PVE cloud-init addresses for a scenario asset.

    The range is intentionally self-contained: the router owns the first
    usable address and guests receive stable addresses by role. This keeps a
    fresh lab usable before a DHCP service is installed on the router image.
    """
    networks = {
        str(net.get("name")): net
        for net in (scenario_spec.get("networks") or [])
        if isinstance(net, dict) and net.get("name") and net.get("cidr")
    }
    requested = [str(name) for name in (asset.get("networks") or [])]
    if not requested:
        return {}

    role = str(asset.get("role") or "asset")
    base_role = role.rsplit("_", 1)[0] if role.rsplit("_", 1)[-1].isdigit() else role
    template = str(asset.get("template") or "").lower()
    if (
        str(asset.get("network_mode") or "").lower() == "trunk"
        or "opnsense" in template
        # Windows templates use their declared setup phases to configure
        # networking. PVE cloud-init IP config can be re-applied at reboot
        # and undo that Windows-side state.
        or ("win" in template and not asset.get("cloudbase_init"))
    ):
        # OPNsense owns its VLAN interface addresses in its native config;
        # do not emit Linux cloud-init addresses for the trunk appliance.
        return {}
    host_by_role = {
        "red_workstation": 10,
        "red_attacker": 10,
        "red_staging": 20,
        "blue_workstation": 11,
        "web_gateway": 20,
        "file_server": 20,
        "backup_server": 20,
        "log_aggregator": 30,
        "dc01": 10,
        "dc02": 10,
    }
    host = host_by_role.get(base_role, 40)
    configs: dict[int, str] = {}
    for nic_index, network_name in enumerate(requested):
        net = networks.get(network_name)
        if not net:
            continue
        try:
            subnet = ipaddress.ip_network(str(net["cidr"]), strict=False)
            usable = list(subnet.hosts())
        except (ValueError, TypeError):
            continue
        if not usable:
            continue
        # ``hosts()`` starts at the first usable host (.1), so indexing it
        # directly by a host number turns host 10 into .11. Keep role
        # allocations expressed as ordinary last-octet host numbers.
        address = (
            usable[0]
            if base_role == "router_fw"
            else usable[min(max(0, host - 1), len(usable) - 1)]
        )
        configs[nic_index] = f"ip={address}/{subnet.prefixlen}"
        if base_role != "router_fw":
            configs[nic_index] += f",gw={usable[0]}"
    return configs


def _adapter_label(adapter: ProxmoxAdapter) -> str:
    """``real`` or ``mock`` — used as a Prometheus label so we can graph
    live vs test traffic without distinguishing class names."""
    cls = type(adapter).__name__
    if cls == "RealProxmoxAdapter":
        return "real"
    return "mock"


class RunnerError(RuntimeError):
    """Raised when the runner cannot complete a phase. Always actionable."""


_PERSISTENT_APPLIANCE_BASELINE = "__persistent__"


def _sessionmaker():
    """Lazy import to avoid circular import at module load."""
    from app.db.session import get_sessionmaker

    return get_sessionmaker()


class RunnerBase:
    """Shared state and primitives; the mixins and Runner build on this."""

    # and run_id -> asyncio.Task (for in-flight watchdog tasks).
    _active_deadlines: dict[int, datetime] = {}
    _active_tasks: dict[int, asyncio.Task] = {}
    _pve_lifecycle_locks: dict[int, asyncio.Lock] = {}
    _windows_setup_secrets: dict[int, str] = {}

    def __init__(self, adapter: ProxmoxAdapter) -> None:
        self._adapter = adapter

    @classmethod
    def _pve_lifecycle_lock(cls) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        return cls._pve_lifecycle_locks.setdefault(id(loop), asyncio.Lock())

    @classmethod
    def pve_lifecycle_busy(cls) -> bool:
        return cls._pve_lifecycle_lock().locked()

    @asynccontextmanager
    async def _pve_lifecycle_section(self, action: str, **labels):
        lock = self._pve_lifecycle_lock()
        label_text = " ".join(f"{k}={v}" for k, v in labels.items() if v is not None)
        if lock.locked():
            log.info("runner.pve_lock.waiting action=%s %s", action, label_text)
        async with lock:
            log.info("runner.pve_lock.acquired action=%s %s", action, label_text)
            try:
                yield
            finally:
                log.info("runner.pve_lock.released action=%s %s", action, label_text)

    async def _audit(
        self,
        session: AsyncSession,
        *,
        action: AuditAction,
        actor: str | None = None,
        scenario_id: int | None = None,
        run_id: int | None = None,
        asset_id: int | None = None,
        details: dict | None = None,
    ) -> None:
        session.add(
            models.AuditLog(
                action=action,
                actor=actor,
                scenario_id=scenario_id,
                run_id=run_id,
                asset_id=asset_id,
                details=details or {},
            )
        )
