"""Isolation check: verdict logic and probe commands (no Proxmox needed)."""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[1] / "tools" / "isolation_check.py"


@pytest.fixture(scope="module")
def tool():
    spec = importlib.util.spec_from_file_location("isolation_check", TOOL)
    module = importlib.util.module_from_spec(spec)
    sys.modules["isolation_check"] = module
    spec.loader.exec_module(module)
    return module


class FakeExec:
    def __init__(self, outputs, windows=False, agent_down=False):
        self.outputs = outputs  # (host, port) -> output text or Exception
        self.windows = windows
        self.agent_down = agent_down
        self.commands = []

    def is_windows(self, guest):
        if self.agent_down:
            raise RuntimeError("QEMU guest agent is not running")
        return self.windows

    def run(self, guest, argv):
        self.commands.append(argv)
        key = next(
            k for k in self.outputs if f"{k[0]}" in " ".join(argv) and f"{k[1]}" in " ".join(argv)
        )
        value = self.outputs[key]
        if isinstance(value, Exception):
            raise value
        return value


def _guest(tool, name="red-kali"):
    return tool.Guest(101, "pve", name)


def test_blocked_targets_pass(tool):
    ex = FakeExec({("10.0.0.1", 8006): "CLOSED\n", ("10.0.0.1", 22): "CLOSED\n"})
    findings = tool.check_isolation([_guest(tool)], [("10.0.0.1", 8006), ("10.0.0.1", 22)], ex)
    assert all(f.ok for f in findings)
    assert tool.print_report(findings) is True


def test_reachable_target_fails(tool):
    ex = FakeExec({("10.0.0.1", 8006): "OPEN\n", ("10.0.0.1", 22): "CLOSED\n"})
    findings = tool.check_isolation([_guest(tool)], [("10.0.0.1", 8006), ("10.0.0.1", 22)], ex)
    assert [f.verdict for f in findings] == ["REACHABLE", "blocked"]
    assert tool.print_report(findings) is False


def test_untestable_guest_is_not_reported_as_isolated(tool):
    ex = FakeExec({}, agent_down=True)
    findings = tool.check_isolation([_guest(tool)], [("10.0.0.1", 8006)], ex)
    assert findings[0].verdict == "untested"
    assert tool.print_report(findings) is False


def test_unexpected_output_is_untested(tool):
    ex = FakeExec({("10.0.0.1", 8006): "bash: timeout: command not found"})
    findings = tool.check_isolation([_guest(tool)], [("10.0.0.1", 8006)], ex)
    assert findings[0].verdict == "untested"


def test_no_findings_is_not_a_pass(tool):
    assert tool.print_report([]) is False


def test_probe_commands_per_os(tool):
    linux = tool.probe_command(False, "10.0.0.1", 8006)
    assert linux[0] == "bash" and "/dev/tcp/10.0.0.1/8006" in linux[2]
    windows = tool.probe_command(True, "10.0.0.1", 8006)
    assert windows[0] == "powershell.exe" and "10.0.0.1" in windows[-1] and "8006" in windows[-1]


def test_windows_guest_gets_powershell_probe(tool):
    ex = FakeExec({("10.0.0.1", 8006): "CLOSED"}, windows=True)
    tool.check_isolation([_guest(tool, "red-win")], [("10.0.0.1", 8006)], ex)
    assert ex.commands[0][0] == "powershell.exe"


def test_select_guests_filters_by_name_state_and_type(tool):
    items = [
        {"vmid": 1, "node": "pve", "name": "red-kali", "status": "running", "type": "qemu"},
        {"vmid": 2, "node": "pve", "name": "red-kali-old", "status": "stopped", "type": "qemu"},
        {"vmid": 3, "node": "pve", "name": "dc01", "status": "running", "type": "qemu"},
        {"vmid": 4, "node": "pve", "name": "red-ct", "status": "running", "type": "lxc"},
    ]
    assert [g.vmid for g in tool.select_guests(items, "red|kali")] == [1]


def test_parse_target(tool):
    assert tool.parse_target("10.0.0.1:8006") == ("10.0.0.1", 8006)
    with pytest.raises(argparse.ArgumentTypeError):
        tool.parse_target("no-port")
