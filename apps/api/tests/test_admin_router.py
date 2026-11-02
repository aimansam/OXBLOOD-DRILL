"""Smoke tests for the admin/setup wizard HTTP endpoints.

These hit the FastAPI app via TestClient and assert the right status
codes + response shapes. No live PVE / no live Redis.

Auth note (L2 2.9): every endpoint in ``/api/v1/admin/*`` is hard-gated
on ``require_role(admin)`` at the router level. The ``admin_headers``
fixture below mints a fresh admin token per test so each request
passes the gate. Tests that need to verify the gate itself
(``test_admin_probe_returns_401_when_no_token``, etc.) intentionally
*don't* use it.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


class _FakeRedis:
    """Tiny in-memory redis stand-in for tests that touch progress."""

    def __init__(self):
        self.data: dict[str, dict[str, str]] = {}

    async def hset(self, key, mapping):
        self.data.setdefault(key, {}).update(mapping)

    async def expire(self, key, seconds):  # noqa: ARG002
        pass

    async def hgetall(self, key):
        return dict(self.data.get(key, {}))

    async def scan_iter(self, match=None):
        if match is None:
            for k in list(self.data.keys()):
                yield k
            return
        for k in list(self.data.keys()):
            if "*" in match:
                prefix = match.split("*", 1)[0]
                if k.startswith(prefix):
                    yield k
            elif k == match:
                yield k


@pytest.fixture
def client():
    """Build a TestClient for the app with PVE/Redis stubbed out."""
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def admin_headers():
    """Mint a fresh admin token and return its header dict.

    Every endpoint under /api/v1/admin/* requires this. We mint
    per-test rather than per-session because token issuance depends
    on the per-process signing secret (see auth._signing_secret)
    and tests run in arbitrary order.
    """
    from app.core.auth import Role, sign_token

    tok = sign_token("admin-test", Role.ADMIN.value, 3600)
    return {"X-Divide-Token": tok}


def test_probe_endpoint_returns_snapshot(client, admin_headers):
    """GET /api/v1/admin/probe returns the ProbeResponse shape."""
    # Stub probe_pve so we don't need a live PVE.
    from app.services.admin import PveProbeResult

    fake_result = PveProbeResult(
        reachable=True,
        version="9.1.7 (9)",
        pve_user="divide@pve@pam",
        has_drill_privs=True,
        has_setup_privs=False,
        drill_privs_present=["VM.Allocate", "VM.Clone", "VM.PowerMgmt"],
        drill_privs_missing=[],
        setup_privs_present=[],
        setup_privs_missing=["Datastore.AllocateSpace", "Datastore.Allocate", "Datastore.Audit"],
        storage=[{"storage": "local", "content": "iso,vztmpl", "avail_bytes": 50 * 1024**3}],
        nodes=["pve"],
        error=None,
    )
    with patch("app.services.admin.probe_pve") as p:
        p.return_value = fake_result
        r = client.get("/api/v1/admin/probe", headers=admin_headers)
        assert r.status_code == 200
        body = r.json()
        assert body["reachable"] is True
        assert body["has_drill_privs"] is True
        assert body["has_setup_privs"] is False
        assert "Datastore.AllocateSpace" in body["setup_privs_missing"]


def test_pve_guest_inventory_requires_admin_and_returns_live_guest_data(client, admin_headers):
    with patch(
        "app.routers.admin.wizard.list_virtual_machines",
        return_value=[
            {"vmid": 109, "name": "dc01", "node": "pve", "status": "running"},
        ],
    ):
        response = client.get("/api/v1/admin/pve-guests", headers=admin_headers)
    assert response.status_code == 200
    assert response.json() == {
        "items": [{"vmid": 109, "name": "dc01", "node": "pve", "status": "running"}],
        "total": 1,
    }


@pytest.mark.asyncio
async def test_pve_guest_inventory_drill_scope_uses_registered_vms(client, admin_headers):
    from uuid import uuid4

    from app.db import models as catalog
    from app.db.models_drill import Drill, DrillStatus
    from app.db.session import get_sessionmaker
    from app.services.db import get_engine
    from sqlalchemy import delete

    # The v1 test database migrates the catalog; the v2 drill table is
    # normally created by the OxBlood schema and must be added here.
    async with get_engine().begin() as conn:
        await conn.run_sync(Drill.__table__.create, checkfirst=True)

    async with get_sessionmaker()() as db:
        scenario = catalog.Scenario(
            name=f"inventory-{uuid4().hex[:12]}",
            title="Inventory scope",
            difficulty="easy",
            duration_min=30,
            spec={},
        )
        db.add(scenario)
        await db.flush()
        live_run = catalog.Run(scenario_id=scenario.id)
        old_run = catalog.Run(scenario_id=scenario.id)
        db.add_all([live_run, old_run])
        await db.flush()
        drill = Drill(
            title="Current drill",
            status=DrillStatus.ACTIVE,
            environment_config={"provision_run_id": live_run.id},
        )
        db.add_all(
            [
                catalog.SnapshotBaseline(
                    scenario_id=scenario.id,
                    scenario_version=1,
                    role="dc01",
                    template="test",
                    pve_vmid=987601,
                    pve_node="pve",
                ),
                catalog.Asset(run_id=live_run.id, role="red", template="test", pve_vmid=987602),
                catalog.Asset(run_id=old_run.id, role="old", template="test", pve_vmid=987603),
                drill,
            ]
        )
        await db.commit()
        scenario_id, live_id, old_id, drill_id = scenario.id, live_run.id, old_run.id, drill.id

    guests = [
        {"vmid": 987601, "status": "stopped"},
        {"vmid": 987602, "status": "running"},
        {"vmid": 987603, "status": "running"},
        {"vmid": 987604, "status": "running"},
    ]
    try:
        with patch("app.routers.admin.wizard.list_virtual_machines", return_value=guests):
            scoped = client.get("/api/v1/admin/pve-guests?drill_only=true", headers=admin_headers)
            full = client.get("/api/v1/admin/pve-guests", headers=admin_headers)
        assert scoped.status_code == 200
        assert {item["vmid"] for item in scoped.json()["items"]} == {987601, 987602}
        assert scoped.json()["total_registered"] == 2
        assert full.json()["total"] == 4
    finally:
        async with get_sessionmaker()() as db:
            await db.execute(delete(Drill).where(Drill.id == drill_id))
            await db.execute(
                delete(catalog.SnapshotBaseline).where(
                    catalog.SnapshotBaseline.scenario_id == scenario_id
                )
            )
            await db.execute(
                delete(catalog.Asset).where(catalog.Asset.run_id.in_((live_id, old_id)))
            )
            await db.execute(delete(catalog.Run).where(catalog.Run.id.in_((live_id, old_id))))
            await db.execute(delete(catalog.Scenario).where(catalog.Scenario.id == scenario_id))
            await db.commit()


def test_drill_template_status_when_ready(client, admin_headers):
    """drill-template-status is ready once PVE lists any template for the catalog."""
    with patch("app.services.proxmox.list_templates") as lt:
        lt.return_value = [
            {"name": "tpl-debian-cloudinit", "vmid": 9000, "template": 1},
        ]
        r = client.get("/api/v1/admin/drill-template-status", headers=admin_headers)
        assert r.status_code == 200
        body = r.json()
        assert body["ready"] is True
        assert body["available"] == ["tpl-debian-cloudinit"]
        assert body["error"] is None


def test_drill_template_status_when_missing(client, admin_headers):
    """drill-template-status returns ready=False + error when PVE has no templates."""
    with patch("app.services.proxmox.list_templates") as lt:
        lt.return_value = []
        r = client.get("/api/v1/admin/drill-template-status", headers=admin_headers)
        body = r.json()
        assert body["ready"] is False
        assert "no PVE templates" in body["error"]


def test_set_template_endpoint(client, admin_headers):
    """POST /api/v1/admin/set-template/{vmid} flips template=1 on the VM."""
    with patch("app.services.admin.set_template_flag") as stf:
        r = client.post(
            "/api/v1/admin/set-template/9000",
            json={"node": "pve"},
            headers=admin_headers,
        )
        assert r.status_code == 200
        assert r.json() == {"vmid": 9000, "template": True, "node": "pve"}
        stf.assert_called_once_with(9000, "pve")


def test_progress_endpoint_returns_404_for_unknown_job(client, monkeypatch, admin_headers):
    monkeypatch.setattr("app.services.cache.get_redis", lambda: _FakeRedis())
    r = client.get("/api/v1/admin/progress/upload/nope", headers=admin_headers)
    assert r.status_code == 404


def test_progress_endpoint_validates_kind(client, monkeypatch, admin_headers):
    monkeypatch.setattr("app.services.cache.get_redis", lambda: _FakeRedis())
    r = client.get("/api/v1/admin/progress/garbage/x", headers=admin_headers)
    assert r.status_code == 400
    assert "kind" in r.json()["detail"].lower()


def test_upload_qcow2_rejects_empty(client, admin_headers):
    """Empty multipart body should 400, not 500."""
    r = client.post(
        "/api/v1/admin/upload-qcow2",
        files={"file": ("empty.qcow2", b"", "application/octet-stream")},
        data={"node": "pve", "storage": "local"},
        headers=admin_headers,
    )
    assert r.status_code == 400
    assert "empty" in r.json()["detail"]


def test_upload_qcow2_streams_real_file(client, tmp_path: Path, monkeypatch):
    """A small qcow2 file uploads end-to-end against a fake httpx client."""
    from app.core.auth import Role, sign_token
    from app.core.config import get_settings
    from app.services import proxmox as px

    # PROXMOX_TOKEN_SECRET drives the dev token-signing fallback (see
    # auth._signing_secret). The monkeypatch MUST come before we mint
    # the admin token so the token's HMAC matches what the server
    # will compute later.
    monkeypatch.setenv("PROXMOX_HOST", "pve.lan")
    monkeypatch.setenv("PROXMOX_TOKEN_ID", "divide@pve!t")
    monkeypatch.setenv("PROXMOX_TOKEN_SECRET", "secret")
    get_settings.cache_clear()
    px.get_proxmox_client.cache_clear()
    monkeypatch.setattr("app.services.cache.get_redis", lambda: _FakeRedis())

    admin_headers = {"X-Divide-Token": sign_token("admin-test", Role.ADMIN.value, 3600)}

    fpath = tmp_path / "debian-13.qcow2"
    fpath.write_bytes(b"\x00" * (64 * 1024))  # 64 KB

    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.json.return_value = {"data": "local:import/debian-13.qcow2"}

    class FakeHttpxClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            return fake_response

    with patch("httpx.AsyncClient", FakeHttpxClient):
        with open(fpath, "rb") as fh:
            r = client.post(
                "/api/v1/admin/upload-qcow2",
                files={"file": ("debian-13.qcow2", fh, "application/octet-stream")},
                data={"node": "pve", "storage": "local"},
                headers=admin_headers,
            )
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "success"
        assert body["result_volid"] == "local:import/debian-13.qcow2"


# ---------- L2 2.9 RBAC regression tests ---------------------------------


def test_admin_probe_returns_401_when_no_token(client):
    """Anonymous LAN attacker can no longer probe PVE reachability.

    Before L2 2.9: GET /api/v1/admin/probe returned the full
    ProbeResponse (PVE version, node names, storage pools, ACL
    shape) to any caller. That leaked the operator's PVE
    deployment details to anyone on the LAN.

    After: missing header -> 401 with WWW-Authenticate.
    """
    r = client.get("/api/v1/admin/probe")
    assert r.status_code == 401
    assert "WWW-Authenticate" in r.headers


def test_admin_probe_returns_403_for_non_admin_token(client):
    """A valid token with a non-admin role gets 403, not 200.

    Guards against accidental "any authenticated caller passes"
    shortcuts in the require_role chain.
    """
    from app.core.auth import Role, sign_token

    tok = sign_token("mallory", Role.RED.value, 3600)
    r = client.get("/api/v1/admin/probe", headers={"X-Divide-Token": tok})
    assert r.status_code == 403
    # Detail names the rejected role so the developer can debug.
    assert "'red'" in r.json()["detail"]


@pytest.mark.parametrize(
    "path,method",
    [
        ("/api/v1/admin/probe", "GET"),
        ("/api/v1/admin/storage", "GET"),
        ("/api/v1/admin/drill-template-status", "GET"),
        ("/api/v1/admin/progress", "GET"),
    ],
)
def test_admin_routes_all_return_401_when_no_token(client, path, method):
    """Every /api/v1/admin/* endpoint must be uniformly gated.

    The router-level ``dependencies=[Depends(require_role(ADMIN))]``
    applies to every route registered on the router, including
    future ones. If someone adds a new endpoint and forgets the
    auth check, this parametrized test will catch the regression
    by enumerating the known endpoints.
    """
    if method == "GET":
        r = client.get(path)
    else:
        r = client.post(path)
    assert r.status_code == 401, f"{method} {path} should be 401, got {r.status_code}"
