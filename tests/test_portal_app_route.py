"""The portal serves the React build at /app/ with client-side routing fallback."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

pytest.importorskip("flask")

PORTAL = Path(__file__).resolve().parents[1] / "apps" / "portal"


@pytest.fixture
def web(tmp_path):
    spec = importlib.util.spec_from_file_location("portal_flask_app_web", PORTAL / "flask_app.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["portal_flask_app_web"] = module
    spec.loader.exec_module(module)
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<div id=root>spa</div>")
    (tmp_path / "assets" / "app-abc123.js").write_text("console.log(1)")
    module.WEB_DIR = str(tmp_path)
    yield module.app.test_client(), module, tmp_path
    sys.modules.pop("portal_flask_app_web", None)


def test_index_is_served_without_caching(web):
    client, _, _ = web
    response = client.get("/app/")
    assert response.status_code == 200
    assert b"spa" in response.data
    assert response.headers["Cache-Control"] == "no-cache"


def test_client_routes_fall_back_to_index(web):
    client, _, _ = web
    for path in ("/app/exercises", "/app/exercises/42", "/app/login"):
        response = client.get(path)
        assert response.status_code == 200, path
        assert b"spa" in response.data


def test_fingerprinted_assets_are_cached_forever(web):
    client, _, _ = web
    response = client.get("/app/assets/app-abc123.js")
    assert response.status_code == 200
    assert "immutable" in response.headers["Cache-Control"]


def test_missing_assets_404_instead_of_returning_html(web):
    client, _, _ = web
    assert client.get("/app/assets/missing.js").status_code == 404
    assert client.get("/app/favicon.png").status_code == 404


def test_app_without_trailing_slash_redirects(web):
    client, _, _ = web
    assert client.get("/app").status_code in (301, 308)


def test_unbuilt_app_reports_503(web):
    client, _, tmp_path = web
    (tmp_path / "index.html").unlink()
    assert client.get("/app/").status_code == 503


def test_old_entry_points_redirect_into_the_app(web):
    client, _, _ = web
    expected = {
        "/": "/app/",
        "/login": "/app/login",
        "/join": "/app/join",
        "/drill/": "/app/",
        "/drill/anything": "/app/",
    }
    for path, target in expected.items():
        response = client.get(path)
        assert response.status_code == 302, path
        assert response.headers["Location"].endswith(target), (path, response.headers["Location"])


def test_unknown_pages_go_to_the_app_but_unknown_files_404(web):
    client, _, _ = web
    assert client.get("/whatever").headers["Location"].endswith("/app/")
    assert client.get("/missing.js").status_code == 404


def test_join_page_never_leaks_the_invitation_through_referer_or_cache(web):
    client, _, _ = web
    response = client.get("/app/join")
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Cache-Control"] == "no-store"


def test_api_proxy_route_is_registered(web):
    _, module, _ = web
    assert module.app.url_map.bind("localhost").match("/api/v1/me", method="GET")[0] == "proxy_api"
    assert module.app.url_map.bind("localhost").match("/healthz", method="GET")[0] == "health"
