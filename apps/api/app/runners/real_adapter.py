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
import logging
import re
from collections.abc import Callable
from typing import Any

from proxmoxer import ProxmoxAPI

from app.core.config import ProxmoxSettings
from app.runners.adapter import (
    ClonedVM,
    CloneSpec,
    ConsoleTicket,
    VmState,
)
from app.runners.real_adapter_core import _is_missing_vm_error
from app.runners.real_adapter_guest import GuestSeedMixin
from app.runners.real_adapter_network import NetworkMixin
from app.runners.real_adapter_preflight import PreflightMixin
from app.services.proxmox import ProxmoxAPIError, ProxmoxNotConfiguredError

log = logging.getLogger(__name__)


class RealProxmoxAdapter(GuestSeedMixin, NetworkMixin, PreflightMixin):
    """Adapter that talks to a real Proxmox VE host via proxmoxer.

    Construct either via `RealProxmoxAdapter.from_settings(p)` (preferred,
    pulls all auth + network config from the app's `ProxmoxSettings`) or
    directly with `(host, port, user, token_id, token_secret, verify_ssl)`
    — useful for tests and one-off scripts.
    """

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
        token_secret = token_secret_raw.get_secret_value() if token_secret_raw is not None else None
        if not token_id or not token_secret:
            raise ProxmoxNotConfiguredError("PROXMOX_TOKEN_ID and PROXMOX_TOKEN_SECRET must be set")
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

    # --- inventory -------------------------------------------------------

    async def list_nodes(self) -> list[str]:
        def _do() -> list[str]:
            return [n["node"] for n in self._get_client().nodes.get()]

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
            spec.source_vmid,
            spec.new_vmid,
            node,
            spec.name,
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
            return self._get_client().nodes(node).qemu(spec.source_vmid).clone.post(**clone_params)

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
            clone_params.update(
                {
                    "name": spec.name,
                    "newid": new_vmid,
                    "full": 1,
                    "storage": self._clone_storage,
                }
            )
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
                self._get_client().nodes(node).qemu(new_vmid).config.post(delete="ide2")

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
            log.info(
                "pve_runner.applying_config_overrides vmid=%s overrides=%s",
                new_vmid,
                config_overrides,
            )

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
                    return (
                        self._get_client()
                        .nodes(node)
                        .qemu(new_vmid)
                        .resize.put(
                            disk=resize_disk,
                            size=f"+{additional_gb}G",
                        )
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
                    raise ProxmoxAPIError(f"PVE {description} failed: {exitstatus}")
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

    async def ensure_vm_running(self, name: str, node: str, timeout_s: float = 90.0) -> VmState:
        """Keep permanent infrastructure online before a drill starts."""
        state = await self.find_vm(name)
        if state is None:
            raise ProxmoxAPIError(f"permanent infrastructure VM {name!r} was not found on PVE")
        if state.node != node:
            raise ProxmoxAPIError(
                f"permanent infrastructure VM {name!r} is on node {state.node!r}, "
                f"but this drill targets node {node!r}"
            )

        if state.status != "running":
            log.warning(
                "pve_runner.infrastructure_start name=%s vmid=%s node=%s status=%s",
                name,
                state.vmid,
                state.node,
                state.status,
            )
            await self.start_vm(state.vmid, state.node)

        deadline = asyncio.get_running_loop().time() + timeout_s
        last_state = state
        while asyncio.get_running_loop().time() < deadline:
            last_state = await self.get_vm_state(state.vmid, state.node)
            if last_state.status == "running":
                log.info(
                    "pve_runner.infrastructure_ready name=%s vmid=%s node=%s",
                    name,
                    state.vmid,
                    state.node,
                )
                return last_state
            await asyncio.sleep(2)

        raise ProxmoxAPIError(
            f"permanent infrastructure VM {name!r} did not become ready "
            f"within {int(timeout_s)}s (status={last_state.status})"
        )

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
            self._get_client().nodes(node).qemu(vmid).status.stop.post(timeout=timeout)

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
                self._get_client().nodes(node).qemu(vmid).delete(purge=1)
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
            return sorted(
                {
                    str(row["name"])
                    for row in rows or []
                    if row.get("name") and row.get("name") != "current"
                }
            )

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
            return (
                self._get_client()
                .nodes(node)
                .qemu(vmid)
                .snapshot.post(
                    snapname=name,
                    description=description[:255],
                    vmstate=0,
                )
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
            return self._get_client().nodes(node).qemu(vmid).snapshot(name).rollback.post(start=0)

        upid = await self._call(_do)
        await self._wait_for_task(node, upid, description=f"restore snapshot for VM {vmid}")

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
            if key.startswith("ide") and isinstance(value, str) and "cloudinit" in value.lower():
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
            key.startswith("ide") and isinstance(value, str) and "cloudinit" in value.lower()
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
                    res = (
                        self._get_client()
                        .nodes(node)
                        .qemu(vmid)
                        .agent("network-get-interfaces")
                        .get()
                    )
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
            data = self._get_client().nodes(node).qemu(vmid).vncproxy.post(websocket=1)
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
