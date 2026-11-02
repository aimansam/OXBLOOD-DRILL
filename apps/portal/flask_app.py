"""
Flask portal - serves frontend and proxies API requests to FastAPI.

This is a reverse proxy that:
1. Serves the landing page at /
2. Serves the login page at /login
3. Serves the drill platform at /drill/*
4. Proxies /api/* requests to the FastAPI backend
5. Provides a single entry point (port 80) for everything
"""

import os
import re

import requests
from flask import Flask, Response, abort, request, send_from_directory

app = Flask(__name__)

# Configuration
APP_DIR = os.path.join(os.path.dirname(__file__), "app")
API_BACKEND = os.environ.get("API_BACKEND", "http://api:8000")

# The React UI (apps/web) is built into this directory at image build time and served at /app/.
# In a checkout it lives in apps/web/dist.
_WEB_CANDIDATES = (
    os.path.join(os.path.dirname(__file__), "web"),
    os.path.join(os.path.dirname(__file__), "..", "web", "dist"),
)
WEB_DIR = os.environ.get("WEB_DIR") or next(
    (path for path in _WEB_CANDIDATES if os.path.isdir(path)), _WEB_CANDIDATES[0]
)

# Timeout for API proxy requests (in seconds)
PROXY_TIMEOUT = 30


@app.route("/")
def landing():
    """Serve the landing page."""
    return send_from_directory(APP_DIR, "landing.html")


@app.route("/login")
def login():
    """Serve the login page."""
    return send_from_directory(APP_DIR, "login.html")


@app.route("/join")
def join():
    """Invite-only participant registration page."""
    response = send_from_directory(APP_DIR, "join.html")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


_ASSET_VERSION_RE = re.compile(r'(\.(?:js|css))\?v=[^"\']*')


def _asset_version():
    """Cache-buster derived from the newest top-level JS/CSS mtime."""
    try:
        mtimes = [
            entry.stat().st_mtime
            for entry in os.scandir(APP_DIR)
            if entry.is_file() and entry.name.endswith((".js", ".css"))
        ]
    except OSError:
        return "0"
    return str(int(max(mtimes, default=0)))


@app.route("/drill/")
def drill_index():
    """Serve the drill platform index with auto-versioned asset URLs."""
    with open(os.path.join(APP_DIR, "index.html"), encoding="utf-8") as fh:
        html = fh.read()
    html = _ASSET_VERSION_RE.sub(rf"\1?v={_asset_version()}", html)
    response = Response(html, mimetype="text/html")
    response.headers["Cache-Control"] = "no-cache"
    return response


def _is_asset_path(path):
    """True for file-like URLs that must 404 (not SPA-fallback to HTML)."""
    name = path.rsplit("/", 1)[-1]
    return "." in name or path.startswith("assets/")


@app.route("/drill/<path:path>")
def drill_platform(path):
    """Serve drill platform files."""
    full = os.path.join(APP_DIR, path)
    if os.path.isfile(full):
        return send_from_directory(APP_DIR, path)
    if _is_asset_path(path):
        abort(404)
    return send_from_directory(APP_DIR, "index.html")


@app.route("/app/")
@app.route("/app/<path:path>")
def web_app(path=""):
    """Serve the React UI. Unknown extensionless paths fall back to index.html (client routing)."""
    full = os.path.join(WEB_DIR, path)
    if path and os.path.isfile(full):
        response = send_from_directory(WEB_DIR, path)
        if path.startswith("assets/"):
            # Vite fingerprints these files, so they never change under the same name.
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response
    if path and _is_asset_path(path):
        abort(404)
    if not os.path.isfile(os.path.join(WEB_DIR, "index.html")):
        return Response("The web app is not built", 503, mimetype="text/plain")
    response = send_from_directory(WEB_DIR, "index.html")
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.route("/api/<path:path>", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
def proxy_api(path):
    """
    Proxy /api/* requests to the FastAPI backend.

    This forwards the request to the API backend and returns the response.
    All headers, query parameters, and request body are preserved.
    """
    # Health probes are mounted at the API root; all application routes live
    # under /api and retain the normal prefix when proxied.
    backend_path = path if path in {"healthz", "readyz"} else f"api/{path}"
    backend_url = f"{API_BACKEND}/{backend_path}"

    # Forward the request
    try:
        # Get the request data
        headers = {key: value for key, value in request.headers if key.lower() != "host"}

        # Make the request to the backend
        resp = requests.request(
            method=request.method,
            url=backend_url,
            headers=headers,
            data=request.get_data(),
            cookies=request.cookies,
            params=request.args,
            allow_redirects=False,
            timeout=PROXY_TIMEOUT,
        )

        # Build the response
        excluded_headers = ["content-encoding", "content-length", "transfer-encoding", "connection"]
        response_headers = [
            (name, value)
            for name, value in resp.raw.headers.items()
            if name.lower() not in excluded_headers
        ]

        response = Response(resp.content, resp.status_code, response_headers)
        return response

    except requests.exceptions.Timeout:
        return Response('{"error": "API request timeout"}', 504, mimetype="application/json")
    except requests.exceptions.ConnectionError:
        return Response('{"error": "API backend unavailable"}', 503, mimetype="application/json")
    except Exception as e:
        return Response(f'{{"error": "Proxy error: {str(e)}"}}', 500, mimetype="application/json")


@app.route("/healthz")
def health():
    """Liveness plus a check that the files we serve are really there.

    A bind mount that went stale (the host directory was replaced) leaves this
    process running with an empty APP_DIR, so every page 404s while a bare
    liveness check keeps saying "ok". Report that as unhealthy instead.
    """
    index = os.path.join(APP_DIR, "index.html")
    try:
        served = os.path.getsize(index) > 0
    except OSError:
        served = False
    if not served:
        return {"status": "degraded", "service": "portal", "reason": "index.html missing"}, 503
    return {"status": "ok", "service": "portal"}


@app.route("/<path:path>")
def static_files(path):
    """Serve static files from the app directory."""
    full = os.path.join(APP_DIR, path)
    if os.path.isfile(full):
        return send_from_directory(APP_DIR, path)
    # Missing assets must 404 so the browser doesn't parse HTML as JS/CSS.
    if _is_asset_path(path):
        abort(404)
    # Extensionless routes fall back to the landing page (SPA routing).
    return send_from_directory(APP_DIR, "landing.html")


if __name__ == "__main__":
    # Development mode
    app.run(host="0.0.0.0", port=80, debug=True)
