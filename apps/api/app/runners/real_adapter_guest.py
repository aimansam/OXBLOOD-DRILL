"""Guest-agent seeding, Windows OOBE/role checks and reboots for the real PVE adapter."""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Any

from app.runners.adapter import (
    SeedSpec,
)
from app.runners.real_adapter_core import _AdapterCore, _guest_error
from app.services.proxmox import ProxmoxAPIError

log = logging.getLogger("app.runners.real_adapter")


class GuestSeedMixin(_AdapterCore):
    """Guest-agent seeding, Windows OOBE/role checks and reboots for the real PVE adapter."""

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
            return self._get_client().nodes(node).qemu(vmid).agent("exec").post(command=query)

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

            query_deadline = min(deadline, asyncio.get_running_loop().time() + 30)
            while True:

                def _status() -> Any:
                    return (
                        self._get_client().nodes(node).qemu(vmid).agent("exec-status").get(pid=pid)
                    )

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
                            "cmd.exe",
                            "/c",
                            'reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE" /v SkipMachineOOBE /t REG_DWORD /d 1 /f '
                            '&& reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE" /v SkipUserOOBE /t REG_DWORD /d 1 /f',
                        ]
                        try:
                            await self._call(
                                lambda: (
                                    self._get_client()
                                    .nodes(node)
                                    .qemu(vmid)
                                    .agent("exec")
                                    .post(command=bypass)
                                )
                            )
                            await self._reboot_guest_and_wait(vmid, node)
                            continue
                        except ProxmoxAPIError as exc:
                            log.warning(
                                "pve_runner.windows_oobe_bypass_failed vmid=%s err=%s",
                                vmid,
                                exc,
                            )
                    log.info(
                        "pve_runner.waiting_windows_oobe vmid=%s output=%s",
                        vmid,
                        output[-200:] or "unknown",
                    )
                    break
                if asyncio.get_running_loop().time() >= query_deadline:
                    break
                await asyncio.sleep(1)

            if asyncio.get_running_loop().time() >= deadline:
                raise ProxmoxAPIError(f"Windows OOBE did not complete for VM {vmid}")
            await asyncio.sleep(5)

    async def apply_guest_seed(  # type: ignore[override]  # adds phase kwargs, returns reboot flag
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
                    vmid,
                    phase_name,
                    phase_timeout,
                    bool(phase.get("reboot")),
                )
                phase_seed = SeedSpec(
                    role=seed.role,
                    windows_commands=list(phase.get("commands") or []),
                )
                reboot_handled = await self.apply_guest_seed(
                    vmid,
                    node,
                    phase_seed,
                    phase_name=phase_name,
                    timeout_seconds=phase_timeout,
                    reboot_expected=bool(phase.get("reboot")),
                )
                if phase.get("reboot") and not reboot_handled:
                    await self._reboot_guest_and_wait(vmid, node)
                log.info(
                    "pve_runner.windows_phase_complete vmid=%s phase=%s",
                    vmid,
                    phase_name,
                )
            return False

        if not files and not commands and not windows_commands:
            return False

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
            input_data: str | None = "\n".join(windows_commands)
            assert input_data is not None
            encoded_script = base64.b64encode(input_data.encode("utf-16le")).decode("ascii")
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
                        'mkdir -p "$(dirname "$p")"',
                        f'printf %s {encoded} | base64 -d > "$p"',
                        'chown root:root "$p"',
                        'chmod 0600 "$p"',
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
                return self._get_client().nodes(node).qemu(vmid).agent("exec-status").get(pid=pid)

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
                'if ($ips -notcontains $expectedIp) { throw "expected IP $expectedIp not present" }',
                "$computer = Get-CimInstance Win32_ComputerSystem",
                'if (-not $computer.PartOfDomain -or $computer.Domain -ne $expectedDomain) { throw "domain is $($computer.Domain), expected $expectedDomain" }',
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
            return self._get_client().nodes(node).qemu(vmid).agent("exec").post(command=command)

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
                lambda: self._get_client().nodes(node).qemu(vmid).agent("exec-status").get(pid=pid)
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
                return (
                    self._get_client()
                    .nodes(node)
                    .qemu(vmid)
                    .agent("exec")
                    .post(command=["cmd.exe", "/c", "exit", "0"])
                )

            try:
                result = await self._call(_probe)
                probe_pid = result.get("pid") if isinstance(result, dict) else None
                if probe_pid is not None:
                    probe_deadline = asyncio.get_running_loop().time() + 30
                    while asyncio.get_running_loop().time() < probe_deadline:
                        probe_status = await self._call(
                            lambda: (
                                self._get_client()
                                .nodes(node)
                                .qemu(vmid)
                                .agent("exec-status")
                                .get(pid=probe_pid)
                            )
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
