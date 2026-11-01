"""Regression coverage for Windows DC NIC readiness during scenario seeding."""

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SCENARIO = ROOT / "examples" / "scenarios" / "enterprise-file-breach.scenario.yaml"


def test_dc01_waits_for_an_ipv4_interface_before_configuring_static_ip() -> None:
    data = yaml.safe_load(SCENARIO.read_text(encoding="utf-8"))
    dc01 = next(asset for asset in data["spec"]["assets"] if asset["role"] == "dc01")
    phase = next(
        phase for phase in dc01["windows_setup"]["phases"] if phase["name"] == "configure-dc01"
    )
    commands = phase["commands"]
    device_scan = next(
        i for i, command in enumerate(commands) if "pnputil.exe /scan-devices" in command
    )
    adapter_enable = next(i for i, command in enumerate(commands) if "Enable-NetAdapter" in command)
    nic_wait = next(i for i, command in enumerate(commands) if "for ($attempt" in command)
    nic_guard = next(
        i for i, command in enumerate(commands) if "No usable IPv4 interface" in command
    )
    index_assignment = next(
        i
        for i, command in enumerate(commands)
        if "$ifIndex = [int]$nicAddress.InterfaceIndex" in command
    )
    ip_config = next(
        i for i, command in enumerate(commands) if "$current = Get-NetIPAddress" in command
    )

    assert device_scan < adapter_enable < nic_wait < nic_guard < index_assignment < ip_config
    assert "$nicAddress = $null" in commands
    assert "Get-NetIPAddress -AddressFamily IPv4" in commands[nic_wait]
    assert "$_.InterfaceIndex -gt 1" in commands[nic_wait]
    assert "-lt 60" in commands[nic_wait]
    adapter_query = next(command for command in commands if "$adapters = @(" in command)
    assert "-IncludeHidden" in adapter_query
    assert "adapters=" in commands[nic_guard]
    assert "PnP=" in commands[nic_guard]
