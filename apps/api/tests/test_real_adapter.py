"""RealProxmoxAdapter tests, all against mocked proxmoxer — no live PVE.

We mock `proxmoxer.ProxmoxAPI` at the module boundary and assert:
  * The right endpoint is hit with the right path/args.
  * PVE JSON responses are mapped to our dataclasses correctly.
  * Errors from proxmoxer surface as `ProxmoxAPIError`.
  * `destroy_vm` is idempotent on missing VMs (404 -> no-op).
  * `_call` enforces a per-call timeout.

Why mock proxmoxer rather than spin up a stub server:
  - proxmoxer's surface is large; we don't want a hand-rolled HTTP server.
  - These tests run offline and fast.
  - The real adapter's behaviour is mostly "build URL, pass kwargs, map
    response", all of which is checkable via mocks.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import MagicMock, call, patch

import pytest
from app.core.config import ProxmoxSettings
from app.runners.adapter import CloneSpec, SeedSpec
from app.runners.mock_adapter import MockProxmoxAdapter
from app.runners.real_adapter import RealProxmoxAdapter
from app.services.proxmox import ProxmoxAPIError, ProxmoxNotConfiguredError

# --- construction ----------------------------------------------------------


def test_constructor_rejects_empty_host():
    with pytest.raises(ProxmoxNotConfiguredError):
        RealProxmoxAdapter(
            host="", port=8006, user="divide@pve",
            token_id="divide@pve!t", token_secret="x",
        )


def test_constructor_rejects_missing_token():
    with pytest.raises(ProxmoxNotConfiguredError):
        RealProxmoxAdapter(
            host="pve.example", port=8006, user="divide@pve",
            token_id="", token_secret="x",
        )


def test_constructor_strips_scheme_from_host():
    a = RealProxmoxAdapter(
        host="https://pve.example/", port=8006, user="divide@pve",
        token_id="divide@pve!t", token_secret="x", verify_ssl=False,
    )
    assert a._host == "pve.example"


def test_from_settings_missing_host():
    p = ProxmoxSettings(host=None)
    with pytest.raises(ProxmoxNotConfiguredError):
        RealProxmoxAdapter.from_settings(p)


def test_from_settings_missing_secret():
    p = ProxmoxSettings(host="pve", token_id="divide@pve!t", token_secret=None)
    with pytest.raises(ProxmoxNotConfiguredError):
        RealProxmoxAdapter.from_settings(p)


def test_from_settings_happy_path():
    p = ProxmoxSettings(
        host="pve.example", port=8006, user="divide@pve",
        token_id="divide@pve!drill", token_secret="s3cret", verify_ssl=False,
    )
    a = RealProxmoxAdapter.from_settings(p)
    assert a._host == "pve.example"
    assert a._token_name == "drill"
    assert a._token_secret == "s3cret"
    assert a._verify_ssl is False


def test_token_id_split_handles_missing_exclaim():
    """If PROXMOX_TOKEN_ID has no '!', treat the whole string as token_name."""
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="plain-token-name", token_secret="x",
    )
    assert a._token_name == "plain-token-name"


def test_constructor_accepts_clone_storage_and_node():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
        node="pve2", clone_storage="fast-zfs",
    )
    assert a._node == "pve2"
    assert a._clone_storage == "fast-zfs"


# --- helpers ---------------------------------------------------------------


def _build_mock_client() -> MagicMock:
    """Build a MagicMock that mimics proxmoxer.ProxmoxAPI chained access.

    The chain we use:
      client.nodes.get()
      client.cluster.resources.get(type=...)
      client.cluster.nextid.post()
      client.nodes(node).qemu(vmid).clone.post(**params)
      client.nodes(node).qemu(vmid).status.start.post()
      client.nodes(node).qemu(vmid).status.stop.post(**kwargs)
      client.nodes(node).qemu(vmid).delete(purge=1)
      client.nodes(node).qemu(vmid).status.current.get()
      client.nodes(node).qemu(vmid).config.get()
    """
    client = MagicMock()
    return client


def _install_client(a: RealProxmoxAdapter, client: MagicMock) -> None:
    a._client = client  # bypass _get_client so we can inject the mock.


@pytest.mark.parametrize("failure", [None, "memory", "storage", "network", "template", "locked", "unknown-disk"])
def test_preflight_checks_capacity_without_mutations(failure):
    from app.core.config import settings
    a = RealProxmoxAdapter(host="pve", port=8006, user="u", token_id="u!t", token_secret="x")
    client = _build_mock_client()
    _install_client(a, client)
    gib = 1024 ** 3
    client.cluster.resources.get.return_value = [
        {"template": 1, "name": "dc", "node": "pve", "vmid": 9000, "maxdisk": 0 if failure == "unknown-disk" else 60 * gib},
        {"template": 0, "name": "existing", "node": "pve", "status": "running", "maxmem": 8 * gib},
    ]
    client.nodes().qemu().config.get.return_value = {"memory": 8192, "scsi0": "local:disk,size=60G", "lock": "clone" if failure == "locked" else None}
    client.nodes().status.get.return_value = {"memory": {"total": (12 if failure == "memory" else 32) * gib, "used": 2 * gib}}
    client.nodes().storage().status.get.return_value = {"active": 1, "avail": (10 if failure == "storage" else 100) * gib}
    client.nodes().network.get.return_value = [{"iface": "vmbr200", "active": 1, "bridge_vlan_aware": 0 if failure == "network" else 1}]
    spec = {"assets": [{"role": "dc01", "template": "missing" if failure == "template" else "dc", "resources": {"ram_mb": 8192}}],
            "networks": [{"name": "identity", "vlan_id": 234}]}
    result = asyncio.run(a.preflight(spec, "pve"))
    assert all(check["ready"] for check in result) == (failure is None)
    if failure is None:
        memory = next(check for check in result if check["id"] == "memory")
        assert memory["required_bytes"] == 8 * gib
        assert memory["available_bytes"] == 24 * gib - settings.range_host_reserve_mb * 1024**2
    assert not any(str(call).split("(")[0].endswith((".post", ".put", ".delete")) for call in client.mock_calls)


def test_preflight_uses_actual_host_usage_for_lxc_limits():
    from app.core.config import settings

    a = RealProxmoxAdapter(host="pve", port=8006, user="u", token_id="u!t", token_secret="x")
    client = _build_mock_client()
    _install_client(a, client)
    gib = 1024 ** 3
    client.cluster.resources.get.return_value = [
        {"template": 1, "name": "dc", "node": "pve", "vmid": 9000, "maxdisk": 60 * gib},
        {"type": "lxc", "template": 0, "name": "app-host", "node": "pve", "status": "running", "maxmem": 28 * gib},
    ]
    client.nodes().qemu().config.get.return_value = {"memory": 8192, "scsi0": "local:disk,size=60G"}
    client.nodes().status.get.return_value = {"memory": {"total": 32 * gib, "used": 10 * gib}}
    client.nodes().storage().status.get.return_value = {"active": 1, "avail": 100 * gib}

    checks = asyncio.run(a.preflight({"assets": [{"role": "dc01", "template": "dc", "resources": {"ram_mb": 8192}}]}, "pve"))

    memory = next(check for check in checks if check["id"] == "memory")
    assert memory["available_bytes"] == 22 * gib - settings.range_host_reserve_mb * 1024**2
    assert memory["ready"]


def test_preflight_linked_clone_reserves_writable_delta_on_source_storage():
    a = RealProxmoxAdapter(host="pve", port=8006, user="u", token_id="u!t", token_secret="x")
    client = _build_mock_client()
    _install_client(a, client)
    gib = 1024 ** 3
    client.cluster.resources.get.return_value = [
        {"template": 1, "name": "dc", "node": "pve", "vmid": 9000, "maxdisk": 60 * gib},
    ]
    client.nodes().qemu().config.get.return_value = {
        "memory": 8192, "scsi0": "local-lvm:base-9000-disk-0,size=60G"
    }
    client.nodes().status.get.return_value = {"memory": {"total": 32 * gib, "used": 2 * gib}}
    client.nodes().storage("local-lvm").status.get.return_value = {"active": 1, "avail": 2 * gib}

    checks = asyncio.run(a.preflight({
        "provisioning": {"mode": "linked_clone", "linked_clone_reserve_mb": 1024},
        "assets": [{"role": "dc01", "template": "dc", "count": 2, "resources": {"ram_mb": 8192}}],
    }, "pve"))

    storage = next(check for check in checks if check["id"] == "storage:local-lvm")
    assert storage["required_bytes"] == 2 * gib
    assert storage["ready"]
    assert "Linked clones reserve 2.0 GiB" in storage["detail"]


# --- list_nodes ------------------------------------------------------------


def test_list_nodes():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes.get.return_value = [
        {"node": "pve", "status": "online"},
        {"node": "pve2", "status": "online"},
    ]
    _install_client(a, client)

    result = asyncio.run(a.list_nodes())

    assert result == ["pve", "pve2"]
    client.nodes.get.assert_called_once_with()


# --- find_template ---------------------------------------------------------


def test_find_template_hit():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.cluster.resources.get.return_value = [
        {"template": 1, "name": "tpl-ubuntu", "vmid": 9001},
        {"template": 0, "name": "running-vm", "vmid": 100},
    ]
    _install_client(a, client)

    assert asyncio.run(a.find_template("tpl-ubuntu")) == 9001


def test_find_template_miss():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.cluster.resources.get.return_value = [
        {"template": 1, "name": "tpl-ubuntu", "vmid": 9001},
    ]
    _install_client(a, client)

    assert asyncio.run(a.find_template("tpl-kali")) is None


def test_find_template_skips_non_templates():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.cluster.resources.get.return_value = [
        {"template": 0, "name": "match-by-name-but-not-tpl", "vmid": 1234},
    ]
    _install_client(a, client)

    assert asyncio.run(a.find_template("match-by-name-but-not-tpl")) is None


# --- allocate_vmid ---------------------------------------------------------


def test_allocate_vmid():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.cluster.nextid.get.return_value = "9102"
    _install_client(a, client)

    assert asyncio.run(a.allocate_vmid()) == 9102
    client.cluster.nextid.get.assert_called_once_with()


# --- clone_vm --------------------------------------------------------------


def test_clone_vm_with_explicit_vmid_and_overrides():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)

    spec = CloneSpec(
        source_vmid=9001,
        new_vmid=9100,
        node="pve",
        name="divide-7-attacker",
        cores=4,
        sockets=1,
        ram_mb=4096,
        disk_gb=20,
    )
    result = asyncio.run(a.clone_vm(spec))

    clone_post = client.nodes("pve").qemu(9001).clone.post
    # PVE 9 split clone + resource overrides: clone.post only takes
    # clone-time params (name, newid). cores/sockets/memory go via
    # config.post on the new VMID; disk resize goes via resize.put
    # (PVE 9 rejects ``disk`` on config.post).
    clone_post.assert_called_once_with(
        name="divide-7-attacker",
        newid=9100,
        full=1,
        storage="local-lvm",
    )
    config_post = client.nodes("pve").qemu(9100).config.post
    config_post.assert_any_call(
        cores=4,
        sockets=1,
        memory=4096,
    )
    resize_put = client.nodes("pve").qemu(9100).resize.put
    resize_put.assert_called_once_with(disk="scsi0", size="+20G")
    assert result.vmid == 9100
    assert result.node == "pve"
    assert result.name == "divide-7-attacker"


def test_clone_vm_without_newid_allocates_via_nextid():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.cluster.nextid.get.return_value = "9123"
    _install_client(a, client)

    spec = CloneSpec(
        source_vmid=9001, new_vmid=None, node="pve", name="x",
    )
    result = asyncio.run(a.clone_vm(spec))

    client.cluster.nextid.get.assert_called_once()
    assert result.vmid == 9123


def test_clone_vm_uses_configured_clone_storage():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
        clone_storage="fast-zfs",
    )
    client = _build_mock_client()
    _install_client(a, client)

    asyncio.run(
        a.clone_vm(
            CloneSpec(
                source_vmid=9001,
                new_vmid=9100,
                node="pve",
                name="divide-7-attacker",
            )
        )
    )

    client.nodes("pve").qemu(9001).clone.post.assert_called_once_with(
        name="divide-7-attacker",
        newid=9100,
        full=1,
        storage="fast-zfs",
    )


def test_clone_vm_linked_uses_template_storage():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x", clone_storage="SSD-Backups",
    )
    client = _build_mock_client()
    _install_client(a, client)

    asyncio.run(
        a.clone_vm(
            CloneSpec(
                source_vmid=9001,
                new_vmid=9100,
                node="pve",
                name="divide-7-attacker",
                full_clone=False,
            )
        )
    )

    client.nodes("pve").qemu(9001).clone.post.assert_called_once_with(
        name="divide-7-attacker",
        newid=9100,
        full=0,
    )


def test_clone_vm_retries_unsupported_linked_template_as_full_clone():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x", clone_storage="SSD-Backups",
    )
    client = _build_mock_client()
    clone_post = client.nodes("pve").qemu(9001).clone.post
    clone_post.side_effect = [
        RuntimeError("500 Internal Server Error: Linked clone feature is not supported"),
        MagicMock(),
    ]
    _install_client(a, client)

    asyncio.run(
        a.clone_vm(
            CloneSpec(
                source_vmid=9001,
                new_vmid=9100,
                node="pve",
                name="divide-7-router",
                full_clone=False,
            )
        )
    )

    assert clone_post.call_args_list == [
        call(name="divide-7-router", newid=9100, full=0),
        call(name="divide-7-router", newid=9100, full=1, storage="SSD-Backups"),
    ]


def test_clone_vm_resizes_detected_primary_disk_for_windows_template():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    client.nodes("pve").qemu(9100).config.get.return_value = {
        "sata0": "local-lvm:vm-9100-disk-0,size=64G",
        "boot": "order=sata0",
    }

    asyncio.run(
        a.clone_vm(
            CloneSpec(
                source_vmid=9001,
                new_vmid=9100,
                node="pve",
                name="divide-7-victim",
                template_name="tpl-win11-enterprise",
                disk_gb=20,
            )
        )
    )

    client.nodes("pve").qemu(9100).resize.put.assert_called_once_with(
        disk="sata0",
        size="+20G",
    )
    # Windows templates keep their original boot order and do not get the
    # Linux cloud-init cleanup/boot override.
    client.nodes("pve").qemu(9100).config.post.assert_not_called()


def test_clone_vm_missing_node_raises():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    spec = CloneSpec(source_vmid=9001, new_vmid=9100, node="", name="x")
    with pytest.raises(ProxmoxAPIError):
        asyncio.run(a.clone_vm(spec))


def test_clone_vm_missing_source_vmid_raises():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    spec = CloneSpec(source_vmid=None, new_vmid=9100, node="pve", name="x")  # type: ignore[arg-type]
    with pytest.raises(ProxmoxAPIError):
        asyncio.run(a.clone_vm(spec))


# --- start / stop ----------------------------------------------------------


def test_start_vm_calls_correct_endpoint():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    
    # Mock the status check to return running
    client.nodes("pve").qemu(9100).status.current.get.return_value = {
        "status": "running",
        "qmpstatus": "running",
    }

    asyncio.run(a.start_vm(9100, "pve"))

    client.nodes("pve").qemu(9100).status.start.post.assert_called_once_with()
    assert client.nodes("pve").qemu(9100).status.current.get.call_count == 2


def test_seed_vm_applies_cloud_init_credentials():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)

    asyncio.run(
        a.seed_vm(
            9100,
            "pve",
            SeedSpec(
                role="red_workstation",
                ciuser="red",
                cipassword="red-team",
                files={"/opt/divide/role.txt": "red_workstation\n"},
                runcmd=["mkdir -p /opt/divide"],
            ),
        )
    )

    client.nodes("pve").qemu(9100).config.post.assert_called_once()
    client.nodes("pve").storage("local").upload.post.assert_called_once()
    kwargs = client.nodes("pve").qemu(9100).config.post.call_args.kwargs
    assert kwargs["ciuser"] == "red"
    assert kwargs["cipassword"] == "red-team"
    assert kwargs["cicustom"] == "user=local:snippets/divide-seed-9100.yaml"
    assert "role=red_workstation" in kwargs["description"]
    assert "snippet=uploaded" in kwargs["description"]


def test_seed_vm_continues_when_snippet_upload_is_not_supported():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    client.nodes("pve").storage("local").upload.post.side_effect = ProxmoxAPIError(
        "ResourceException: 400 Bad Request: Parameter verification failed. - "
        "{'content': \"value 'snippets' does not have a value in the enumeration "
        "'iso, vztmpl, import'\"}"
    )

    asyncio.run(
        a.seed_vm(
            9100,
            "pve",
            SeedSpec(
                role="red_workstation",
                ciuser="red",
                cipassword="red-team",
                files={"/opt/divide/role.txt": "red_workstation\n"},
                runcmd=["mkdir -p /opt/divide"],
            ),
        )
    )

    client.nodes("pve").qemu(9100).config.post.assert_called_once()
    kwargs = client.nodes("pve").qemu(9100).config.post.call_args.kwargs
    assert kwargs["ciuser"] == "red"
    assert kwargs["cipassword"] == "red-team"
    assert "cicustom" not in kwargs
    assert "snippet=skipped" in kwargs["description"]
    assert "file seed skipped" in kwargs["description"]


def test_seed_vm_continues_when_config_apply_fails():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    client.nodes("pve").qemu(9100).config.post.side_effect = ProxmoxAPIError(
        "ResourceException: 500 Internal Server Error: got no worker upid - "
        "start worker failed"
    )

    asyncio.run(
        a.seed_vm(
            9100,
            "pve",
            SeedSpec(
                role="router_fw",
                ciuser="router",
                cipassword="router-pass",
                files={"/opt/divide/role.txt": "router_fw\n"},
                runcmd=["mkdir -p /opt/divide"],
            ),
        )
    )

    client.nodes("pve").qemu(9100).config.post.assert_called_once()


def test_start_vm_raises_when_vm_fails_to_start():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    
    # Mock the status check to return stopped (VM failed to start)
    client.nodes("pve").qemu(9100).status.current.get.return_value = {
        "status": "stopped",
        "qmpstatus": "stopped",
    }

    with pytest.raises(Exception) as exc_info:
        asyncio.run(a.start_vm(9100, "pve"))
    
    assert "failed to start" in str(exc_info.value)


def test_fix_cloud_init_storage_moves_drives():
    """Q27: Test that broken local cloud-init drives are deleted and boot order set."""
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    
    # Mock config with cloud-init on local storage
    client.nodes("pve").qemu(108).config.get.return_value = {
        "ide2": "local:108/vm-108-cloudinit.qcow2,media=cdrom,size=4M",
        "scsi0": "local-lvm:vm-108-disk-0,size=20G",
    }
    
    asyncio.run(a._fix_cloud_init_storage(108, "pve"))
    
    # Verify delete and boot order were posted
    client.nodes("pve").qemu(108).config.post.assert_called_once_with(
        boot="order=scsi0",
        delete="ide2",
    )


def test_fix_cloud_init_storage_skips_when_no_cloud_init():
    """Q27: Test that _fix_cloud_init_storage is a no-op when no cloud-init drives exist and boot is scsi0."""
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    
    # Mock config without cloud-init and with boot=order=scsi0
    client.nodes("pve").qemu(108).config.get.return_value = {
        "scsi0": "local-lvm:vm-108-disk-0,size=20G",
        "boot": "order=scsi0",
    }
    
    asyncio.run(a._fix_cloud_init_storage(108, "pve"))
    
    # Verify config.post was NOT called (no changes needed)
    client.nodes("pve").qemu(108).config.post.assert_not_called()


def test_fix_cloud_init_storage_removes_windows_cloudinit_but_preserves_boot():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    client.nodes("pve").qemu(110).config.get.return_value = {
        "boot": "order=scsi0;ide3",
        "scsi0": "local-lvm:vm-110-disk-0,size=60G",
        "ide2": "local:110/vm-110-cloudinit.qcow2,media=cdrom",
    }

    asyncio.run(
        a._fix_cloud_init_storage(
            110,
            "pve",
            template_name="tpl-win11-enterprise",
        )
    )

    client.nodes("pve").qemu(110).config.post.assert_called_once_with(
        delete="ide2",
    )


def test_fix_cloud_init_storage_preserves_valid_linux_cloudinit():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
        clone_storage="SSD-Backups",
    )
    client = _build_mock_client()
    _install_client(a, client)
    client.nodes("pve").qemu(108).config.get.return_value = {
        "ide2": "SSD-Backups:108/vm-108-cloudinit.qcow2,media=cdrom,size=4M",
        "scsi0": "SSD-Backups:108/vm-108-disk-0.qcow2,size=20G",
    }

    asyncio.run(a._fix_cloud_init_storage(108, "pve"))

    client.nodes("pve").qemu(108).config.post.assert_called_once_with(
        boot="order=scsi0",
    )


def test_fix_cloud_init_storage_uses_existing_primary_disk_when_boot_missing():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    client.nodes("pve").qemu(108).config.get.return_value = {
        "sata0": "local-lvm:vm-108-disk-0,size=20G",
    }

    asyncio.run(a._fix_cloud_init_storage(108, "pve"))

    client.nodes("pve").qemu(108).config.post.assert_called_once_with(
        boot="order=sata0",
    )


def test_attach_network_overwrites_template_default_bridge():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    client.nodes("pve").qemu(9100).config.get.return_value = {
        "net0": "virtio=BC:24:11:AA:BB:CC,bridge=vmbr0",
    }

    asyncio.run(a.attach_network(9100, "pve", "vmbr106", 0))

    client.nodes("pve").qemu(9100).config.post.assert_called_once_with(
        net0="virtio,bridge=vmbr106",
    )


def test_attach_network_preserves_e1000_for_windows_template_clone():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    client.nodes("pve").qemu(9100).config.get.return_value = {
        "ostype": "win10",
        "net0": "e1000=BC:24:11:AA:BB:CC,bridge=vmbr0",
    }

    asyncio.run(a.attach_network(9100, "pve", "vmbr106", 0))

    client.nodes("pve").qemu(9100).config.post.assert_called_once_with(
        net0="e1000=BC:24:11:AA:BB:CC,bridge=vmbr106",
    )


def test_attach_network_adds_e1000_for_extra_windows_nic():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    client.nodes("pve").qemu(9100).config.get.return_value = {
        "ostype": "win10",
    }

    asyncio.run(a.attach_network(9100, "pve", "vmbr107", 1))

    client.nodes("pve").qemu(9100).config.post.assert_called_once_with(
        net1="e1000,bridge=vmbr107",
    )


def test_attach_network_skips_when_already_on_desired_bridge():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)
    client.nodes("pve").qemu(9100).config.get.return_value = {
        "net0": "virtio=BC:24:11:AA:BB:CC,bridge=vmbr106",
    }

    asyncio.run(a.attach_network(9100, "pve", "vmbr106", 0))

    client.nodes("pve").qemu(9100).config.post.assert_not_called()


def test_stop_vm_default_no_force():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)

    asyncio.run(a.stop_vm(9100, "pve"))

    client.nodes("pve").qemu(9100).status.stop.post.assert_called_once_with(
        timeout=60
    )


def test_stop_vm_force_uses_zero_timeout():
    """Q17: PVE 9 dropped ``forceStop=1`` -- the documented
    "force" behaviour is now ``timeout=0`` which skips the ACPI
    shutdown and powers off immediately.
    """
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)

    asyncio.run(a.stop_vm(9100, "pve", force=True))

    client.nodes("pve").qemu(9100).status.stop.post.assert_called_once_with(
        timeout=0
    )


# --- destroy_vm (idempotent on 404) ----------------------------------------


def test_destroy_vm_happy_path():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    _install_client(a, client)

    asyncio.run(a.destroy_vm(9100, "pve"))

    client.nodes("pve").qemu(9100).delete.assert_called_once_with(
        purge=1
    )


def test_destroy_vm_is_idempotent_on_404():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes("pve").qemu(9100).delete.side_effect = Exception(
        "404 Not Found: no such VM"
    )
    _install_client(a, client)

    # Should NOT raise — destroy is idempotent.
    asyncio.run(a.destroy_vm(9100, "pve"))


def test_destroy_vm_propagates_other_errors():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes("pve").qemu(9100).delete.side_effect = Exception(
        "500 Internal Server Error"
    )
    _install_client(a, client)

    with pytest.raises(ProxmoxAPIError):
        asyncio.run(a.destroy_vm(9100, "pve"))


# --- snapshot primitives --------------------------------------------------


def test_list_vm_snapshots_excludes_current_marker():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u", token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes("pve").qemu(9100).snapshot.get.return_value = [
        {"name": "current"}, {"name": "range-baseline"}, {"name": "older"},
    ]
    _install_client(a, client)

    assert asyncio.run(a.list_vm_snapshots(9100, "pve")) == ["older", "range-baseline"]


def test_create_vm_snapshot_is_cold_and_requires_stopped_vm():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u", token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes("pve").qemu(9100).status.current.get.return_value = {"status": "stopped"}
    _install_client(a, client)

    asyncio.run(a.create_vm_snapshot(9100, "pve", "range-baseline", "clean range"))

    client.nodes("pve").qemu(9100).snapshot.post.assert_called_once_with(
        snapname="range-baseline", description="clean range", vmstate=0,
    )


def test_create_vm_snapshot_rejects_running_vm_and_invalid_name():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u", token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes("pve").qemu(9100).status.current.get.return_value = {"status": "running"}
    _install_client(a, client)

    with pytest.raises(ProxmoxAPIError, match="stop it first"):
        asyncio.run(a.create_vm_snapshot(9100, "pve", "range-baseline"))
    with pytest.raises(ValueError, match="Snapshot names"):
        asyncio.run(a.create_vm_snapshot(9100, "pve", "bad snapshot name"))
    client.nodes("pve").qemu(9100).snapshot.post.assert_not_called()


def test_restore_vm_snapshot_requires_existing_snapshot_and_leaves_stopped():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u", token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    vm = client.nodes("pve").qemu(9100)
    vm.snapshot.get.return_value = [{"name": "current"}, {"name": "range-baseline"}]
    vm.status.current.get.return_value = {"status": "stopped"}
    _install_client(a, client)

    asyncio.run(a.restore_vm_snapshot(9100, "pve", "range-baseline"))

    vm.snapshot("range-baseline").rollback.post.assert_called_once_with(start=0)


def test_restore_vm_snapshot_refuses_running_vm():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u", token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    vm = client.nodes("pve").qemu(9100)
    vm.snapshot.get.return_value = [{"name": "range-baseline"}]
    vm.status.current.get.return_value = {"status": "running"}
    _install_client(a, client)

    with pytest.raises(ProxmoxAPIError, match="stop it first"):
        asyncio.run(a.restore_vm_snapshot(9100, "pve", "range-baseline"))
    vm.snapshot("range-baseline").rollback.post.assert_not_called()


def test_mock_snapshot_restore_returns_vm_to_stopped_baseline():
    async def exercise():
        adapter = MockProxmoxAdapter(templates={"base": 9000})
        vm = await adapter.clone_vm(
            CloneSpec(source_vmid=9000, new_vmid=9100, node="pve", name="range-dc01")
        )
        await adapter.create_vm_snapshot(vm.vmid, vm.node, "range-baseline")
        await adapter.attach_network(vm.vmid, vm.node, "vmbr200", 0, vlan_id=234)
        await adapter.start_vm(vm.vmid, vm.node)
        await adapter.stop_vm(vm.vmid, vm.node)
        await adapter.restore_vm_snapshot(vm.vmid, vm.node, "range-baseline")
        return adapter, await adapter.get_vm_state(vm.vmid, vm.node)

    adapter, state = asyncio.run(exercise())

    assert state.status == "stopped"
    assert adapter._vms[state.vmid].nics == []
    assert adapter.snapshots_created == [(9100, "pve", "range-baseline")]
    assert adapter.snapshots_restored == [(9100, "pve", "range-baseline")]


# --- get_vm_state ----------------------------------------------------------


def test_get_vm_state_running_with_ip():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes("pve").qemu(9100).status.current.get.return_value = {
        "vmid": 9100, "name": "drill", "status": "running", "ip": "10.0.0.42",
    }
    _install_client(a, client)

    state = asyncio.run(a.get_vm_state(9100, "pve"))
    assert state.vmid == 9100
    assert state.node == "pve"
    assert state.name == "drill"
    assert state.status == "running"
    assert state.ip == "10.0.0.42"


def test_get_vm_state_stopped_falls_back_to_ipconfig0():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes("pve").qemu(9100).status.current.get.return_value = {
        "vmid": 9100, "name": "drill", "status": "stopped",
        # No "ip" field — fall through to ipconfig0.
    }
    client.nodes("pve").qemu(9100).config.get.return_value = {
        "ipconfig0": "ip=10.0.0.50/24,gw=10.0.0.1",
    }
    _install_client(a, client)

    state = asyncio.run(a.get_vm_state(9100, "pve"))
    assert state.status == "stopped"
    assert state.ip == "10.0.0.50"


def test_get_vm_state_dhcp_ipconfig_yields_none_ip():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes("pve").qemu(9100).status.current.get.return_value = {
        "vmid": 9100, "name": "drill", "status": "running",
    }
    client.nodes("pve").qemu(9100).config.get.return_value = {
        "ipconfig0": "ip=dhcp",
    }
    _install_client(a, client)

    state = asyncio.run(a.get_vm_state(9100, "pve"))
    assert state.ip is None


def test_get_vm_state_missing_ipconfig_keeps_ip_none():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes("pve").qemu(9100).status.current.get.return_value = {
        "vmid": 9100, "name": "drill", "status": "stopped",
    }
    client.nodes("pve").qemu(9100).config.get.side_effect = Exception("boom")
    _install_client(a, client)

    state = asyncio.run(a.get_vm_state(9100, "pve"))
    assert state.ip is None
    assert state.status == "stopped"


# --- error wrapping --------------------------------------------------------


def test_proxmoxer_exception_wrapped_as_proxmox_api_error():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes.get.side_effect = Exception("connection refused")
    _install_client(a, client)

    with pytest.raises(ProxmoxAPIError) as exc_info:
        asyncio.run(a.list_nodes())
    assert "connection refused" in str(exc_info.value)


def test_401_unauthorized_is_wrapped():
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes.get.side_effect = Exception("401 Unauthorized")
    _install_client(a, client)

    with pytest.raises(ProxmoxAPIError):
        asyncio.run(a.list_nodes())


def test_403_permission_check_includes_acl_hint():
    """403s should surface with a PVEVMAdmin hint so operators don't debug
    in the dark. This is the failure mode you'll hit if the token only has
    PVEAuditor and you attempt a clone/start/stop/destroy."""
    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
    )
    client = _build_mock_client()
    client.nodes.get.side_effect = Exception(
        "403 Forbidden: Permission check failed"
    )
    _install_client(a, client)

    with pytest.raises(ProxmoxAPIError) as exc_info:
        asyncio.run(a.list_nodes())
    assert "PVEVMAdmin" in str(exc_info.value)
    assert "PROXMOX-SETUP" in str(exc_info.value)


def test_timeout_surfaces_as_proxmox_api_error():
    """A hung PVE call must never leak asyncio.TimeoutError to the runner."""

    def hang(*a, **kw):
        time.sleep(5)

    a = RealProxmoxAdapter(
        host="pve", port=8006, user="u",
        token_id="u!t", token_secret="x",
        timeout_s=0.05,  # 50ms — guarantees timeout in CI
    )
    client = _build_mock_client()
    client.nodes.get.side_effect = hang
    _install_client(a, client)

    with pytest.raises(ProxmoxAPIError) as exc_info:
        asyncio.run(a.list_nodes())
    assert "timed out" in str(exc_info.value).lower()


# --- proxmoxer construction ------------------------------------------------


def test_get_client_uses_settings():
    """Verify the ProxmoxAPI constructor gets called with the right args."""
    with patch("app.runners.real_adapter.ProxmoxAPI") as api_cls:
        api_cls.return_value = MagicMock()
        a = RealProxmoxAdapter(
            host="pve.example", port=8006, user="divide@pve",
            token_id="divide@pve!drill", token_secret="s3cret", verify_ssl=False,
        )
        client = a._get_client()
        api_cls.assert_called_once_with(
            host="pve.example",
            port=8006,
            user="divide@pve",
            token_name="drill",
            token_value="s3cret",
            verify_ssl=False,
            backend="https",
            timeout=300,
        )
        assert client is api_cls.return_value
        # Second call reuses the same instance.
        assert a._get_client() is client


# --- factory behaviour -----------------------------------------------------


def test_factory_picks_mock_without_env(monkeypatch):
    monkeypatch.delenv("PROXMOX_HOST", raising=False)
    monkeypatch.delenv("PROXMOX_TOKEN_ID", raising=False)
    monkeypatch.delenv("PROXMOX_TOKEN_SECRET", raising=False)
    from app.runners.mock_adapter import MockProxmoxAdapter
    from app.runners.runner import _default_adapter

    assert isinstance(_default_adapter(), MockProxmoxAdapter)


def test_factory_picks_real_with_env(monkeypatch):
    monkeypatch.setenv("PROXMOX_HOST", "pve.example")
    monkeypatch.setenv("PROXMOX_TOKEN_ID", "u!t")
    monkeypatch.setenv("PROXMOX_TOKEN_SECRET", "s3cret")
    # `get_settings()` is lru_cached — clear it so the env above takes effect.
    from app.core import config as cfg_module
    from app.runners.real_adapter import RealProxmoxAdapter
    from app.runners.runner import _default_adapter

    cfg_module.get_settings.cache_clear()
    try:
        assert isinstance(_default_adapter(), RealProxmoxAdapter)
    finally:
        cfg_module.get_settings.cache_clear()


def test_factory_picks_real_with_db_overlay(monkeypatch):
    monkeypatch.delenv("PROXMOX_HOST", raising=False)
    monkeypatch.delenv("PROXMOX_TOKEN_ID", raising=False)
    monkeypatch.delenv("PROXMOX_TOKEN_SECRET", raising=False)
    from app.core import config as cfg_module
    from app.runners.real_adapter import RealProxmoxAdapter
    from app.runners.runner import _default_adapter
    from app.services.proxmox import set_db_overlay

    cfg_module.get_settings.cache_clear()
    set_db_overlay(
        {
            "host": "https://pve.example",
            "port": 8006,
            "user": "divide@pve",
            "token_id": "divide@pve!drill",
            "token_secret": "s3cret",
            "verify_ssl": False,
            "node": "pve2",
            "clone_storage": "fast-zfs",
        }
    )
    try:
        adapter = _default_adapter()
        assert isinstance(adapter, RealProxmoxAdapter)
        assert adapter._host == "pve.example"
        assert adapter._node == "pve2"
        assert adapter._clone_storage == "fast-zfs"
    finally:
        set_db_overlay(None)
        cfg_module.get_settings.cache_clear()


def test_factory_falls_back_to_mock_on_bad_config(monkeypatch):
    """If PROXMOX_HOST is empty after stripping, factory logs + falls back."""
    monkeypatch.setenv("PROXMOX_HOST", "")
    monkeypatch.setenv("PROXMOX_TOKEN_ID", "u!t")
    monkeypatch.setenv("PROXMOX_TOKEN_SECRET", "s3cret")
    from app.core import config as cfg_module
    from app.runners.mock_adapter import MockProxmoxAdapter
    from app.runners.runner import _default_adapter

    cfg_module.get_settings.cache_clear()
    try:
        assert isinstance(_default_adapter(), MockProxmoxAdapter)
    finally:
        cfg_module.get_settings.cache_clear()
