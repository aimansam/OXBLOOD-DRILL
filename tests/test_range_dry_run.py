"""Range dry-run tool: drive a scripted API and check pass/fail and cleanup."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[1] / "tools" / "range_dry_run.py"


@pytest.fixture(scope="module")
def tool():
    spec = importlib.util.spec_from_file_location("range_dry_run", TOOL)
    module = importlib.util.module_from_spec(spec)
    sys.modules["range_dry_run"] = module  # dataclasses resolve their module here
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, status_code=200, body=None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.text = str(self._body)

    def json(self):
        return self._body


class FakeClient:
    """Routes are (method, path) -> FakeResponse or a list consumed one per call."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def _handle(self, method, path):
        self.calls.append((method, path))
        value = self.routes[(method, path)]
        if isinstance(value, list):
            return value.pop(0) if len(value) > 1 else value[0]
        return value

    def get(self, path, **_):
        return self._handle("GET", path)

    def post(self, path, **_):
        return self._handle("POST", path)

    def delete(self, path, **_):
        return self._handle("DELETE", path)


SCENARIOS = FakeResponse(200, [{"id": 7, "name": "enterprise-file-breach"}])
PREFLIGHT_OK = FakeResponse(200, {"ready": True, "node": "pve", "checks": []})
CREATED = FakeResponse(200, {"message": "Drill created", "drill_id": 42})
READY_HEALTH = FakeResponse(
    200,
    {
        "mood": "ready",
        "counts": {"ready": 2, "total": 2},
        "checks": [
            {"label": "dc01", "state": "ready", "required": True},
            {"label": "kali", "state": "ready", "required": True},
        ],
    },
)


def _env(**env):
    return FakeResponse(200, {"environment_config": env})


def _run(tool, routes):
    client = FakeClient(routes)
    report = tool.Report()
    run = tool.RangeDryRun(client, report, timeout_s=5, poll_s=0, sleep=lambda _s: None)
    try:
        scenario = run.resolve_scenario("enterprise-file-breach")
        run.preflight(scenario["id"], force=False)
        run.create_drill(scenario)
        if run.prepare():
            run.validate()
    except tool.DryRunError:
        pass
    finally:
        run.cleanup()
    return client, report


def _routes(overrides=None):
    routes = {
        ("GET", "/api/v1/scenarios"): SCENARIOS,
        ("GET", "/api/v2/drills/scenario-preflight/7"): PREFLIGHT_OK,
        ("POST", "/api/v2/drills"): CREATED,
        ("POST", "/api/v2/drills/42/prepare"): FakeResponse(200, {"provision_status": "starting"}),
        ("GET", "/api/v2/drills/42"): [
            _env(provision_status="starting"),
            _env(provision_status="started", provision_run_id=5),
            _env(provision_status="started", provision_run_id=5, cleanup_status="stopped"),
        ],
        ("GET", "/api/v2/drills/42/range-health"): READY_HEALTH,
        ("POST", "/api/v2/drills/42/stop"): FakeResponse(200, {}),
        ("DELETE", "/api/v2/drills/42"): FakeResponse(200, {}),
    }
    routes.update(overrides or {})
    return routes


def test_healthy_range_passes_and_is_cleaned_up(tool):
    client, report = _run(tool, _routes())
    assert report.ok, [s for s in report.steps if not s.passed]
    assert ("POST", "/api/v2/drills/42/stop") in client.calls
    assert ("DELETE", "/api/v2/drills/42") in client.calls


def test_failed_provision_fails_but_still_cleans_up(tool):
    routes = _routes(
        {
            ("GET", "/api/v2/drills/42"): [
                _env(provision_status="failed", provision_error="dc01 never got an IPv4 address"),
                _env(provision_status="failed", provision_run_id=5, cleanup_status="stopped"),
            ]
        }
    )
    client, report = _run(tool, routes)
    assert not report.ok
    failed = next(s for s in report.steps if s.name == "prepare range")
    assert "dc01 never got an IPv4 address" in failed.detail
    assert ("POST", "/api/v2/drills/42/stop") in client.calls
    assert not any(s.name == "range health" for s in report.steps)


def test_unhealthy_check_fails_the_run(tool):
    health = FakeResponse(
        200,
        {
            "mood": "needs_attention",
            "counts": {"ready": 1, "total": 2},
            "checks": [
                {"label": "dc01", "state": "needs_attention", "required": True, "detail": "no IP"},
                {"label": "kali", "state": "ready", "required": True},
            ],
        },
    )
    _client, report = _run(tool, _routes({("GET", "/api/v2/drills/42/range-health"): health}))
    assert not report.ok
    assert not next(s for s in report.steps if s.name == "range health").passed


def test_failed_preflight_stops_before_creating_a_drill(tool):
    routes = _routes(
        {
            ("GET", "/api/v2/drills/scenario-preflight/7"): FakeResponse(
                503, {"detail": "The configured Proxmox node is unavailable."}
            )
        }
    )
    client, report = _run(tool, routes)
    assert not report.ok
    assert ("POST", "/api/v2/drills") not in client.calls


def test_unknown_scenario_is_reported(tool):
    client = FakeClient({("GET", "/api/v1/scenarios"): SCENARIOS})
    report = tool.Report()
    run = tool.RangeDryRun(client, report, poll_s=0, sleep=lambda _s: None)
    with pytest.raises(tool.DryRunError):
        run.resolve_scenario("nope")
    assert "no scenario matches" in report.steps[0].detail


def test_timeout_is_reported_not_hung(tool):
    ticks = iter(range(0, 10_000, 3))
    client = FakeClient(
        {
            ("POST", "/api/v2/drills/42/prepare"): FakeResponse(200, {}),
            ("GET", "/api/v2/drills/42"): _env(provision_status="starting"),
        }
    )
    report = tool.Report()
    run = tool.RangeDryRun(
        client, report, timeout_s=10, poll_s=0, sleep=lambda _s: None, clock=lambda: next(ticks)
    )
    run.drill_id = 42
    assert run.prepare() is False
    assert "timed out" in report.steps[0].detail
