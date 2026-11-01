"""ProxmoxAdapter implementation backed by `proxmoxer`.

Why this exists
---------------
The runner owns the Proxmox lifecycle (clone/start/stop/destroy). For tests
and dev, a deterministic in-memory adapter is enough (see mock_adapter.py).
This module is the **production** implementation: it talks to a real PVE
host via `proxmoxer.ProxmoxAPI`.

Mapping (ABC -> PVE REST)
-------------------------
- list_nodes()            GET /nodes
- find_template(name)     GET /cluster/resources?type=vm (filter template=1 && name==)
- allocate_vmid()         POST /cluster/nextid
- clone_vm(spec)          POST /nodes/{n}/qemu/{vmid}/clone
- start_vm(vmid, node)    POST /nodes/{n}/qemu/{vmid}/status/start
- stop_vm(vmid, node, ..) POST /nodes/{n}/qemu/{vmid}/status/stop (+ timeout=N)
- destroy_vm(vmid, node)  DELETE /nodes/{n}/qemu/{vmid} (+ purge=1)
- get_vm_state(vmid, n)   GET /nodes/{n}/qemu/{vmid}/status/current

Concurrency model
-----------------
`proxmoxer.ProxmoxAPI` is synchronous and uses `requests` under the hood. We
bridge it to our async `ProxmoxAdapter` surface via `asyncio.to_thread`, so
the event loop is never blocked on network I/O.

Errors
------
All proxmoxer exceptions are wrapped as `ProxmoxAPIError` (reused from
`app.services.proxmox`). Missing/incomplete config raises
`ProxmoxNotConfiguredError`. Per-call timeouts also surface as
`ProxmoxAPIError` with a clear message — never as an asyncio.TimeoutError,
which the runner doesn't know how to handle.
"""
from __future__ import annotations

import asyncio
import base64
import ipaddress
import logging
import re
from collections.abc import Callable
from contextlib import suppress
from typing import Any

from proxmoxer import ProxmoxAPI

from app.core.config import ProxmoxSettings, settings
from app.runners.adapter import (
    ClonedVM,
    CloneSpec,
    ConsoleTicket,
    NetworkSpec,
    ProxmoxAdapter,
    SeedSpec,
    VmState,
)
from app.services.proxmox import ProxmoxAPIError, ProxmoxNotConfiguredError

log = logging.getLogger(__name__)


def _guest_error(value: object, limit: int = 700) -> str:
    """Extract useful PowerShell errors from noisy CLIXML output."""
    text = str(value or "").replace("_x000D_", "").replace("_x000A_", "\n")
    messages = re.findall(r"<S S=\"Error\">(.*?)</S>", text, flags=re.S)
    if messages:
        return " | ".join(messages)[-limit:]
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()[-limit:]


def _is_missing_vm_error(value: object) -> bool:
    """Return true when PVE says the VM configuration is already gone.

    PVE 9 reports a missing VM inconsistently: some endpoints return 404,
    while others return HTTP 500 with a missing ``qemu-server/<vmid>.conf``
    message. Lifecycle teardown must treat both forms as idempotent success.
    """
    message = str(value or "").lower()
    return (
        "not found" in message
        or "no such" in message
        or "does not exist" in message
        or "configuration file" in message and "qemu-server" in message
    )


_DEFAULT_TIMEOUT_S = 30.0


class RealProxmoxAdapter(ProxmoxAdapter):
    """Adapter that talks to a real Proxmox VE host via proxmoxer.

    Construct either via `RealProxmoxAdapter.from_settings(p)` (preferred,
    pulls all auth + network config from the app's `ProxmoxSettings`) or
    directly with `(host, port, user, token_id, token_secret, verify_ssl)`
    — useful for tests and one-off scripts.
    """

    def __init__(
        self,
        host: str,
        port: int,
        user: str,
        token_id: str,
        token_secret: str,
        verify_ssl: bool = True,
        node: str | None = None,
        clone_storage: str = "local-lvm",
        seed_snippet_storage: str = "local",
        timeout_s: float = _DEFAULT_TIMEOUT_S,
    ) -> None:
        if not host:
            raise ProxmoxNotConfiguredError("Proxmox host is empty")
        if not token_id or not token_secret:
            raise ProxmoxNotConfiguredError(
                "Proxmox token_id and token_secret are required"
            )
        self._host = host.split("://", 1)[-1].rstrip("/") if "://" in host else host
        self._port = int(port)
        self._user = user
        # PROXMOX_TOKEN_ID is the full "user!tokenname" string. proxmoxer
        # wants (user, token_name) separately:
        token_full = token_id.strip()
        self._token_name = token_full.split("!", 1)[1] if "!" in token_full else token_full
        self._token_secret = token_secret
        self._verify_ssl = verify_ssl
        self._clone_storage = (clone_storage or "").strip() or "local-lvm"
        self._seed_snippet_storage = (seed_snippet_storage or "").strip() or "local"
        self._timeout_s = float(timeout_s)
        self._client: ProxmoxAPI | None = None
        # Default node for F3 multi-VM scenarios. The runner currently
        # operates on a single node per drill (see runner.py), so we
        # stash that here for create_bridge to use. Tests pass
        # ``node`` explicitly per-call elsewhere, but create_bridge
        # doesn't take a node arg, so we use this for the default.
        self._node: str | None = (node or "").strip() or None

    # --- construction ----------------------------------------------------

    @classmethod
    def from_settings(cls, p: ProxmoxSettings) -> RealProxmoxAdapter:
        """Build from `app.core.config.ProxmoxSettings`.

        Raises ProxmoxNotConfiguredError if host or token are missing —
        callers (the factory in `runner.py`) should catch and fall back to
        the mock if desired.
        """
        host = (p.host or "").strip()
        if not host:
            raise ProxmoxNotConfiguredError("PROXMOX_HOST is not set")
        token_id = (p.token_id or "").strip()
        token_secret_raw = p.token_secret
        token_secret = (
            token_secret_raw.get_secret_value() if token_secret_raw is not None else None
        )
        if not token_id or not token_secret:
            raise ProxmoxNotConfiguredError(
                "PROXMOX_TOKEN_ID and PROXMOX_TOKEN_SECRET must be set"
            )
        return cls(
            host=host,
            port=int(p.port),
            user=p.user,
            token_id=token_id,
            token_secret=token_secret,
            verify_ssl=bool(p.verify_ssl),
            node=p.node,
            clone_storage=p.clone_storage,
            seed_snippet_storage=p.seed_snippet_storage,
        )

    @classmethod
    def from_overlay(
        cls,
        overlay: dict[str, Any],
        *,
        clone_storage: str = "local-lvm",
        seed_snippet_storage: str = "local",
    ) -> RealProxmoxAdapter:
        """Build from the DB-backed PVE config overlay."""
        host = (overlay.get("host") or "").strip()
        user = (overlay.get("user") or "").strip()
        token_id = (overlay.get("token_id") or "").strip()
        token_secret = overlay.get("token_secret") or ""
        if not host:
            raise ProxmoxNotConfiguredError("pve_config.host is empty")
        if not user or not token_id or not token_secret:
            raise ProxmoxNotConfiguredError(
                "pve_config.user, token_id, and token_secret are all required"
            )
        return cls(
            host=host,
            port=int(overlay.get("port") or 8006),
            user=user,
            token_id=token_id,
            token_secret=token_secret,
            verify_ssl=bool(overlay.get("verify_ssl", False)),
            node=overlay.get("node"),
            clone_storage=clone_storage,
            seed_snippet_storage=seed_snippet_storage,
        )

    # --- internal client + call helpers ---------------------------------

    def _get_client(self) -> ProxmoxAPI:
        if self._client is None:
            self._client = ProxmoxAPI(
                host=self._host,
                port=self._port,
                user=self._user,
                token_name=self._token_name,
                token_value=self._token_secret,
                verify_ssl=self._verify_ssl,
                backend="https",
                timeout=300,  # 5 minutes for clone operations
            )
        return self._client

    def set_node(self, node: str) -> None:
        """Set the node used by node-scoped network validation."""
        self._node = (node or "").strip() or None

    async def _call(self, fn, *args: Any, **kwargs: Any) -> Any:
        """Run a sync proxmoxer call in a worker thread with a timeout.

        Any exception raised by `fn` (proxmoxer or anything else) is wrapped
        as `ProxmoxAPIError` so callers have a single error type. 403s get a
        short ACL hint appended so the operator knows to grant PVEVMAdmin.
        """
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(fn, *args, **kwargs),
                timeout=self._timeout_s,
            )
        except ProxmoxNotConfiguredError:
            raise
        except TimeoutError as exc:
            raise ProxmoxAPIError(
                f"proxmoxer call timed out after {self._timeout_s}s"
            ) from exc
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            if "403" in msg or "Permission check failed" in msg:
                raise ProxmoxAPIError(
                    f"{type(exc).__name__}: {exc} — token needs PVEVMAdmin "
                    f"(or PVEAdmin) on /v2/vm; see PROXMOX-SETUP in README.md §8 §6"
                ) from exc
            raise ProxmoxAPIError(f"{type(exc).__name__}: {exc}") from exc

    # --- inventory -------------------------------------------------------

    async def list_nodes(self) -> list[str]:
        def _do() -> list[str]:
            return [n["node"] for n in self._get_client().nodes.get()]

        return await self._call(_do)

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
                return [{"id": "assets", "ready": False, "detail": "The scenario has no machines to prepare."}]
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
                        issue = f"Template {name} has no supported boot disk. Repair the image first."
                    if not template.get("maxdisk"):
                        issue = f"Template {name} disk capacity is unknown. Check template storage before preparing."
                    count = max(1, min(int(asset.get("count") or 1), 64))
                    resources = asset.get("resources") or {}
                    memory_required += count * int(resources.get("ram_mb") or config.get("memory") or 512) * 1024 ** 2
                    if snapshot_mode:
                        # Persistent baselines reuse existing disks. Their
                        # snapshot capacity is checked at baseline creation,
                        # not every time a drill starts.
                        pass
                    elif linked_clone:
                        # Linked clones share their template's immutable disk.
                        # Reserve only a conservative writable delta per VM,
                        # rather than the full virtual disk size.
                        writable_delta = count * linked_clone_reserve_mb * 1024 ** 2
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
                            int(resources.get("disk_gb") or 0) * 1024 ** 3,
                        )
                checks.append({"id": f"template:{asset['role']}", "ready": issue is None,
                               "detail": issue or f"Template {name} is available on {node}."})

            try:
                status = client.nodes(node).status.get()
            except Exception as exc:
                checks.append({"id": "host-read-access", "ready": False,
                               "detail": f"Cannot verify RAM on {node}: {exc}. The PVE token needs read access (Sys.Audit) on /nodes/{node}."})
                status = {}
            memory = status.get("memory") or {}
            # QEMU memory is reserved by the guest; an LXC maxmem is only a
            # limit, and its actual use is already included in host memory.used.
            allocated = sum(int(r.get("maxmem") or 0) for r in inventory
                            if r.get("node") == node and not r.get("template")
                            and r.get("status") == "running"
                            and r.get("type", "qemu") == "qemu")
            reserve = max(0, settings.range_host_reserve_mb) * 1024 ** 2
            available = max(0, int(memory.get("total") or 0) - max(allocated, int(memory.get("used") or 0)) - reserve)
            checks.append({"id": "memory", "ready": available >= memory_required and bool(memory.get("total")),
                           "required_bytes": memory_required, "available_bytes": available if memory.get("total") else None,
                           "detail": (f"Range needs {memory_required / 1024**3:.1f} GiB RAM; {available / 1024**3:.1f} GiB available after existing guests and host reserve. Free capacity before retrying if insufficient."
                                      if memory.get("total") else f"Range needs {memory_required / 1024**3:.1f} GiB RAM; available host capacity could not be verified.")})
            storage_requirements = (
                {} if snapshot_mode else
                linked_storage_required if linked_clone else {self._clone_storage: disk_required}
            )
            if snapshot_mode:
                checks.append({
                    "id": "storage:snapshot-baseline",
                    "ready": True,
                    "required_bytes": 0,
                    "available_bytes": None,
                    "detail": "Persistent snapshot baselines reuse existing VM disks.",
                })
            for storage_name, required in sorted(storage_requirements.items()):
                try:
                    storage = client.nodes(node).storage(storage_name).status.get()
                except Exception as exc:
                    checks.append({"id": f"storage-read-access:{storage_name}", "ready": False,
                                   "detail": f"Cannot verify clone storage {storage_name}: {exc}. Check token read permissions and storage availability."})
                    storage = {}
                free = int(storage.get("avail") or 0)
                clone_detail = (
                    f"Linked clones reserve {required / 1024**3:.1f} GiB of writable delta "
                    f"on {storage_name}; {free / 1024**3:.1f} GiB free. The storage must be active."
                    if linked_clone
                    else f"Full clones need up to {required / 1024**3:.1f} GiB on {storage_name}; {free / 1024**3:.1f} GiB free. The storage must be active."
                )
                checks.append({"id": f"storage:{storage_name}", "ready": bool(storage.get("active")) and free >= required,
                               "required_bytes": required, "available_bytes": free,
                               "detail": clone_detail})
            if any(net.get("vlan_id") is not None for net in spec.get("networks", [])):
                try:
                    networks = client.nodes(node).network.get()
                except Exception as exc:
                    checks.append({"id": "network-read-access", "ready": False,
                                   "detail": f"Cannot verify bridges on {node}: {exc}. Check token read permissions."})
                    networks = []
                bridge = next((n for n in networks if n.get("iface") == "vmbr200"), {})
                checks.append({"id": "network", "ready": bool(int(bridge.get("active") or 0)) and bool(int(bridge.get("bridge_vlan_aware") or 0)),
                               "detail": "vmbr200 must be active and VLAN-aware before preparation. Check Infrastructure > Bridges."})
            return checks

        return await self._call(_do)

    async def find_vm(self, name: str) -> VmState | None:
        """Find a permanent, non-template VM by its PVE display name."""
        def _do() -> dict | None:
            resources = self._get_client().cluster.resources.get(type="vm")
            for resource in resources:
                if resource.get("template"):
                    continue
                if resource.get("name") == name:
                    return resource
            return None

        resource = await self._call(_do)
        if resource is None:
            return None
        return VmState(
            vmid=int(resource["vmid"]),
            node=str(resource.get("node") or self._node or ""),
            name=str(resource.get("name") or name),
            status=str(resource.get("status") or "unknown"),
            ip=None,
        )

    async def allocate_vmid(self) -> int:
        def _do() -> int:
            # PVE 8+/9: `/cluster/nextid` is a GET, not POST. POST returns
            # 501 Not Implemented on PVE 9.1.7. Older docs and the proxmoxer
            # default assume POST, so we explicitly use GET for forward
            # compatibility.
            return int(self._get_client().cluster.nextid.get())

        return await self._call(_do)

    # --- lifecycle -------------------------------------------------------

    async def clone_vm(self, spec: CloneSpec) -> ClonedVM:
        if spec.source_vmid is None:
            raise ProxmoxAPIError("clone_vm requires source_vmid")
        node = spec.node
        if not node:
            raise ProxmoxAPIError("clone_vm requires a target node")

        log.info(
            "pve_runner.clone_start source_vmid=%s new_vmid=%s node=%s name=%s",
            spec.source_vmid, spec.new_vmid, node, spec.name,
        )

        # Allocate VMID BEFORE cloning to ensure we know the exact VMID
        new_vmid = int(spec.new_vmid) if spec.new_vmid is not None else await self.allocate_vmid()
        
        clone_params: dict[str, Any] = {
            "name": spec.name,
            "newid": new_vmid,
            "full": int(spec.full_clone),  # PVE API expects 0/1 form values
        }
        # PVE linked clones must remain beside their backing template.  Do not
        # force SSD-Backups for them: templates live across local-lvm and
        # SSD-Backups, and PVE selects the correct source storage itself.
        if spec.full_clone or spec.storage:
            clone_params["storage"] = spec.storage or self._clone_storage

        def _do() -> Any:
            return self._get_client().nodes(node).qemu(spec.source_vmid).clone.post(
                **clone_params
            )

        try:
            clone_upid = await self._call(_do)
        except ProxmoxAPIError as exc:
            # Some older template disks (notably legacy OPNsense images on
            # local-lvm) cannot be used as a linked-clone backing disk. Do
            # not fail the whole range for one small incompatible template:
            # clean any partial allocation and retry that VM as a full clone.
            # This remains opt-in at the scenario level; regular full clones
            # still use the normal single attempt.
            error_text = str(exc).lower()
            if spec.full_clone or not (
                "linked clone" in error_text and "not supported" in error_text
            ):
                raise
            log.warning(
                "pve_runner.linked_clone_unsupported source_vmid=%s new_vmid=%s; "
                "retrying as full clone on %s",
                spec.source_vmid,
                new_vmid,
                self._clone_storage,
            )
            try:
                await self.destroy_vm(new_vmid, node)
            except Exception as cleanup_exc:  # noqa: BLE001
                log.warning(
                    "pve_runner.linked_clone_cleanup_failed vmid=%s err=%s",
                    new_vmid,
                    cleanup_exc,
                )
            clone_params.clear()
            clone_params.update({
                "name": spec.name,
                "newid": new_vmid,
                "full": 1,
                "storage": self._clone_storage,
            })
            clone_upid = await self._call(_do)
        await self._wait_for_task(node, clone_upid, description=f"clone VM {new_vmid}")
        # PVE can report the clone task as stopped a moment before the
        # destination lock is released.  Windows full clones expose this
        # window more often because their disk copy is larger.  Give the
        # lock holder a short grace period before the first config write;
        # the config retry below remains the final guard.
        await asyncio.sleep(2)
        log.info("pve_runner.clone_complete new_vmid=%s", new_vmid)

        # Log config after clone
        def _get_config_after_clone() -> dict:
            return self._get_client().nodes(node).qemu(new_vmid).config.get()
        
        config_after_clone = await self._call(_get_config_after_clone)
        log.info(
            "pve_runner.config_after_clone vmid=%s boot=%s scsi0=%s ide2=%s",
            new_vmid,
            config_after_clone.get("boot"),
            config_after_clone.get("scsi0"),
            config_after_clone.get("ide2"),
        )

        config_overrides: dict[str, Any] = {}
        # A template may have carried a temporary Windows answer-file ISO.
        # Never boot drill clones from that media: Windows can interpret it as
        # fresh installation input and fall into the Setup restart loop.
        if config_after_clone.get("ide2"):
            log.info(
                "pve_runner.removing_template_cdrom vmid=%s ide2=%s",
                new_vmid,
                config_after_clone.get("ide2"),
            )

            def _remove_template_cdrom() -> None:
                self._get_client().nodes(node).qemu(new_vmid).config.post(
                    delete="ide2"
                )

            await self._call_with_lock_retry(
                _remove_template_cdrom,
                description=f"remove template CD-ROM from VM {new_vmid}",
            )

        # Do not rely on PVE template inheritance here.  Some full-clone
        # paths preserve the guest agent package but omit the VM-side QGA
        # channel, which makes Windows guests look permanently unready.
        config_overrides["agent"] = "enabled=1"
        # Drill VLANs are intentionally isolated from the Internet.  Do not
        # let Proxmox cloud-init start a package upgrade on every clone: it
        # can block boot and QGA while waiting for unreachable repositories.
        config_overrides["ciupgrade"] = 0
        if spec.cores is not None:
            config_overrides["cores"] = spec.cores
        if spec.sockets is not None:
            config_overrides["sockets"] = spec.sockets
        if spec.ram_mb is not None:
            config_overrides["memory"] = spec.ram_mb
        for nic_index, ip_config in (spec.ip_configs or {}).items():
            if ip_config:
                config_overrides[f"ipconfig{int(nic_index)}"] = ip_config

        if config_overrides:
            log.info("pve_runner.applying_config_overrides vmid=%s overrides=%s", new_vmid, config_overrides)
            def _config() -> None:
                self._get_client().nodes(node).qemu(new_vmid).config.post(**config_overrides)

            await self._call_with_lock_retry(
                _config,
                description=f"configure cloned VM {new_vmid}",
            )

        if spec.disk_gb is not None:
            resize_disk = self._primary_disk_key(config_after_clone) or "scsi0"
            disk_config = str(config_after_clone.get(resize_disk) or "")
            size_match = re.search(r"(?:^|,)size=([0-9]+)([MGTP])", disk_config)
            current_size_gb = 0.0
            if size_match:
                value = float(size_match.group(1))
                current_size_gb = value / 1024 if size_match.group(2) == "M" else value
                if size_match.group(2) == "T":
                    current_size_gb *= 1024
            additional_gb = max(0, int(spec.disk_gb) - int(current_size_gb))
            if additional_gb:
                log.info(
                    "pve_runner.resizing_disk vmid=%s disk=%s current_gb=%s target_gb=%s add_gb=%s",
                    new_vmid,
                    resize_disk,
                    current_size_gb,
                    spec.disk_gb,
                    additional_gb,
                )

                def _resize() -> Any:
                    return self._get_client().nodes(node).qemu(new_vmid).resize.put(
                        disk=resize_disk,
                        size=f"+{additional_gb}G",
                    )

                resize_upid = await self._call(_resize)
                try:
                    await self._wait_for_task(
                        node,
                        resize_upid,
                        description=f"resize VM {new_vmid} disk",
                    )
                except ProxmoxAPIError as exc:
                    # Disk growth is an optimization for a clone, not a
                    # reason to lose an otherwise bootable drill.  Raw-file
                    # growth on the backup filesystem can exceed PVE's task
                    # timeout while the original template disk remains
                    # perfectly usable.
                    resize_error = str(exc).lower()
                    if "resize" not in resize_error or not any(
                        marker in resize_error for marker in ("timed out", "timeout")
                    ):
                        raise
                    log.warning(
                        "pve_runner.disk_resize_degraded vmid=%s disk=%s target_gb=%s err=%s",
                        new_vmid,
                        resize_disk,
                        spec.disk_gb,
                        exc,
                    )
            else:
                log.info(
                    "pve_runner.disk_resize_skipped vmid=%s disk=%s current_gb=%s target_gb=%s",
                    new_vmid,
                    resize_disk,
                    current_size_gb,
                    spec.disk_gb,
                )

        # Q27: Recreate cloud-init drive for cloned VM
        await self._fix_cloud_init_storage(new_vmid, node, template_name=spec.template_name)

        # Final config check
        def _get_final_config() -> dict:
            return self._get_client().nodes(node).qemu(new_vmid).config.get()
        
        final_config = await self._call(_get_final_config)
        log.info(
            "pve_runner.final_config vmid=%s boot=%s scsi0=%s ide2=%s cores=%s memory=%s",
            new_vmid,
            final_config.get("boot"),
            final_config.get("scsi0"),
            final_config.get("ide2"),
            final_config.get("cores"),
            final_config.get("memory"),
        )

        return ClonedVM(vmid=new_vmid, node=node, name=spec.name)

    async def _wait_for_task(
        self,
        node: str,
        upid: Any,
        *,
        description: str,
        timeout_s: int = 600,
    ) -> None:
        """Wait for an asynchronous PVE task before touching its VM state."""
        if not isinstance(upid, str) or not upid:
            return
        deadline = asyncio.get_running_loop().time() + timeout_s
        while True:
            def _status() -> dict:
                return self._get_client().nodes(node).tasks(upid).status.get()

            status = await self._call(_status)
            if str(status.get("status") or "").lower() == "stopped":
                exitstatus = str(status.get("exitstatus") or "OK")
                if exitstatus != "OK":
                    raise ProxmoxAPIError(
                        f"PVE {description} failed: {exitstatus}"
                    )
                return
            if asyncio.get_running_loop().time() >= deadline:
                raise ProxmoxAPIError(f"PVE {description} timed out")
            await asyncio.sleep(2)

    async def _call_with_lock_retry(
        self,
        operation: Callable[[], Any],
        *,
        description: str,
        attempts: int = 30,
        delay_s: float = 2.0,
    ) -> Any:
        """Retry short-lived PVE VM-lock races after asynchronous tasks."""
        for attempt in range(1, attempts + 1):
            try:
                return await self._call(operation)
            except ProxmoxAPIError as exc:
                if "can't lock file" not in str(exc) or attempt >= attempts:
                    raise
                log.warning(
                    "pve_runner.lock_retry description=%s attempt=%s/%s err=%s",
                    description,
                    attempt,
                    attempts,
                    exc,
                )
                await asyncio.sleep(delay_s)
        raise ProxmoxAPIError(f"PVE {description} failed after lock retries")

    async def set_vm_name(self, vmid: int, node: str, name: str) -> None:
        """Update only the PVE VM name; keep guest identity and VMID intact."""
        await self._call(lambda: self._get_client().nodes(node).qemu(vmid).config.put(name=name))

    async def start_vm(self, vmid: int, node: str) -> None:
        log.info("pve_runner.starting_vm vmid=%s node=%s", vmid, node)
        
        def _do() -> None:
            self._get_client().nodes(node).qemu(vmid).status.start.post()

        for attempt in range(1, 4):
            try:
                await self._call(_do)
                break
            except ProxmoxAPIError as exc:
                msg = str(exc)
                if "got no worker upid" not in msg or attempt >= 3:
                    raise
                log.warning(
                    "pve_runner.start_worker_failed_retry vmid=%s node=%s attempt=%s err=%s",
                    vmid,
                    node,
                    attempt,
                    exc,
                )
                await asyncio.sleep(2 * attempt)
                try:
                    state = await self.get_vm_state(vmid, node)
                    if state.status == "running":
                        log.info(
                            "pve_runner.start_worker_failed_but_running vmid=%s node=%s",
                            vmid,
                            node,
                        )
                        break
                except ProxmoxAPIError:
                    pass
        log.info("pve_runner.start_command_sent vmid=%s", vmid)

        # Q27: Verify VM actually started. PVE may accept the start
        # command but the VM could fail to boot (e.g., storage issues).
        # Wait briefly and check status.
        await asyncio.sleep(2)
        
        def _check() -> dict:
            return self._get_client().nodes(node).qemu(vmid).status.current.get()
        
        status = await self._call(_check)
        log.info(
            "pve_runner.vm_status_after_start vmid=%s status=%s qmpstatus=%s",
            vmid,
            status.get("status"),
            status.get("qmpstatus"),
        )
        
        if status.get("status") != "running":
            raise ProxmoxAPIError(
                f"VM {vmid} failed to start: status={status.get('status')}, "
                f"qmpstatus={status.get('qmpstatus')}"
            )
        
        # Wait 5 seconds and check if VM stays running
        log.info("pve_runner.waiting_5s_to_verify vmid=%s", vmid)
        await asyncio.sleep(5)
        
        def _check_again() -> dict:
            return self._get_client().nodes(node).qemu(vmid).status.current.get()
        
        status_after_wait = await self._call(_check_again)
        log.info(
            "pve_runner.vm_status_after_5s vmid=%s status=%s qmpstatus=%s",
            vmid,
            status_after_wait.get("status"),
            status_after_wait.get("qmpstatus"),
        )
        
        if status_after_wait.get("status") != "running":
            log.error(
                "pve_runner.vm_shutdown_after_start vmid=%s status=%s",
                vmid,
                status_after_wait.get("status"),
            )

    async def ensure_vm_running(
        self, name: str, node: str, timeout_s: float = 90.0
    ) -> VmState:
        """Keep permanent infrastructure online before a drill starts."""
        state = await self.find_vm(name)
        if state is None:
            raise ProxmoxAPIError(
                f"permanent infrastructure VM {name!r} was not found on PVE"
            )
        if state.node != node:
            raise ProxmoxAPIError(
                f"permanent infrastructure VM {name!r} is on node {state.node!r}, "
                f"but this drill targets node {node!r}"
            )

        if state.status != "running":
            log.warning(
                "pve_runner.infrastructure_start name=%s vmid=%s node=%s status=%s",
                name, state.vmid, state.node, state.status,
            )
            await self.start_vm(state.vmid, state.node)

        deadline = asyncio.get_running_loop().time() + timeout_s
        last_state = state
        while asyncio.get_running_loop().time() < deadline:
            last_state = await self.get_vm_state(state.vmid, state.node)
            if last_state.status == "running":
                log.info(
                    "pve_runner.infrastructure_ready name=%s vmid=%s node=%s",
                    name, state.vmid, state.node,
                )
                return last_state
            await asyncio.sleep(2)

        raise ProxmoxAPIError(
            f"permanent infrastructure VM {name!r} did not become ready "
            f"within {int(timeout_s)}s (status={last_state.status})"
        )

    async def seed_vm(self, vmid: int, node: str, seed: SeedSpec) -> None:
        """Apply basic scenario seed via PVE cloud-init config.

        This makes cloned VMs immediately usable with role-specific login
        credentials. File/script seed payloads are recorded in the VM
        description for operator traceability; full snippet injection can
        be layered onto this method once snippets storage is configured.
        """
        payload: dict[str, Any] = {}
        if seed.ciuser:
            payload["ciuser"] = seed.ciuser
        if seed.cipassword:
            payload["cipassword"] = seed.cipassword
        files = seed.files or {}
        commands = seed.runcmd or []
        payload["description"] = (
            f"divide seeded role={seed.role}; "
            f"files={len(files)}; commands={len(commands)}; "
            "seed=guest-agent"
        )
        if not payload:
            return

        log.info("pve_runner.seed_vm vmid=%s node=%s role=%s", vmid, node, seed.role)

        def _do() -> None:
            self._get_client().nodes(node).qemu(vmid).config.post(**payload)

        try:
            await self._call(_do)
        except ProxmoxAPIError as exc:
            log.warning(
                "pve_runner.seed_config_failed_continue vmid=%s node=%s role=%s err=%s",
                vmid,
                node,
                seed.role,
                exc,
                exc_info=True,
            )

    async def _wait_for_windows_oobe(
        self,
        vmid: int,
        node: str,
        *,
        timeout_seconds: int,
    ) -> None:
        """Wait until Windows finishes OOBE before running drill commands.

        QEMU Guest Agent can answer while ``windeploy.exe`` is still
        completing OOBE. Changing the network or hostname during that window
        can make Windows Setup report an unexpected restart and leave the VM
        unusable. Query the setup state through QGA without mutating the
        guest, then let the scenario phases begin only after OOBE is done.
        """
        # PowerShell can itself block during the final OOBE transition. The
        # small built-in registry utility remains usable at that stage, so it
        # gives us a bounded readiness probe rather than an indefinitely
        # running guest-exec request.
        query = [
            "cmd.exe",
            "/c",
            'reg query "HKLM\\SYSTEM\\Setup" /v OOBEInProgress 2>nul || echo OOBEInProgress    REG_DWORD    0x0',
        ]

        def _start_query() -> Any:
            return self._get_client().nodes(node).qemu(vmid).agent("exec").post(
                command=query
            )

        deadline = asyncio.get_running_loop().time() + max(120, timeout_seconds)
        bypass_attempted = False
        while True:
            try:
                result = await self._call(_start_query)
            except ProxmoxAPIError as exc:
                if "guest agent is not running" not in str(exc):
                    raise
                if asyncio.get_running_loop().time() >= deadline:
                    raise ProxmoxAPIError(
                        f"Windows guest agent did not become ready for OOBE check on VM {vmid}"
                    ) from exc
                await asyncio.sleep(5)
                continue

            pid = result.get("pid") if isinstance(result, dict) else None
            if pid is None:
                raise ProxmoxAPIError(
                    f"Windows OOBE check returned no guest-agent PID for VM {vmid}"
                )

            query_deadline = min(
                deadline, asyncio.get_running_loop().time() + 30
            )
            while True:
                def _status() -> Any:
                    return self._get_client().nodes(node).qemu(vmid).agent(
                        "exec-status"
                    ).get(pid=pid)

                try:
                    status = await self._call(_status)
                except ProxmoxAPIError as exc:
                    if "guest agent is not running" in str(exc):
                        break
                    raise
                if status.get("exited"):
                    output = str(status.get("out-data") or "").strip().lower()
                    if "0x0" in output:
                        log.info("pve_runner.windows_oobe_complete vmid=%s", vmid)
                        return
                    if not bypass_attempted:
                        # Golden images occasionally reach the first-region
                        # screen even though QGA is online. Complete that
                        # machine-only OOBE step non-interactively so the
                        # baseline builder can continue with its declared
                        # Windows configuration.
                        bypass_attempted = True
                        bypass = [
                            "cmd.exe", "/c",
                            'reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE" /v SkipMachineOOBE /t REG_DWORD /d 1 /f '
                            '&& reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE" /v SkipUserOOBE /t REG_DWORD /d 1 /f',
                        ]
                        try:
                            await self._call(
                                lambda: self._get_client().nodes(node).qemu(vmid).agent("exec").post(
                                    command=bypass
                                )
                            )
                            await self._reboot_guest_and_wait(vmid, node)
                            continue
                        except ProxmoxAPIError as exc:
                            log.warning(
                                "pve_runner.windows_oobe_bypass_failed vmid=%s err=%s",
                                vmid, exc,
                            )
                    log.info(
                        "pve_runner.waiting_windows_oobe vmid=%s output=%s",
                        vmid, output[-200:] or "unknown",
                    )
                    break
                if asyncio.get_running_loop().time() >= query_deadline:
                    break
                await asyncio.sleep(1)

            if asyncio.get_running_loop().time() >= deadline:
                raise ProxmoxAPIError(
                    f"Windows OOBE did not complete for VM {vmid}"
                )
            await asyncio.sleep(5)

    async def apply_guest_seed(
        self,
        vmid: int,
        node: str,
        seed: SeedSpec,
        *,
        phase_name: str | None = None,
        timeout_seconds: int | None = None,
        reboot_expected: bool = False,
    ) -> bool:
        """Write scenario files inside a running Linux guest via QEMU agent.

        PVE 9 on this host rejects snippet uploads through the storage upload
        endpoint even when the storage advertises snippets. Guest-agent
        execution keeps seeding independent of storage content types.
        """
        files = seed.files or {}
        commands = seed.runcmd or []
        windows_commands = seed.windows_commands or []
        windows_phases = seed.windows_phases or []

        log.info(
            "pve_runner.guest_seed_plan vmid=%s windows_commands=%s windows_phases=%s files=%s commands=%s",
            vmid,
            len(windows_commands),
            len(windows_phases),
            len(files),
            len(commands),
        )

        if windows_phases:
            for index, phase in enumerate(windows_phases, start=1):
                phase_name = str(phase.get("name") or f"phase-{index}")
                phase_timeout = max(60, int(phase.get("timeout_seconds") or 900))
                log.info(
                    "pve_runner.windows_phase_start vmid=%s phase=%s timeout_seconds=%s reboot=%s",
                    vmid, phase_name, phase_timeout, bool(phase.get("reboot")),
                )
                phase_seed = SeedSpec(
                    role=seed.role,
                    windows_commands=list(phase.get("commands") or []),
                )
                reboot_handled = await self.apply_guest_seed(
                    vmid, node, phase_seed,
                    phase_name=phase_name,
                    timeout_seconds=phase_timeout,
                    reboot_expected=bool(phase.get("reboot")),
                )
                if phase.get("reboot") and not reboot_handled:
                    await self._reboot_guest_and_wait(vmid, node)
                log.info(
                    "pve_runner.windows_phase_complete vmid=%s phase=%s",
                    vmid, phase_name,
                )
            return False

        if not files and not commands and not windows_commands:
            return

        if windows_commands:
            await self._wait_for_windows_oobe(
                vmid,
                node,
                timeout_seconds=max(120, int(timeout_seconds or 600)),
            )

        if windows_commands:
            # Windows templates do not have cloud-init. Keep setup explicit in
            # the scenario and execute it only after the cloned guest is up.
            # Pass the script as an encoded argument instead of stdin. QGA can
            # leave the stdin stream open for ``-Command -``, which makes
            # PowerShell wait forever after the command has otherwise started.
            # UTF-16LE is the format required by Windows PowerShell's
            # ``-EncodedCommand`` option.
            input_data = "\n".join(windows_commands)
            encoded_script = base64.b64encode(
                input_data.encode("utf-16le")
            ).decode("ascii")
            command = [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                encoded_script,
            ]
            input_data = None
        else:
            script_parts = ["set -eu", "mkdir -p /opt/divide/flags"]
            for path, content in sorted(files.items()):
                encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
                encoded_path = base64.b64encode(path.encode("utf-8")).decode("ascii")
                script_parts.extend(
                    [
                        f"p=$(printf %s {encoded_path} | base64 -d)",
                        "mkdir -p \"$(dirname \"$p\")\"",
                        f"printf %s {encoded} | base64 -d > \"$p\"",
                        "chown root:root \"$p\"",
                        "chmod 0600 \"$p\"",
                    ]
                )
            script_parts.extend(commands)
            command = ["/bin/sh", "-c", "\n".join(script_parts)]
            input_data = None

        def _start_exec() -> Any:
            params: dict[str, Any] = {"command": command}
            if input_data is not None:
                params["input-data"] = input_data
            return self._get_client().nodes(node).qemu(vmid).agent("exec").post(**params)

        # Windows Server can take several minutes to bring QGA online after a
        # cold clone, especially before the first domain-controller reboot.
        # Linux guests retain the shorter readiness window.
        deadline = asyncio.get_running_loop().time() + (
            max(60, int(timeout_seconds or 300)) if windows_commands else 300
        )
        while True:
            try:
                result = await self._call(_start_exec)
                break
            except ProxmoxAPIError as exc:
                if "guest agent is not running" not in str(exc):
                    raise
                if asyncio.get_running_loop().time() >= deadline:
                    raise ProxmoxAPIError(
                        f"guest agent did not become ready for VM {vmid}"
                    ) from exc
                log.info("pve_runner.waiting_guest_agent vmid=%s", vmid)
                await asyncio.sleep(5)
        pid = result.get("pid") if isinstance(result, dict) else None
        if pid is None:
            raise ProxmoxAPIError(f"guest agent returned no execution pid for VM {vmid}")

        # Role setup can include Windows feature installation or AD
        # promotion.  Let those commands finish instead of reporting a
        # false provisioning failure while PowerShell is still running.
        deadline = asyncio.get_running_loop().time() + (
            max(60, int(timeout_seconds or 900)) if windows_commands else 45
        )
        while True:
            def _status() -> Any:
                return self._get_client().nodes(node).qemu(vmid).agent(
                    "exec-status"
                ).get(pid=pid)

            try:
                status = await self._call(_status)
            except ProxmoxAPIError as exc:
                if (
                    windows_commands
                    and "guest agent is not running" in str(exc)
                    and asyncio.get_running_loop().time() < deadline
                ):
                    log.info("pve_runner.waiting_guest_agent_status vmid=%s", vmid)
                    await asyncio.sleep(5)
                    continue
                if (
                    windows_commands
                    and "PID" in str(exc)
                    and "does not exist" in str(exc)
                    and asyncio.get_running_loop().time() < deadline
                ):
                    # A phase may legitimately restart QGA while Windows
                    # applies a rename or role change. Recover once without
                    # replaying the whole PowerShell block; replaying an AD
                    # promotion or domain join is unsafe.
                    if reboot_expected:
                        log.info(
                            "pve_runner.windows_phase_reboot_detected vmid=%s phase=%s",
                            vmid,
                            phase_name,
                        )
                        # The guest has already restarted or is restarting.
                        # Do not issue a second PVE reboot here; the next
                        # phase's bounded guest-agent readiness loop will
                        # wait for QGA to become executable again.
                        await asyncio.sleep(15)
                        return True
                    raise ProxmoxAPIError(
                        f"Windows guest command lost its QGA process for VM {vmid}"
                        + (f" during {phase_name}" if phase_name else "")
                    ) from exc
                raise
            if status.get("exited"):
                if int(status.get("exitcode") or 0) != 0:
                    raise ProxmoxAPIError(
                        f"guest seed command failed for VM {vmid}: "
                        f"exitcode={status.get('exitcode')} "
                        f"stderr={_guest_error(status.get('err-data'))}"
                    )
                log.info(
                    "pve_runner.guest_seed_applied vmid=%s node=%s files=%s commands=%s",
                    vmid,
                    node,
                    len(files),
                    len(commands),
                )
                return False
            if asyncio.get_running_loop().time() >= deadline:
                message = f"guest seed command timed out for VM {vmid}"
                if phase_name:
                    message += f" during {phase_name} after {int(timeout_seconds or 300)} seconds"
                raise ProxmoxAPIError(message)
            await asyncio.sleep(1)

    async def verify_windows_role(
        self,
        vmid: int,
        node: str,
        expected_ip: str,
        domain: str,
        controller: str = "member",
    ) -> None:
        """Verify that a Windows role completed, not merely that it booted."""
        if not expected_ip or not domain:
            raise ProxmoxAPIError(
                f"Windows verification is missing expected_ip/domain for VM {vmid}"
            )

        script = "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                "$ProgressPreference = 'SilentlyContinue'",
                f"$expectedIp = '{expected_ip}'",
                f"$expectedDomain = '{domain}'",
                "$ips = @(Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress)",
                "if ($ips -notcontains $expectedIp) { throw \"expected IP $expectedIp not present\" }",
                "$computer = Get-CimInstance Win32_ComputerSystem",
                "if (-not $computer.PartOfDomain -or $computer.Domain -ne $expectedDomain) { throw \"domain is $($computer.Domain), expected $expectedDomain\" }",
                "$ready = $false",
                "for ($attempt = 0; $attempt -lt 36; $attempt++) {",
                "  $services = @(Get-Service DNS,NTDS -ErrorAction SilentlyContinue)",
                "  if ($services.Count -ge 2 -and @($services | Where-Object Status -ne 'Running').Count -eq 0) { $ready = $true; break }",
                "  Start-Sleep -Seconds 5",
                "}",
                "if (-not $ready) { throw 'DNS/NTDS did not become ready within 180 seconds' }",
                "if (-not (Test-Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\NTDS\\Parameters')) { throw 'NTDS registry marker is missing' }",
                f"if ('{controller}' -eq 'primary' -and -not (Test-Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\NTDS')) {{ throw 'primary controller service marker is missing' }}",
                "Write-Output 'DIVIDE_WINDOWS_READY'",
            ]
        )
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        command = [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ]

        def _start_exec() -> Any:
            return self._get_client().nodes(node).qemu(vmid).agent("exec").post(
                command=command
            )

        deadline = asyncio.get_running_loop().time() + 180
        while True:
            try:
                result = await self._call(_start_exec)
                break
            except ProxmoxAPIError as exc:
                if "guest agent is not running" not in str(exc):
                    raise
                if asyncio.get_running_loop().time() >= deadline:
                    raise ProxmoxAPIError(
                        f"Windows guest agent did not recover for verification on VM {vmid}"
                    ) from exc
                await asyncio.sleep(5)

        pid = result.get("pid") if isinstance(result, dict) else None
        if pid is None:
            raise ProxmoxAPIError(f"Windows verification returned no PID for VM {vmid}")

        deadline = asyncio.get_running_loop().time() + 180
        while True:
            status = await self._call(
                lambda: self._get_client().nodes(node).qemu(vmid).agent(
                    "exec-status"
                ).get(pid=pid)
            )
            if status.get("exited"):
                if int(status.get("exitcode") or 0) != 0:
                    raise ProxmoxAPIError(
                        f"Windows readiness check failed for VM {vmid}: "
                        f"{_guest_error(status.get('err-data'))}"
                    )
                return
            if asyncio.get_running_loop().time() >= deadline:
                raise ProxmoxAPIError(f"Windows readiness check timed out for VM {vmid}")
            await asyncio.sleep(2)

    async def _reboot_guest_and_wait(self, vmid: int, node: str) -> None:
        """Reboot a Windows guest and wait for QEMU Guest Agent recovery."""

        def _reboot() -> Any:
            # Use PVE's reboot task instead of guest-exec shutdown.exe. The
            # latter can keep the QGA request open while Windows is tearing
            # down services, leaving provisioning waiting on a never-ending
            # guest command even though the VM is healthy.
            return self._get_client().nodes(node).qemu(vmid).status.reboot.post()

        try:
            await self._call(_reboot)
        except ProxmoxAPIError as exc:
            # Windows may close the agent immediately after accepting reboot.
            if "guest agent is not running" not in str(exc):
                raise

        await asyncio.sleep(8)
        # AD role installation and the first rename/reboot can take several
        # minutes before Windows starts QGA again. Keep the VM alive while it
        # completes instead of tearing down a valid but slow guest.
        deadline = asyncio.get_running_loop().time() + 600
        attempts = 0
        while True:
            def _probe() -> Any:
                # A ping only proves that the QGA socket answers. Probe an
                # actual guest-exec request because the next provisioning
                # phase depends on command execution, not just connectivity.
                return self._get_client().nodes(node).qemu(vmid).agent("exec").post(
                    command=["cmd.exe", "/c", "exit", "0"]
                )

            try:
                result = await self._call(_probe)
                probe_pid = result.get("pid") if isinstance(result, dict) else None
                if probe_pid is not None:
                    probe_deadline = asyncio.get_running_loop().time() + 30
                    while asyncio.get_running_loop().time() < probe_deadline:
                        probe_status = await self._call(
                            lambda: self._get_client().nodes(node).qemu(vmid).agent(
                                "exec-status"
                            ).get(pid=probe_pid)
                        )
                        if probe_status.get("exited"):
                            if int(probe_status.get("exitcode") or 0) == 0:
                                log.info(
                                    "pve_runner.windows_reboot_ready vmid=%s",
                                    vmid,
                                )
                                return
                            break
                        await asyncio.sleep(1)
            except ProxmoxAPIError:
                pass
            attempts += 1
            if attempts % 6 == 0:
                log.info(
                    "pve_runner.waiting_windows_guest_exec vmid=%s attempts=%s",
                    vmid,
                    attempts,
                )
            if asyncio.get_running_loop().time() >= deadline:
                raise ProxmoxAPIError(
                    f"guest agent did not accept commands after Windows reboot for VM {vmid}"
                )
            await asyncio.sleep(5)

    async def stop_vm(self, vmid: int, node: str, force: bool = False) -> None:
        """Stop a VM.

        PVE 9 dropped the legacy ``forceStop=1`` parameter that older
        proxmoxer versions emitted -- the schema now rejects it with
        ``property is not defined in schema``. We pass ``timeout=N``
        which IS supported on PVE 9 (positive int = max wait seconds;
        0 = skip the ACPI shutdown and power off immediately, which
        is the documented "force" behaviour).

        ``force=True`` from the caller maps to ``timeout=0`` so we
        skip the ACPI shutdown. ``force=False`` uses ``timeout=60``
        to give the guest a chance to flush its disks.
        """
        timeout = 0 if force else 60

        def _do() -> None:
            self._get_client().nodes(node).qemu(vmid).status.stop.post(
                timeout=timeout
            )

        try:
            await self._call(_do)
        except ProxmoxAPIError as exc:
            # A concurrent cleanup or operator action may have removed the
            # VM before the stop request arrived. That is already the
            # desired teardown state.
            if _is_missing_vm_error(exc):
                log.info("pve_runner.stop_vm_missing vmid=%s node=%s", vmid, node)
                return
            raise

        # Q27: Wait for VM to actually stop before returning.
        # PVE stop command is async - it returns immediately but
        # the VM may still be shutting down. Without this wait,
        # destroy_vm can fail with "VM is running" error.
        for _ in range(30):  # Wait up to 30 seconds
            await asyncio.sleep(1)
            def _check() -> dict:
                return self._get_client().nodes(node).qemu(vmid).status.current.get()
            try:
                status = await self._call(_check)
            except ProxmoxAPIError as exc:
                if _is_missing_vm_error(exc):
                    log.info("pve_runner.stop_vm_missing_after_stop vmid=%s node=%s", vmid, node)
                    return
                raise
            if status.get("status") == "stopped":
                break
        else:
            log.warning("stop_vm timeout waiting for vmid=%s to stop", vmid)

    async def destroy_vm(self, vmid: int, node: str) -> None:
        """Delete VM + purge disk. Idempotent: missing VM is a no-op.

        proxmoxer's DELETE returns the upid of the destroy task; if the VM
        is already gone PVE responds with 404 and we treat that as success
        so callers (runner teardown) can safely re-run.
        """
        def _do() -> None:
            try:
                # Q17: drop ``skiplock=1`` -- PVE 9 reserves it for
                # ``root@pam`` and rejects non-superuser tokens with
                # "Only root may use this option". ``purge=1`` alone
                # destroys the VM + its disks, which is what the
                # runner always wants on cleanup. Operators running
                # the DivideDrill role don't race against PVE's
                # internal VM locks; they own the VM namespace.
                self._get_client().nodes(node).qemu(vmid).delete(
                    purge=1
                )
            except Exception as exc:  # noqa: BLE001
                # Be tolerant: PVE returns 404 when the VM is gone
                # in older versions, but **PVE 9 returns HTTP 500**
                # with body ``Configuration file 'nodes/pve/qemu-server/
                # {vmid}.conf' does not exist`` -- proxmoxer surfaces
                # this as ``ResourceException`` whose message contains
                # "does not exist". Treat both as idempotent success
                # so the runner can re-enter destroy_vm safely.
                msg = str(exc).lower()
                if _is_missing_vm_error(msg):
                    return
                raise

        await self._call(_do)

    async def list_vm_snapshots(self, vmid: int, node: str) -> list[str]:
        """List named snapshots without treating PVE's `current` row as one."""
        def _do() -> list[str]:
            rows = self._get_client().nodes(node).qemu(vmid).snapshot.get()
            return sorted({
                str(row["name"])
                for row in rows or []
                if row.get("name") and row.get("name") != "current"
            })

        return await self._call(_do)

    async def create_vm_snapshot(
        self, vmid: int, node: str, name: str, description: str = ""
    ) -> None:
        """Create a cold snapshot and wait until PVE finishes writing it."""
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name or ""):
            raise ValueError("Snapshot names must be 1-40 letters, digits, '_' or '-'.")
        state = await self.get_vm_state(vmid, node)
        if state.status != "stopped":
            raise ProxmoxAPIError(
                f"Cannot create cold snapshot {name!r} for running VM {vmid}; stop it first."
            )

        def _do() -> Any:
            return self._get_client().nodes(node).qemu(vmid).snapshot.post(
                snapname=name,
                description=description[:255],
                vmstate=0,
            )

        upid = await self._call(_do)
        await self._wait_for_task(node, upid, description=f"snapshot VM {vmid}")

    async def restore_vm_snapshot(self, vmid: int, node: str, name: str) -> None:
        """Restore a named cold snapshot and leave the VM stopped."""
        if name not in await self.list_vm_snapshots(vmid, node):
            raise ProxmoxAPIError(f"Snapshot {name!r} does not exist for VM {vmid}.")
        state = await self.get_vm_state(vmid, node)
        if state.status != "stopped":
            raise ProxmoxAPIError(
                f"Cannot restore snapshot {name!r} for running VM {vmid}; stop it first."
            )

        def _do() -> Any:
            return self._get_client().nodes(node).qemu(vmid).snapshot(name).rollback.post(
                start=0
            )

        upid = await self._call(_do)
        await self._wait_for_task(node, upid, description=f"restore snapshot for VM {vmid}")

    @staticmethod
    def _looks_like_windows_template(template_name: str | None) -> bool:
        text = str(template_name or "").lower()
        return "win" in text or "windows" in text

    @staticmethod
    def _primary_disk_key(config: dict) -> str | None:
        for key in ("scsi0", "sata0", "virtio0", "ide0"):
            value = config.get(key)
            if isinstance(value, str) and "cloudinit" not in value.lower():
                return key
        return None

    @staticmethod
    def _cloud_init_storage_id(value: str) -> str | None:
        volume = value.split(",", 1)[0]
        if ":" not in volume:
            return None
        return volume.split(":", 1)[0]

    async def _fix_cloud_init_storage(
        self,
        vmid: int,
        node: str,
        template_name: str | None = None,
    ) -> None:
        """Q27: Clean up broken cloud-init drives and ensure proper boot order.
        
        If the template had a cloud-init drive on `local` storage, cloning it creates
        an invalid reference in the clone. We detect any such broken drives and remove
        them. Do not force Windows or non-scsi templates to boot from scsi0.
        """
        def _get_config() -> dict:
            return self._get_client().nodes(node).qemu(vmid).config.get()
        
        config = await self._call(_get_config)
        
        # Check for broken cloud-init drives. Linux clones need a valid
        # cloud-init CD-ROM for cicustom snippets; do not remove it just
        # because the volume name contains "cloudinit".
        broken_drives = []
        windows_template = self._looks_like_windows_template(template_name)
        for key, value in config.items():
            if (
                key.startswith("ide")
                and isinstance(value, str)
                and "cloudinit" in value.lower()
            ):
                storage_id = self._cloud_init_storage_id(value)
                if windows_template or storage_id == "local" or not storage_id:
                    broken_drives.append(key)
        
        log.info(
            "pve_runner.checking_cloud_init vmid=%s broken_drives=%s boot=%s",
            vmid,
            broken_drives,
            config.get("boot"),
        )
        
        # If no broken drives and a boot order already exists, preserve it.
        current_boot = str(config.get("boot", ""))
        primary_disk = self._primary_disk_key(config)
        has_static_network = any(
            key.startswith("ipconfig") and isinstance(value, str) and value
            for key, value in config.items()
        )
        has_cloud_init_drive = any(
            key.startswith("ide")
            and isinstance(value, str)
            and "cloudinit" in value.lower()
            for key, value in config.items()
        )
        needs_cloud_init_drive = (
            not windows_template
            and has_static_network
            and not has_cloud_init_drive
            and not config.get("ide2")
        )
        if not broken_drives and current_boot and not needs_cloud_init_drive:
            return
        if not broken_drives and not primary_disk:
            return
        
        def _apply_clean_config() -> None:
            params: dict[str, Any] = {}
            # Windows templates may have their own firmware/device boot
            # assumptions. Remove cloned cloud-init drives, but never invent a
            # boot order for Windows.
            if not current_boot and primary_disk and not windows_template:
                params["boot"] = f"order={primary_disk}"
            if broken_drives:
                params["delete"] = ",".join(broken_drives)
            if needs_cloud_init_drive:
                params["ide2"] = f"{self._clone_storage}:cloudinit"
            if not params:
                return
            self._get_client().nodes(node).qemu(vmid).config.post(**params)
        
        await self._call(_apply_clean_config)
        
        log.info(
            "pve_runner.cloud_init_cleaned vmid=%s deleted=%s boot=%s",
            vmid,
            broken_drives,
            f"order={primary_disk}" if not current_boot and primary_disk else current_boot,
        )
        if needs_cloud_init_drive:
            log.info(
                "pve_runner.cloud_init_attached vmid=%s storage=%s",
                vmid,
                self._clone_storage,
            )

    async def get_vm_state(self, vmid: int, node: str) -> VmState:
        """Return current state. PVE returns 'running'|'stopped'|'paused'|...

        IP discovery order:
        1. Query QEMU guest agent (agent/network-get-interfaces) if available.
        2. Status payload `ip` field.
        3. Config `ipconfig0` static definition fallback.
        """
        def _do() -> dict:
            return self._get_client().nodes(node).qemu(vmid).status.current.get()

        current = await self._call(_do)

        ip: str | None = None

        # 1. Try QEMU guest agent for live runtime IP addresses
        if current.get("status") == "running":
            def _get_agent_ips() -> str | None:
                try:
                    res = self._get_client().nodes(node).qemu(vmid).agent("network-get-interfaces").get()
                    ifaces = res.get("result", []) if isinstance(res, dict) else res
                    for iface in ifaces:
                        if iface.get("name") in ("lo", "loopback"):
                            continue
                        for addr_info in iface.get("ip-addresses", []):
                            if addr_info.get("ip-address-type") == "ipv4":
                                addr = addr_info.get("ip-address")
                                if addr and not addr.startswith("127."):
                                    return addr
                except Exception:
                    pass
                return None

            try:
                ip = await self._call(_get_agent_ips)
            except Exception:
                ip = None

        # 2. `ip` field on status
        if not ip and current.get("ip"):
            ip = current["ip"]

        # 3. Try config fallback
        if not ip:
            try:
                cfg = self._get_client().nodes(node).qemu(vmid).config.get()
                ipconfig0 = cfg.get("ipconfig0") or ""
                # Format: "ip=dhcp" or "ip=10.0.0.5/24,gw=10.0.0.1"
                for part in ipconfig0.split(","):
                    kv = part.split("=", 1)
                    if len(kv) == 2 and kv[0] == "ip" and kv[1] not in ("", "dhcp"):
                        ip = kv[1].split("/", 1)[0]
                        break
            except Exception:  # noqa: BLE001
                ip = None

        return VmState(
            vmid=int(current.get("vmid", vmid)),
            node=node,
            name=current.get("name") or f"vmid-{vmid}",
            status=current.get("status", "unknown"),
            ip=ip,
        )

    async def create_console_ticket(self, vmid: int, node: str) -> ConsoleTicket:
        """Create a short-lived PVE noVNC ticket for a VM."""

        def _do() -> ConsoleTicket:
            data = self._get_client().nodes(node).qemu(vmid).vncproxy.post(
                websocket=1
            )
            return ConsoleTicket(
                vmid=vmid,
                node=node,
                ticket=str(data.get("ticket") or ""),
                port=int(data["port"]) if data.get("port") is not None else None,
                cert=data.get("cert"),
                user=data.get("user"),
                launch_url=(
                    f"https://{self._host}:{self._port}/"
                    f"?console=kvm&novnc=1&vmid={vmid}&node={node}&resize=scale"
                ),
            )

        return await self._call(_do)

    # --- F3 multi-VM networks -----------------------------------------


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
                raise ProxmoxAPIError(
                    "create_bridge requires a configured target node"
                )
            networks = client.nodes(node_name).network.get()
            matching = [
                n for n in networks
                if n.get("iface") == spec.bridge
                and (n.get("type") or "").lower() == "bridge"
            ]
            active = [
                n for n in matching
                if str(n.get("active")) == "1"
            ]
            if not active:
                inactive_hint = (
                    " exists in PVE config but is not active"
                    if matching
                    else " is not configured"
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
                log.warning(
                    "pve_runner.remove_bridge.failed",
                    bridge=bridge,
                    error=str(exc),
                )

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
            if existing and f"bridge={bridge}" in existing and (
                (vlan_id is None or f"tag={vlan_id}" in existing)
                and (not trunk_value or f"trunks={trunk_value}" in existing)
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
                client.nodes(node).qemu(vmid).config.post(**{net_name: f"{nic_option},bridge={bridge}{tag}{trunk_option}"})
                return
            client.nodes(node).qemu(vmid).config.post(
                **{net_name: f"virtio,bridge={bridge}{tag}{trunk_option}"}
            )

        await self._call(_do)
