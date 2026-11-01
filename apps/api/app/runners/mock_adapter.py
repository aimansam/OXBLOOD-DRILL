"""In-memory fake of ProxmoxAdapter.

Used by tests + tools/run_smoke.py. Tracks:
  * "Inventory" of nodes + templates + VMIDs (small finite set)
  * The full call history (cloned / started / stopped / destroyed)
    for assertions in tests

Behaviour
---------
- Templates live in a registry you seed up-front; find_template looks them up.
- allocate_vmid starts at 9000 and never reuses.
- clone_vm returns a deterministic "10.0.x.y" IP for each VMID so tests
  can assert exact values.
- All methods are async (mirror the real adapter's surface) but do no I/O.
- Calling destroy_vm on a missing VM is a no-op (idempotent contract).
"""
from __future__ import annotations

from dataclasses import dataclass

from .adapter import (
    ClonedVM,
    CloneSpec,
    ConsoleTicket,
    NetworkSpec,
    ProxmoxAdapter,
    SeedSpec,
    VmState,
)


@dataclass
class _Vm:
    vmid: int
    node: str
    name: str
    status: str = "stopped"
    ip: str | None = None
    is_template: bool = False
    # Ordered list of (nic_id, bridge_name) attached to this VM.
    # F3 (multi-VM scenarios) populates this; the runner asserts
    # ordering and count to verify the topology.
    nics: list[tuple[int, str]] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.nics is None:
            self.nics = []


class MockProxmoxAdapter(ProxmoxAdapter):
    """Deterministic in-memory ProxmoxAdapter for tests + smoke."""

    def __init__(
        self,
        nodes: list[str] | None = None,
        templates: dict[str, int] | None = None,
        next_vmid: int = 9000,
        ip_template: str = "10.10.99.{vmid_offset}",
    ) -> None:
        self._nodes: list[str] = list(nodes or ["pve"])
        self._templates: dict[str, int] = dict(templates or {})
        self._next_vmid: int = next_vmid
        self._ip_template = ip_template
        self._vms: dict[int, _Vm] = {}
        self._snapshots: dict[int, dict[str, tuple[str, str | None, list[tuple[int, str]]]]] = {}
        # Set of bridge names that have been created (F3). Idempotent on
        # repeated create_bridge calls.
        self._bridges: set[str] = set()
        # Seed templates as VM entries so get_vm_state works on them.
        for name, vmid in self._templates.items():
            self._vms[vmid] = _Vm(
                vmid=vmid, node=self._nodes[0], name=name, is_template=True
            )
        # Public, read-only call history (assertion target).
        self.cloned: list[CloneSpec] = []
        self.cloned_results: list[ClonedVM] = []
        self.started: list[tuple[int, str]] = []
        self.started_with_nics: list[tuple[int, list[tuple[int, str]]]] = []
        self.stopped: list[tuple[int, str, bool]] = []
        self.destroyed: list[tuple[int, str]] = []
        self.snapshots_created: list[tuple[int, str, str]] = []
        self.snapshots_restored: list[tuple[int, str, str]] = []
        self.console_tickets: list[tuple[int, str]] = []
        self.seeded: list[tuple[int, str, SeedSpec]] = []
        # F3 multi-VM scenarios history:
        self.bridges_created: list[NetworkSpec] = []
        self.bridges_removed: list[str] = []
        self.nic_attached: list[tuple[int, str, int]] = []
        self.nic_attached_trunks: list[tuple[int, str, int, list[int]]] = []
    # --- inventory -------------------------------------------------------

    async def list_nodes(self) -> list[str]:
        return list(self._nodes)

    async def find_template(self, name: str) -> int | None:
        return self._templates.get(name)

    async def find_vm(self, name: str) -> VmState | None:
        for vm in self._vms.values():
            if vm.name == name and not vm.is_template:
                return VmState(
                    vmid=vm.vmid,
                    node=vm.node,
                    name=vm.name,
                    status=vm.status,
                    ip=vm.ip,
                )
        return None

    async def allocate_vmid(self) -> int:
        vmid = self._next_vmid
        self._next_vmid += 1
        return vmid

    # --- lifecycle -------------------------------------------------------

    async def clone_vm(self, spec: CloneSpec) -> ClonedVM:
        self.cloned.append(spec)
        if spec.source_vmid not in self._vms:
            raise KeyError(f"template vmid {spec.source_vmid} not found")
        new_vmid = spec.new_vmid if spec.new_vmid is not None else await self.allocate_vmid()
        ip = self._ip_template.format(vmid_offset=new_vmid - 8999)
        vm = _Vm(
            vmid=new_vmid,
            node=spec.node,
            name=spec.name,
            status="stopped",
            ip=ip,
        )
        self._vms[new_vmid] = vm
        result = ClonedVM(vmid=new_vmid, node=spec.node, name=spec.name)
        self.cloned_results.append(result)
        return result

    async def start_vm(self, vmid: int, node: str) -> None:
        self.started.append((vmid, node))
        vm = self._require_vm(vmid, node)
        self.started_with_nics.append((vmid, list(vm.nics)))
        vm.status = "running"

    async def set_vm_name(self, vmid: int, node: str, name: str) -> None:
        self._require_vm(vmid, node).name = name

    async def ensure_vm_running(
        self, name: str, node: str, timeout_s: float = 90.0
    ) -> VmState:
        del timeout_s
        state = await self.find_vm(name)
        if state is None:
            raise KeyError(f"permanent VM {name!r} not found")
        if state.node != node:
            raise RuntimeError(
                f"permanent VM {name!r} is on node {state.node!r}, not {node!r}"
            )
        if state.status != "running":
            await self.start_vm(state.vmid, state.node)
        return await self.get_vm_state(state.vmid, state.node)

    async def seed_vm(self, vmid: int, node: str, seed: SeedSpec) -> None:
        self._require_vm(vmid, node)
        self.seeded.append((vmid, node, seed))

    async def apply_guest_seed(self, vmid: int, node: str, seed: SeedSpec) -> None:
        self._require_vm(vmid, node)

    async def verify_windows_role(
        self,
        vmid: int,
        node: str,
        expected_ip: str,
        domain: str,
        controller: str = "member",
    ) -> None:
        del expected_ip, domain, controller
        self._require_vm(vmid, node)

    async def stop_vm(self, vmid: int, node: str, force: bool = False) -> None:
        self.stopped.append((vmid, node, force))
        if vmid in self._vms:
            self._vms[vmid].status = "stopped"

    async def destroy_vm(self, vmid: int, node: str) -> None:
        self.destroyed.append((vmid, node))
        self._vms.pop(vmid, None)
        self._snapshots.pop(vmid, None)

    async def list_vm_snapshots(self, vmid: int, node: str) -> list[str]:
        self._require_vm(vmid, node)
        return sorted(self._snapshots.get(vmid, {}))

    async def create_vm_snapshot(
        self, vmid: int, node: str, name: str, description: str = ""
    ) -> None:
        del description
        vm = self._require_vm(vmid, node)
        if vm.status != "stopped":
            raise RuntimeError(f"VM {vmid} must be stopped before snapshotting")
        self._snapshots.setdefault(vmid, {})[name] = (
            vm.status, vm.ip, list(vm.nics)
        )
        self.snapshots_created.append((vmid, node, name))

    async def restore_vm_snapshot(self, vmid: int, node: str, name: str) -> None:
        vm = self._require_vm(vmid, node)
        if vm.status != "stopped":
            raise RuntimeError(f"VM {vmid} must be stopped before snapshot restore")
        snapshot = self._snapshots.get(vmid, {}).get(name)
        if snapshot is None:
            raise KeyError(f"snapshot {name!r} not found for VM {vmid}")
        vm.status, vm.ip, nics = snapshot
        vm.status = "stopped"
        vm.nics = list(nics)
        self.snapshots_restored.append((vmid, node, name))

    # --- F3 multi-VM networks -----------------------------------------

    async def create_bridge(self, spec: NetworkSpec) -> None:
        """Idempotent: re-creating an existing bridge is a no-op."""
        self.bridges_created.append(spec)
        self._bridges.add(spec.bridge)

    async def remove_bridge(self, bridge: str) -> None:
        """Idempotent: removing a non-existent bridge is a no-op."""
        self.bridges_removed.append(bridge)
        self._bridges.discard(bridge)

    async def get_sdn_bridges(self, zone: str = "divide") -> list[str]:
        """Return mock SDN bridges for testing."""
        return sorted(self._bridges)

    async def create_sdn_vnet(self, bridge: str, zone: str = "divide") -> None:
        """Mock: track SDN VNet creation."""
        if not hasattr(self, 'sdn_vnets'):
            self.sdn_vnets = []
        if bridge not in self.sdn_vnets:
            self.sdn_vnets.append(bridge)
        self._bridges.add(bridge)

    async def attach_network(
        self,
        vmid: int,
        node: str,
        bridge: str,
        nic_id: int,
        vlan_id: int | None = None,
        trunks: list[int] | None = None,
    ) -> None:
        vm = self._require_vm(vmid, node)
        self.nic_attached.append((vmid, bridge, nic_id))
        if not hasattr(self, "nic_attached_vlan"):
            self.nic_attached_vlan = []
        self.nic_attached_vlan.append((vmid, bridge, nic_id, vlan_id))
        if trunks:
            self.nic_attached_trunks.append((vmid, bridge, nic_id, list(trunks)))
        vm.nics.append((nic_id, bridge))

    async def get_vm_state(self, vmid: int, node: str) -> VmState:
        vm = self._require_vm(vmid, node)
        return VmState(
            vmid=vm.vmid,
            node=vm.node,
            name=vm.name,
            status=vm.status,
            ip=vm.ip,
        )

    async def create_console_ticket(self, vmid: int, node: str) -> ConsoleTicket:
        self._require_vm(vmid, node)
        self.console_tickets.append((vmid, node))
        return ConsoleTicket(
            vmid=vmid,
            node=node,
            ticket=f"mock-ticket-{vmid}",
            port=5900,
            cert="mock-cert",
            user="mock@pve",
            launch_url=f"https://mock-pve/?console=kvm&novnc=1&vmid={vmid}&node={node}",
        )

    # --- helpers for tests ----------------------------------------------

    def seed_template(self, name: str, vmid: int | None = None, node: str = "pve") -> int:
        """Add a template to the registry. Returns the VMID used.

        If `vmid` is None, a VMID is allocated via `allocate_vmid()`.
        Either way, the counter advances so clones never collide with
        template VMIDs.
        """
        if vmid is None:
            vmid = self._next_vmid
            self._next_vmid += 1
        elif vmid >= self._next_vmid:
            self._next_vmid = vmid + 1
        self._templates[name] = vmid
        self._vms[vmid] = _Vm(
            vmid=vmid, node=node, name=name, is_template=True
        )
        return vmid

    def _require_vm(self, vmid: int, node: str) -> _Vm:
        if vmid not in self._vms:
            raise KeyError(f"vmid {vmid} not found on node {node}")
        return self._vms[vmid]
