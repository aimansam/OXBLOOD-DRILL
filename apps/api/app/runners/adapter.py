"""Adapter interface between the runner and Proxmox.

Why this exists
---------------
The runner should never speak proxmoxer directly. By defining a small
Protocol-style interface, we can:
  * Test the runner end-to-end with a deterministic in-memory fake.
  * Swap implementations without touching the state machine.
  * Keep the runner's "what to do" separate from "how to talk to PVE".

Real adapter (RealProxmoxAdapter) will land in a later commit, once
PVE auth is fixed.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class NetworkSpec:
    """Inputs to `create_bridge`.

    A bridge is a PVE Linux bridge (vmbrN) that hosts assets on a
    shared subnet. F3 (multi-VM scenarios) creates one bridge per
    spec.networks[] entry, then attaches each asset to the bridges
    that match the assets' spec.networks[] arrays.

    Attributes:
        bridge: Bridge name on PVE (e.g. ``vmbr42``). Must be unique
                within the cluster; we'll allocate sequentially.
        cidr:   CIDR block, as declared in the scenario YAML
                (informational on real PVE; PVE doesn't strictly
                enforce the CIDR, but we use it for topology planning
                and router IP calculation).
        isolation: 'tight' (no cross-VLAN) or 'loose' (controlled egress).
        egress: 'blocked' / 'allowed' / 'restricted'.
        dhcp:   Whether to enable Proxmox-side DHCP for in-network clients.
    """

    bridge: str
    vlan_id: int | None = None
    cidr: str = ""
    isolation: str = "tight"
    egress: str = "blocked"
    dhcp: bool = True


@dataclass(frozen=True)
class CloneSpec:
    """Inputs to `clone_vm`. All fields are required."""

    source_vmid: int       # VMID of the template on PVE
    new_vmid: int | None   # None => let PVE auto-assign
    node: str              # which PVE node (e.g. "pve")
    name: str              # VM name (must be unique within the node)
    template_name: str | None = None
    cores: int | None = None
    sockets: int | None = None
    ram_mb: int | None = None
    disk_gb: int | None = None
    # PVE cloud-init network definitions, keyed by NIC index. Keeping these
    # on the clone request makes guest addressing deterministic even when a
    # scenario VLAN has no external DHCP service.
    ip_configs: dict[int, str] | None = None
    # Linked clones keep the template disk as their immutable backing file and
    # only allocate blocks changed by the drill.  They are ideal for the
    # constrained single-range deployment; full clones remain the default for
    # scenarios that need fully independent disks.
    full_clone: bool = True
    storage: str | None = None


@dataclass(frozen=True)
class ClonedVM:
    """Result of a successful clone."""

    vmid: int
    node: str
    name: str


@dataclass(frozen=True)
class SeedSpec:
    """Scenario-specific VM seed data applied after clone, before boot."""

    role: str
    ciuser: str | None = None
    cipassword: str | None = None
    files: dict[str, str] | None = None
    runcmd: list[str] | None = None
    windows_commands: list[str] | None = None
    windows_phases: list[dict] | None = None


@dataclass(frozen=True)
class VmState:
    """Minimal view of a VM used by the runner."""

    vmid: int
    node: str
    name: str
    status: str           # "stopped" | "running" | "paused"
    ip: str | None = None  # primary IP, if known


@dataclass(frozen=True)
class ConsoleTicket:
    """Short-lived Proxmox console ticket for a VM."""

    vmid: int
    node: str
    ticket: str
    port: int | None = None
    cert: str | None = None
    user: str | None = None
    launch_url: str | None = None


class ProxmoxAdapter(ABC):
    """Operations the runner needs from Proxmox.

    Every method is intentionally small so the mock can be a few dozen
    lines. The real adapter will wrap `proxmoxer.ProxmoxAPI`.
    """

    # --- inventory -------------------------------------------------------

    async def preflight(self, spec: dict, node: str) -> list[dict]:
        """Read-only checks before provisioning; real adapters add capacity checks."""
        checks = []
        for name in sorted({asset["template"] for asset in spec.get("assets", [])}):
            found = await self.find_template(name)
            checks.append({
                "id": f"template:{name}", "ready": found is not None,
                "detail": f"Template {name} is available." if found is not None
                else f"Template {name} is missing. Import and validate it before preparing the range.",
            })
        return checks

    @abstractmethod
    async def list_nodes(self) -> list[str]:
        """Return names of all PVE nodes."""

    @abstractmethod
    async def find_template(self, name: str) -> int | None:
        """Return the VMID of a template by name, or None."""

    @abstractmethod
    async def find_vm(self, name: str) -> VmState | None:
        """Return a non-template VM by name, or None if it is absent."""

    @abstractmethod
    async def allocate_vmid(self) -> int:
        """Reserve the next available VMID."""

    # --- lifecycle -------------------------------------------------------

    @abstractmethod
    async def clone_vm(self, spec: CloneSpec) -> ClonedVM:
        """Clone `source_vmid` on `node` with the given overrides."""

    @abstractmethod
    async def start_vm(self, vmid: int, node: str) -> None:
        """Start a VM; no-op if already running."""

    @abstractmethod
    async def set_vm_name(self, vmid: int, node: str, name: str) -> None:
        """Set the PVE display name without changing the VMID or guest hostname."""

    @abstractmethod
    async def ensure_vm_running(
        self, name: str, node: str, timeout_s: float = 90.0
    ) -> VmState:
        """Find and start a permanent VM, returning its running state."""

    @abstractmethod
    async def seed_vm(self, vmid: int, node: str, seed: SeedSpec) -> None:
        """Apply role-specific scenario seed data before the VM boots."""

    @abstractmethod
    async def apply_guest_seed(self, vmid: int, node: str, seed: SeedSpec) -> None:
        """Apply file and command seed data after the guest agent is ready."""

    @abstractmethod
    async def verify_windows_role(
        self,
        vmid: int,
        node: str,
        expected_ip: str,
        domain: str,
        controller: str = "member",
    ) -> None:
        """Verify Windows networking, services, and directory role readiness."""

    @abstractmethod
    async def stop_vm(self, vmid: int, node: str, force: bool = False) -> None:
        """Stop a VM; idempotent (no-op if already stopped)."""

    @abstractmethod
    async def destroy_vm(self, vmid: int, node: str) -> None:
        """Delete a VM and free its disk. Idempotent."""

    @abstractmethod
    async def list_vm_snapshots(self, vmid: int, node: str) -> list[str]:
        """Return named snapshots available for a VM."""

    @abstractmethod
    async def create_vm_snapshot(
        self, vmid: int, node: str, name: str, description: str = ""
    ) -> None:
        """Create a cold snapshot; the VM must already be stopped."""

    @abstractmethod
    async def restore_vm_snapshot(self, vmid: int, node: str, name: str) -> None:
        """Restore a named snapshot without starting the VM."""

    @abstractmethod
    async def get_vm_state(self, vmid: int, node: str) -> VmState:
        """Return current VM state. Raises KeyError if VM is gone."""

    @abstractmethod
    async def create_console_ticket(self, vmid: int, node: str) -> ConsoleTicket:
        """Create a short-lived noVNC console ticket for a VM."""

    # --- F3 multi-VM networks ---------------------------------------------
    #
    # The runner iterates spec.networks[] once, creates one bridge per
    # network, and attaches each asset to the bridges that the asset
    # declares in its ``spec.networks[]`` array. The adapter surface is
    # intentionally narrow: create_bridge / remove_bridge for the network,
    # attach_network for the asset side. The mock adapter records every
    # call so tests can assert exact topology.

    @abstractmethod
    async def create_bridge(self, spec: NetworkSpec) -> None:
        """Create (or no-op-on-exists) a Linux bridge on PVE.

        Idempotent: if a bridge with that name already exists, treat
        the call as a no-op. This is important because the runner may
        be retried (cancelled + restarted) and we don't want to fail
        just because the previous teardown didn't fully clean up.
        """

    @abstractmethod
    async def remove_bridge(self, bridge: str) -> None:
        """Delete a bridge created by ``create_bridge``. Idempotent."""

    @abstractmethod
    async def attach_network(
        self,
        vmid: int,
        node: str,
        bridge: str,
        nic_id: int,
        vlan_id: int | None = None,
        trunks: list[int] | None = None,
    ) -> None:
        """Add a NIC attached to ``bridge`` to an existing VM.

        The runner calls this once per (asset, network) pair, in
        order, starting from ``nic_id=0`` (next free slot). A firewall
        asset may instead pass ``trunks`` to attach one VLAN trunk NIC.
        """
