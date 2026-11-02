"""The portal health check must notice when the React build is missing or empty."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

pytest.importorskip("flask")

PORTAL = Path(__file__).resolve().parents[1] / "apps" / "portal"


@pytest.fixture
def portal(tmp_path):
    spec = importlib.util.spec_from_file_location("portal_flask_app", PORTAL / "flask_app.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["portal_flask_app"] = module
    spec.loader.exec_module(module)
    (tmp_path / "index.html").write_text("<div id=root></div>")
    module.WEB_DIR = str(tmp_path)
    yield module, tmp_path
    sys.modules.pop("portal_flask_app", None)


def test_healthz_ok_when_the_build_is_served(portal):
    module, _ = portal
    response = module.app.test_client().get("/healthz")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok", "service": "portal"}


def test_healthz_degraded_when_the_build_is_missing(portal):
    module, tmp_path = portal
    (tmp_path / "index.html").unlink()
    response = module.app.test_client().get("/healthz")
    assert response.status_code == 503
    assert response.get_json()["reason"] == "index.html missing"


def test_healthz_degraded_when_index_is_empty(portal):
    module, tmp_path = portal
    (tmp_path / "index.html").write_text("")
    assert module.app.test_client().get("/healthz").status_code == 503
