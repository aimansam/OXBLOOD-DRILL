"""
Flask portal - serves the React UI and proxies API requests to FastAPI.

1. Serves the React app (built from apps/web) at /app/
2. Redirects the old entry points (/, /login, /join, /drill/) to it
3. Proxies /api/* requests to the FastAPI backend
4. Provides a single entry point (port 80) for everything
"""

import os

import requests
from flask import Flask, Response, abort, redirect, request, send_from_directory

app = Flask(__name__)

# Configuration
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


def _is_asset_path(path):
    """True for file-like URLs that must 404 (not SPA-fallback to HTML)."""
    name = path.rsplit("/", 1)[-1]
    return "." in name or path.startswith("assets/")


@app.route("/")
def landing():
    """The old landing page is gone; the app's own sign-in is the front door."""
    return redirect("/app/", code=302)


@app.route("/login")
def login():
    return redirect("/app/login", code=302)


@app.route("/join")
def join():
    """Invitation links are shared as /join#token=...; browsers keep the fragment across this redirect."""
    return redirect("/app/join", code=302)


@app.route("/drill/")
@app.route("/drill/<path:path>")
def classic_portal(path=""):
    """The classic portal was retired; old bookmarks land on the new UI."""
    return redirect("/app/", code=302)


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
    if path == "join":
        # The invitation secret is in the URL fragment; never leak it through Referer.
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
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

    If the web build is missing or empty the process is up but every page fails, so
    report that as unhealthy instead of a bare "ok".
    """
    index = os.path.join(WEB_DIR, "index.html")
    try:
        served = os.path.getsize(index) > 0
    except OSError:
        served = False
    if not served:
        return {"status": "degraded", "service": "portal", "reason": "index.html missing"}, 503
    return {"status": "ok", "service": "portal"}


@app.route("/<path:path>")
def other(path):
    """Anything else: files 404, page-like URLs go to the app."""
    if _is_asset_path(path):
        abort(404)
    return redirect("/app/", code=302)


if __name__ == "__main__":
    # Development mode
    app.run(host="0.0.0.0", port=80, debug=True)
