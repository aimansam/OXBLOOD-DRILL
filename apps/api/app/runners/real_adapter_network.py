"""SDN and bridge management and NIC attachment for the real PVE adapter."""

from __future__ import annotations

import ipaddress
import logging
from contextlib import suppress

from app.runners.adapter import (
    NetworkSpec,
)
from app.runners.real_adapter_core import _AdapterCore
from app.services.proxmox import ProxmoxAPIError

log = logging.getLogger("app.runners.real_adapter")


class NetworkMixin(_AdapterCore):
    """SDN and bridge management and NIC attachment for the real PVE adapter."""

    async def get_sdn_bridges(self, zone: str = "divide") -> list[str]:
        """Query SDN VNets in the specified zone and return bridge names.

        This allows the runner to use bridges that are already configured
        in the SDN zone instead of hardcoding bridge names.
        """

        def _do() -> list[str]:
            client = self._get_client()
            vnets = client.cluster.sdn.vnets.get()
            return [v["vnet"] for v in vnets if v.get("zone") == zone]

        return await self._call(_do)

    async def create_sdn_vnet(self, bridge: str, zone: str = "divide") -> None:
        """Create an SDN VNet in the specified zone.

        This ensures the bridge exists in the SDN zone before the runner
        tries to use it. Idempotent: if the VNet already exists, this is
        a no-op.
        """

        def _do() -> None:
            client = self._get_client()
            # Check if VNet already exists
            vnets = client.cluster.sdn.vnets.get()
            existing = [v["vnet"] for v in vnets if v.get("zone") == zone]
            if bridge in existing:
                return  # Already exists, no-op

            # Create the VNet
            client.cluster.sdn.vnets.post(
                vnet=bridge,
                zone=zone,
            )
            log.info("pve_runner.sdn_vnet_created bridge=%s zone=%s", bridge, zone)

        await self._call(_do)

    async def create_bridge(self, spec: NetworkSpec) -> None:
        """Create a Linux bridge on every node in the cluster.

        PVE bridges (vmbrN) are per-node, but for the cyber range we
        consistently use a single node for the whole drill so we only
        need to create it on that node. Bridges are managed via PVE's
        Software-Defined Networking stack (see
        ``README.md §8 §4``): the wizard's Step 0 creates
        the ``divide`` zone + one VNet per declared network via
        ``POST /cluster/sdn/{zones,vnets}``.

        The runner no longer creates bridges itself -- it asserts the
        bridge already exists on the target node (calls
        ``/nodes/{node}/network`` and looks for ``iface == <bridge>``).
        If not found, raises ``ProxmoxAPIError`` with a wizard
        action path, so operators see the missing-bridge reason in
        the run report and can re-run Step 0 of the wizard to fix it.

        The error message no longer references ``/etc/network/interfaces``
        or ``ifreload`` -- those were the SSH-era remediation steps
        and would mislead the operator today.
        """

        def _do() -> None:
            client = self._get_client()
            node_name = self._node
            if not node_name:
                raise ProxmoxAPIError("create_bridge requires a configured target node")
            networks = client.nodes(node_name).network.get()
            matching = [
                n
                for n in networks
                if n.get("iface") == spec.bridge and (n.get("type") or "").lower() == "bridge"
            ]
            active = [n for n in matching if str(n.get("active")) == "1"]
            if not active:
                inactive_hint = (
                    " exists in PVE config but is not active" if matching else " is not configured"
                )
                raise ProxmoxAPIError(
                    f"bridge {spec.bridge!r}{inactive_hint} on PVE node "
                    f"{node_name!r} -- repair it via Setup -> Infrastructure "
                    f"(POST /api/v1/admin/pve-setup-bridges) or via "
                    f"the PVE node network page, then recheck readiness"
                )
            if spec.cidr:
                try:
                    expected_gateway = str(
                        next(ipaddress.ip_network(spec.cidr, strict=False).hosts())
                    )
                except (StopIteration, ValueError) as exc:
                    raise ProxmoxAPIError(
                        f"invalid CIDR {spec.cidr!r} for bridge {spec.bridge!r}"
                    ) from exc
                pve_cidr = str(active[0].get("cidr") or "")
                pve_address = str(active[0].get("address") or "")
                if pve_address != expected_gateway and not pve_cidr.startswith(
                    f"{expected_gateway}/"
                ):
                    raise ProxmoxAPIError(
                        f"bridge {spec.bridge!r} is active but has address "
                        f"{pve_cidr or pve_address!r}; expected gateway "
                        f"{expected_gateway!r} for scenario CIDR {spec.cidr!r}. "
                        "Repair bridges in Setup -> Infrastructure before "
                        "starting the drill."
                    )

        await self._call(_do)

    async def remove_bridge(self, bridge: str) -> None:
        """Best-effort cleanup of an SDN-created VNet on PVE.

        Since F-pve-bridge-wizard (SDN variant), bridges are managed
        as SDN Vnets in the ``divide`` zone. The runner can delete
        them via ``DELETE /cluster/sdn/vnets/{bridge}`` -- no
        host-shell access required. We do this so that a failed
        drill doesn't leave orphan Vnets accumulating on the cluster.

        Older docstrings said the runner never deletes bridges. That
        was true when bridges were created via ``/etc/network/interfaces``
        (which the runner can't edit). With SDN, deletion is just
        one HTTP call, and leaving the bridge behind leaks cluster
        state. Best-effort: if the PVE call fails (e.g. permissions,
        transient network), we log and move on -- the operator can
        run ``pvesh delete /cluster/sdn/zones/divide`` to wipe the
        whole zone if needed.
        """

        def _do() -> None:
            client = self._get_client()
            try:
                client.cluster.sdn.vnets(bridge).delete()
            except Exception as exc:  # noqa: BLE001
                # Logged here -- the calling code wraps _call() with
                # its own error handling and we don't want to mask
                # a genuine runner failure by raising on cleanup.
                log.warning("pve_runner.remove_bridge.failed bridge=%s error=%s", bridge, exc)

        with suppress(Exception):
            await self._call(_do)

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

        Maps to ``POST /nodes/{n}/qemu/{vmid}/config`` with a
        ``netN`` property. ``trunks`` creates a single VLAN trunk NIC;
        ordinary assets receive one access/tagged NIC per network.
        """
        net_name = f"net{nic_id}"

        def _do() -> None:
            client = self._get_client()
            cfg = client.nodes(node).qemu(vmid).config.get()
            existing = str(cfg.get(net_name) or "")
            tag = f",tag={vlan_id}" if vlan_id is not None else ""
            trunk_value = ";".join(str(int(value)) for value in (trunks or []))
            trunk_option = f",trunks={trunk_value}" if trunk_value else ""
            if (
                existing
                and f"bridge={bridge}" in existing
                and (
                    (vlan_id is None or f"tag={vlan_id}" in existing)
                    and (not trunk_value or f"trunks={trunk_value}" in existing)
                )
            ):
                # Already attached to the desired scenario bridge; skip.
                return
            ostype = str(cfg.get("ostype") or "").lower()
            if ostype.startswith("win"):
                # Preserve the NIC model carried by the Windows template. This
                # keeps legacy e1000 templates usable while allowing prepared
                # VirtIO/NetKVM templates to remain on virtio.
                # Fresh Windows clones may have no netN entry even when the
                # source template used E1000. Fall back to Windows' inbox
                # E1000 driver; VirtIO requires NetKVM to be preinstalled.
                nic_option = existing.split(",", 1)[0] if existing else ""
                model = nic_option.split("=", 1)[0]
                if model not in {"e1000", "virtio"} or not nic_option:
                    nic_option = "e1000"
                client.nodes(node).qemu(vmid).config.post(
                    **{net_name: f"{nic_option},bridge={bridge}{tag}{trunk_option}"}
                )
                return
            client.nodes(node).qemu(vmid).config.post(
                **{net_name: f"virtio,bridge={bridge}{tag}{trunk_option}"}
            )

        await self._call(_do)
