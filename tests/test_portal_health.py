"""The portal health check must notice when the served files are gone."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

pytest.importorskip("flask")

PORTAL = Path(__file__).resolve().parents[1] / "apps" / "portal"


@pytest.fixture
def portal_app():
    spec = importlib.util.spec_from_file_location("portal_flask_app", PORTAL / "flask_app.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["portal_flask_app"] = module
    spec.loader.exec_module(module)
    yield module
    sys.modules.pop("portal_flask_app", None)


def test_healthz_ok_when_index_is_served(portal_app):
    response = portal_app.app.test_client().get("/healthz")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok", "service": "portal"}


def test_healthz_degraded_when_app_dir_is_empty(portal_app, tmp_path):
    # Simulates a stale bind mount: the process is alive but the directory is empty.
    portal_app.APP_DIR = str(tmp_path)
    response = portal_app.app.test_client().get("/healthz")
    assert response.status_code == 503
    body = response.get_json()
    assert body["status"] == "degraded"
    assert body["reason"] == "index.html missing"


def test_healthz_degraded_when_index_is_empty(portal_app, tmp_path):
    (tmp_path / "index.html").write_text("")
    portal_app.APP_DIR = str(tmp_path)
    assert portal_app.app.test_client().get("/healthz").status_code == 503
