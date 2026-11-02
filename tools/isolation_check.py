#!/usr/bin/env python3
"""Check that range VMs cannot reach things they must not reach.

For each selected running VM it asks the QEMU guest agent to try a TCP connection
to every "must block" target (by default the Proxmox web UI and SSH) and reports
PASS when the connection is refused or times out, FAIL when it opens. A FAIL means
a red-team VM can reach the hypervisor, i.e. the range is not isolated.

Run it while a range is up (after "Prepare range", or with `range_dry_run.py --keep`):

    export DIVIDE_ADMIN_PASSWORD=...  PROXMOX_TOKEN_ID='user@pam!name'  PROXMOX_TOKEN_SECRET=...
    python tools/isolation_check.py --pve-host 192.168.1.10
    python tools/isolation_check.py --pve-host 192.168.1.10 --from 'kali|red' \
        --block 192.168.1.10:8006 --block 192.168.1.1:80 --block 192.168.1.20:5432

Linux guests need bash; Windows guests use PowerShell. A VM that cannot be tested
(guest agent not running) is reported as FAIL: "not tested" must not read as "isolated".
Exit code 0 only when every VM x target pair is blocked.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from dataclasses import dataclass

DEFAULT_API_BASE = os.environ.get("DIVIDE_API_BASE", "http://localhost:8000")
OPEN, CLOSED = "OPEN", "CLOSED"


@dataclass
class Guest:
    vmid: int
    node: str
    name: str


@dataclass
class Finding:
    guest: str
    target: str
    verdict: str  # "blocked" | "REACHABLE" | "untested"
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.verdict == "blocked"


def probe_command(is_windows: bool, host: str, port: int, timeout_s: int = 4) -> list[str]:
    """argv that prints OPEN or CLOSED for a TCP connect, never raising."""
    if is_windows:
        script = (
            "try { $c = New-Object Net.Sockets.TcpClient; "
            f"$r = $c.BeginConnect('{host}', {port}, $null, $null); "
            f"if ($r.AsyncWaitHandle.WaitOne({timeout_s * 1000}) -and $c.Connected) "
            "{ 'OPEN' } else { 'CLOSED' } } catch { 'CLOSED' }"
        )
        return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]
    script = f"timeout {timeout_s} bash -c '</dev/tcp/{host}/{port}' >/dev/null 2>&1 && echo OPEN || echo CLOSED"
    return ["bash", "-c", script]


class GuestExec:
    """Runs a command in a guest through the QEMU guest agent."""

    def is_windows(self, guest: Guest) -> bool:  # pragma: no cover - interface
        raise NotImplementedError

    def run(self, guest: Guest, argv: list[str]) -> str:  # pragma: no cover - interface
        raise NotImplementedError


class PveGuestExec(GuestExec):
    def __init__(self, host: str, token_id: str, token_secret: str, verify_ssl: bool, poll_s=0.5):
        from proxmoxer import ProxmoxAPI  # imported late: only this path needs it

        user, _, token_name = token_id.partition("!")
        self._api = ProxmoxAPI(
            host, user=user, token_name=token_name, token_value=token_secret, verify_ssl=verify_ssl
        )
        self._poll_s = poll_s

    def is_windows(self, guest: Guest) -> bool:
        info = self._api.nodes(guest.node).qemu(guest.vmid).agent("get-osinfo").get()
        result = info.get("result", info) if isinstance(info, dict) else {}
        return "mswindows" in str(result.get("id", "")).lower()

    def run(self, guest: Guest, argv: list[str]) -> str:
        agent = self._api.nodes(guest.node).qemu(guest.vmid).agent
        pid = agent("exec").post(command=argv)["pid"]
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            status = agent("exec-status").get(pid=pid)
            if status.get("exited"):
                return str(status.get("out-data") or "")
            time.sleep(self._poll_s)
        raise TimeoutError("guest command did not finish")


def parse_target(value: str) -> tuple[str, int]:
    host, sep, port = value.rpartition(":")
    if not sep or not host or not port.isdigit():
        raise argparse.ArgumentTypeError(f"expected HOST:PORT, got {value!r}")
    return host, int(port)


def check_isolation(
    guests: list[Guest], targets: list[tuple[str, int]], executor: GuestExec
) -> list[Finding]:
    findings: list[Finding] = []
    for guest in guests:
        try:
            windows = executor.is_windows(guest)
        except Exception as exc:  # noqa: BLE001 - any failure means "could not test"
            for host, port in targets:
                findings.append(
                    Finding(guest.name, f"{host}:{port}", "untested", f"guest agent: {exc}")
                )
            continue
        for host, port in targets:
            label = f"{host}:{port}"
            try:
                out = executor.run(guest, probe_command(windows, host, port))
            except Exception as exc:  # noqa: BLE001
                findings.append(Finding(guest.name, label, "untested", str(exc)))
                continue
            verdict = out.strip().splitlines()[-1].strip() if out.strip() else ""
            if verdict == CLOSED:
                findings.append(Finding(guest.name, label, "blocked"))
            elif verdict == OPEN:
                findings.append(Finding(guest.name, label, "REACHABLE", "connection succeeded"))
            else:
                findings.append(Finding(guest.name, label, "untested", f"unexpected: {out[:60]!r}"))
    return findings


def select_guests(items: list[dict], pattern: str) -> list[Guest]:
    regex = re.compile(pattern, re.IGNORECASE)
    return [
        Guest(int(row["vmid"]), str(row["node"]), str(row.get("name") or row["vmid"]))
        for row in items
        if row.get("status") == "running"
        and row.get("type", "qemu") == "qemu"
        and regex.search(str(row.get("name") or ""))
    ]


def print_report(findings: list[Finding]) -> bool:
    for f in findings:
        mark = "PASS" if f.ok else "FAIL"
        extra = f"  ({f.detail})" if f.detail else ""
        print(f"  [{mark}] {f.guest} -> {f.target}: {f.verdict}{extra}")
    ok = bool(findings) and all(f.ok for f in findings)
    print("\nRESULT:", "ISOLATED" if ok else "NOT ISOLATED OR NOT FULLY TESTED")
    return ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--api", default=DEFAULT_API_BASE)
    parser.add_argument(
        "--pve-host", required=True, help="Proxmox host/IP (also the default targets)"
    )
    parser.add_argument("--from", dest="pattern", default=r"red|kali|attack", help="VM name regex")
    parser.add_argument("--block", action="append", type=parse_target, help="HOST:PORT to test")
    parser.add_argument("--insecure", action="store_true", help="skip TLS verification to PVE")
    args = parser.parse_args(argv)

    import httpx

    token_id = os.environ.get("PROXMOX_TOKEN_ID")
    secret = os.environ.get("PROXMOX_TOKEN_SECRET")
    password = os.environ.get("DIVIDE_ADMIN_PASSWORD")
    if not (token_id and secret and password):
        sys.exit("Set PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET and DIVIDE_ADMIN_PASSWORD.")

    targets = args.block or [(args.pve_host, 8006), (args.pve_host, 22)]
    with httpx.Client(base_url=args.api, timeout=60) as client:
        login = client.post(
            "/api/v1/auth/login",
            json={"sub": os.environ.get("DIVIDE_ADMIN_SUB", "admin"), "password": password},
        )
        login.raise_for_status()
        client.headers["X-Divide-Token"] = login.json()["token"]
        inventory = client.get("/api/v1/admin/pve-guests", params={"drill_only": "true"})
        inventory.raise_for_status()
        guests = select_guests(inventory.json().get("items", []), args.pattern)

    if not guests:
        print(f"No running range VM matches /{args.pattern}/. Is a range prepared?")
        return 1
    print(f"Testing {len(guests)} VM(s) against {len(targets)} target(s)")
    executor = PveGuestExec(args.pve_host, token_id, secret, verify_ssl=not args.insecure)
    return 0 if print_report(check_isolation(guests, targets, executor)) else 1


if __name__ == "__main__":
    sys.exit(main())
