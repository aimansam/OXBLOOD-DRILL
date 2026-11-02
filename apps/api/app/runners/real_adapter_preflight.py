"""Template lookup and range preflight for the real PVE adapter."""

from __future__ import annotations

import logging

from app.core.config import settings
from app.runners.real_adapter_core import _AdapterCore

log = logging.getLogger("app.runners.real_adapter")


class PreflightMixin(_AdapterCore):
    """Template lookup and range preflight for the real PVE adapter."""

    async def find_template(self, name: str) -> int | None:
        def _do() -> int | None:
            resources = self._get_client().cluster.resources.get(type="vm")
            for r in resources:
                # PVE returns `template=1` for templates, 0/None for regular VMs.
                if r.get("template") and r.get("name") == name:
                    return int(r["vmid"])
            return None

        return await self._call(_do)

    async def preflight(self, spec: dict, node: str) -> list[dict]:
        def _do() -> list[dict]:
            client = self._get_client()
            inventory = client.cluster.resources.get(type="vm")
            templates = {r.get("name"): r for r in inventory if r.get("template")}
            checks = []
            memory_required = 0
            disk_required = 0
            linked_storage_required: dict[str, int] = {}
            provisioning = spec.get("provisioning") or {}
            linked_clone = provisioning.get("mode") == "linked_clone"
            snapshot_mode = provisioning.get("mode") == "snapshot"
            linked_clone_reserve_mb = max(
                128, int(provisioning.get("linked_clone_reserve_mb") or 1024)
            )
            if not spec.get("assets"):
                return [
                    {
                        "id": "assets",
                        "ready": False,
                        "detail": "The scenario has no machines to prepare.",
                    }
                ]
            for asset in spec.get("assets", []):
                name = asset["template"]
                template = templates.get(name)
                issue = None
                if not template:
                    issue = f"Import template {name} before preparing this range."
                elif template.get("node") != node:
                    issue = f"Template {name} must be on target node {node}."
                else:
                    config = client.nodes(node).qemu(template["vmid"]).config.get()
                    if config.get("lock"):
                        issue = f"Template {name} is locked ({config['lock']}). Wait for its task to finish."
                    if not self._primary_disk_key(config):
                        issue = (
                            f"Template {name} has no supported boot disk. Repair the image first."
                        )
                    if not template.get("maxdisk"):
                        issue = f"Template {name} disk capacity is unknown. Check template storage before preparing."
                    count = max(1, min(int(asset.get("count") or 1), 64))
                    resources = asset.get("resources") or {}
                    memory_required += (
                        count
                        * int(resources.get("ram_mb") or config.get("memory") or 512)
                        * 1024**2
                    )
                    if snapshot_mode:
                        # Persistent baselines reuse existing disks. Their
                        # snapshot capacity is checked at baseline creation,
                        # not every time a drill starts.
                        pass
                    elif linked_clone:
                        # Linked clones share their template's immutable disk.
                        # Reserve only a conservative writable delta per VM,
                        # rather than the full virtual disk size.
                        writable_delta = count * linked_clone_reserve_mb * 1024**2
                        disk_required += writable_delta
                        disk_key = self._primary_disk_key(config)
                        disk_value = str(config.get(disk_key) or "") if disk_key else ""
                        source_storage = disk_value.split(":", 1)[0].strip()
                        if not source_storage:
                            issue = f"Template {name} boot disk storage is unknown. Repair the image first."
                        else:
                            linked_storage_required[source_storage] = (
                                linked_storage_required.get(source_storage, 0) + writable_delta
                            )
                    else:
                        disk_required += count * max(
                            int(template.get("maxdisk") or 0),
                            int(resources.get("disk_gb") or 0) * 1024**3,
                        )
                checks.append(
                    {
                        "id": f"template:{asset['role']}",
                        "ready": issue is None,
                        "detail": issue or f"Template {name} is available on {node}.",
                    }
                )

            try:
                status = client.nodes(node).status.get()
            except Exception as exc:
                checks.append(
                    {
                        "id": "host-read-access",
                        "ready": False,
                        "detail": f"Cannot verify RAM on {node}: {exc}. The PVE token needs read access (Sys.Audit) on /nodes/{node}.",
                    }
                )
                status = {}
            memory = status.get("memory") or {}
            # QEMU memory is reserved by the guest; an LXC maxmem is only a
            # limit, and its actual use is already included in host memory.used.
            allocated = sum(
                int(r.get("maxmem") or 0)
                for r in inventory
                if r.get("node") == node
                and not r.get("template")
                and r.get("status") == "running"
                and r.get("type", "qemu") == "qemu"
            )
            reserve = max(0, settings.range_host_reserve_mb) * 1024**2
            available = max(
                0,
                int(memory.get("total") or 0)
                - max(allocated, int(memory.get("used") or 0))
                - reserve,
            )
            checks.append(
                {
                    "id": "memory",
                    "ready": available >= memory_required and bool(memory.get("total")),
                    "required_bytes": memory_required,
                    "available_bytes": available if memory.get("total") else None,
                    "detail": (
                        f"Range needs {memory_required / 1024**3:.1f} GiB RAM; {available / 1024**3:.1f} GiB available after existing guests and host reserve. Free capacity before retrying if insufficient."
                        if memory.get("total")
                        else f"Range needs {memory_required / 1024**3:.1f} GiB RAM; available host capacity could not be verified."
                    ),
                }
            )
            storage_requirements = (
                {}
                if snapshot_mode
                else linked_storage_required
                if linked_clone
                else {self._clone_storage: disk_required}
            )
            if snapshot_mode:
                checks.append(
                    {
                        "id": "storage:snapshot-baseline",
                        "ready": True,
                        "required_bytes": 0,
                        "available_bytes": None,
                        "detail": "Persistent snapshot baselines reuse existing VM disks.",
                    }
                )
            for storage_name, required in sorted(storage_requirements.items()):
                try:
                    storage = client.nodes(node).storage(storage_name).status.get()
                except Exception as exc:
                    checks.append(
                        {
                            "id": f"storage-read-access:{storage_name}",
                            "ready": False,
                            "detail": f"Cannot verify clone storage {storage_name}: {exc}. Check token read permissions and storage availability.",
                        }
                    )
                    storage = {}
                free = int(storage.get("avail") or 0)
                clone_detail = (
                    f"Linked clones reserve {required / 1024**3:.1f} GiB of writable delta "
                    f"on {storage_name}; {free / 1024**3:.1f} GiB free. The storage must be active."
                    if linked_clone
                    else f"Full clones need up to {required / 1024**3:.1f} GiB on {storage_name}; {free / 1024**3:.1f} GiB free. The storage must be active."
                )
                checks.append(
                    {
                        "id": f"storage:{storage_name}",
                        "ready": bool(storage.get("active")) and free >= required,
                        "required_bytes": required,
                        "available_bytes": free,
                        "detail": clone_detail,
                    }
                )
            if any(net.get("vlan_id") is not None for net in spec.get("networks", [])):
                try:
                    networks = client.nodes(node).network.get()
                except Exception as exc:
                    checks.append(
                        {
                            "id": "network-read-access",
                            "ready": False,
                            "detail": f"Cannot verify bridges on {node}: {exc}. Check token read permissions.",
                        }
                    )
                    networks = []
                bridge: dict = next((n for n in networks if n.get("iface") == "vmbr200"), {})
                checks.append(
                    {
                        "id": "network",
                        "ready": bool(int(bridge.get("active") or 0))
                        and bool(int(bridge.get("bridge_vlan_aware") or 0)),
                        "detail": "vmbr200 must be active and VLAN-aware before preparation. Check Infrastructure > Bridges.",
                    }
                )
            return checks

        return await self._call(_do)
