#!/usr/bin/env python3
"""Dry-run a scenario's range before a drill: prepare it, validate it, tear it down.

Creates a throwaway scheduled drill, runs "Prepare range" (clone, boot, seed,
validate every VM), reports a pass/fail per check, then stops the drill so the
VMs are cleaned up and deletes it. Run it on the day before a drill, or after
changing a scenario or a template, so problems such as a guest that never gets
an IP show up before participants are waiting.

It creates real VMs on the Proxmox node the API is configured for.

    export DIVIDE_ADMIN_PASSWORD=...            # or DIVIDE_TOKEN=...
    python tools/range_dry_run.py --scenario enterprise-file-breach
    python tools/range_dry_run.py --scenario 3 --keep      # leave the range up to inspect
    python tools/range_dry_run.py --scenario 3 --timeout 2400

Exit code 0 when the range came up healthy and cleanup succeeded, 1 otherwise.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import httpx

DEFAULT_API_BASE = os.environ.get("DIVIDE_API_BASE", "http://localhost:8000")
PREPARE_TERMINAL = {"started", "failed", "validation_failed", "cancelled", "timeout"}
CLEANUP_TERMINAL = {"stopped", "failed"}


@dataclass
class Step:
    name: str
    passed: bool
    detail: str = ""
    seconds: float = 0.0


@dataclass
class Report:
    steps: list[Step] = field(default_factory=list)

    def add(self, name: str, passed: bool, detail: str = "", seconds: float = 0.0) -> bool:
        self.steps.append(Step(name, passed, detail, seconds))
        mark = "PASS" if passed else "FAIL"
        tail = f"  ({seconds:.0f}s)" if seconds >= 1 else ""
        print(f"  [{mark}] {name}{': ' + detail if detail else ''}{tail}", flush=True)
        return passed

    @property
    def ok(self) -> bool:
        return all(step.passed for step in self.steps)


class DryRunError(RuntimeError):
    """A step that cannot continue (the report already says why)."""


def _json(response: httpx.Response) -> dict:
    try:
        body = response.json()
    except ValueError:
        body = {}
    return body if isinstance(body, dict) else {"items": body}


def _detail(response: httpx.Response) -> str:
    body = _json(response)
    return str(body.get("detail") or response.text[:160] or response.status_code)


class RangeDryRun:
    """Drives the v2 drill API. ``client`` is anything with httpx.Client's get/post/delete."""

    def __init__(
        self,
        client,
        report: Report,
        *,
        timeout_s: float = 1800,
        poll_s: float = 10,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.client = client
        self.report = report
        self.timeout_s = timeout_s
        self.poll_s = poll_s
        self._sleep = sleep
        self._clock = clock
        self.drill_id: int | None = None

    # -- steps -------------------------------------------------------------

    def resolve_scenario(self, ref: str) -> dict:
        response = self.client.get("/api/v1/scenarios")
        if response.status_code != 200:
            self.report.add("find scenario", False, _detail(response))
            raise DryRunError
        body = response.json()
        rows = body if isinstance(body, list) else body.get("items", [])
        for row in rows:
            if ref in {str(row.get("id")), str(row.get("name"))}:
                self.report.add("find scenario", True, f"{row.get('name')} (id {row['id']})")
                return row
        self.report.add("find scenario", False, f"no scenario matches {ref!r}")
        raise DryRunError

    def preflight(self, scenario_id: int, *, force: bool) -> None:
        response = self.client.get(f"/api/v2/drills/scenario-preflight/{scenario_id}")
        if response.status_code != 200:
            self.report.add("scenario preflight", False, _detail(response))
            if not force:
                raise DryRunError
            return
        body = response.json()
        failed = [c for c in body.get("checks", []) if not c.get("ready")]
        for check in failed:
            print(f"        not ready: {check.get('detail')}")
        ok = bool(body.get("ready"))
        self.report.add("scenario preflight", ok, f"node {body.get('node')}")
        if not ok and not force:
            raise DryRunError

    def create_drill(self, scenario: dict) -> int:
        title = f"dry-run {scenario.get('name')} {time.strftime('%Y%m%d-%H%M%S')}"
        response = self.client.post(
            "/api/v2/drills",
            json={
                "title": title,
                "drill_type": "individual",
                "duration_limit_minutes": 30,
                "max_participants": 10,
                "scenario_id": scenario["id"],
            },
        )
        if response.status_code != 200 or "drill_id" not in _json(response):
            self.report.add("create drill", False, _detail(response))
            raise DryRunError
        self.drill_id = int(response.json()["drill_id"])
        self.report.add("create drill", True, f"drill {self.drill_id}")
        return self.drill_id

    def prepare(self) -> bool:
        started = self._clock()
        response = self.client.post(f"/api/v2/drills/{self.drill_id}/prepare")
        if response.status_code != 200:
            self.report.add("prepare range", False, _detail(response))
            return False
        status, error = self._wait_for(PREPARE_TERMINAL, "provision_status")
        elapsed = self._clock() - started
        if status == "started":
            self.report.add("prepare range", True, "all VMs cloned and seeded", elapsed)
            return True
        self.report.add("prepare range", False, f"{status or 'timed out'}: {error}", elapsed)
        return False

    def validate(self) -> bool:
        response = self.client.get(f"/api/v2/drills/{self.drill_id}/range-health")
        if response.status_code != 200:
            return self.report.add("range health", False, _detail(response))
        body = response.json()
        for row in body.get("assets") or []:
            print(f"        vm {row.get('role')}: {row.get('status')} {row.get('ip') or '-'}")
        checks = body.get("checks", [])
        bad = [c for c in checks if c.get("state") != "ready" and c.get("required", True)]
        for check in checks:
            mark = "ok " if check.get("state") == "ready" else "BAD"
            print(
                f"        {mark} {check.get('label')}: {check.get('detail') or check.get('state')}"
            )
        counts = body.get("counts", {})
        summary = f"{counts.get('ready', 0)}/{counts.get('total', len(checks))} checks ready"
        return self.report.add("range health", body.get("mood") == "ready" and not bad, summary)

    def cleanup(self) -> bool:
        if self.drill_id is None:
            return True
        started = self._clock()
        response = self.client.post(f"/api/v2/drills/{self.drill_id}/stop")
        if response.status_code not in (200, 404):
            return self.report.add("cleanup VMs", False, _detail(response))
        status, error = self._wait_for(CLEANUP_TERMINAL, "cleanup_status")
        elapsed = self._clock() - started
        if status not in {"stopped", None}:
            return self.report.add("cleanup VMs", False, f"{status}: {error}", elapsed)
        deleted = self.client.delete(f"/api/v2/drills/{self.drill_id}")
        if deleted.status_code not in (200, 404):
            return self.report.add("cleanup VMs", False, f"delete: {_detail(deleted)}", elapsed)
        return self.report.add("cleanup VMs", True, "range stopped, drill removed", elapsed)

    # -- helpers -----------------------------------------------------------

    def _wait_for(self, terminal: set[str], key: str) -> tuple[str | None, str]:
        deadline = self._clock() + self.timeout_s
        while self._clock() < deadline:
            response = self.client.get(f"/api/v2/drills/{self.drill_id}")
            if response.status_code == 200:
                env = _json(response).get("environment_config") or {}
                status = env.get(key)
                if status in terminal:
                    return status, str(env.get("provision_error") or "")
                if key == "cleanup_status" and status is None and self._cleanup_not_needed(env):
                    return None, ""
            self._sleep(self.poll_s)
        return None, f"no result after {self.timeout_s:.0f}s"

    @staticmethod
    def _cleanup_not_needed(env: dict) -> bool:
        return not env.get("provision_run_id")


def _login(client: httpx.Client) -> None:
    token = os.environ.get("DIVIDE_TOKEN")
    if not token:
        password = os.environ.get("DIVIDE_ADMIN_PASSWORD")
        if not password:
            sys.exit(
                "Set DIVIDE_TOKEN, or DIVIDE_ADMIN_PASSWORD (and optionally DIVIDE_ADMIN_SUB)."
            )
        response = client.post(
            "/api/v1/auth/login",
            json={"sub": os.environ.get("DIVIDE_ADMIN_SUB", "admin"), "password": password},
        )
        if response.status_code != 200:
            sys.exit(f"login failed: {response.status_code} {response.text[:120]}")
        token = response.json()["token"]
    client.headers["X-Divide-Token"] = token


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--scenario", required=True, help="scenario name or id")
    parser.add_argument("--api", default=DEFAULT_API_BASE)
    parser.add_argument("--timeout", type=float, default=1800, help="seconds to wait per phase")
    parser.add_argument("--keep", action="store_true", help="leave the range running afterwards")
    parser.add_argument("--force", action="store_true", help="continue past a failed preflight")
    args = parser.parse_args(argv)

    report = Report()
    print(f"Range dry run against {args.api}")
    with httpx.Client(base_url=args.api, timeout=60) as client:
        _login(client)
        run = RangeDryRun(client, report, timeout_s=args.timeout)
        try:
            scenario = run.resolve_scenario(args.scenario)
            run.preflight(scenario["id"], force=args.force)
            run.create_drill(scenario)
            if run.prepare():
                run.validate()
        except DryRunError:
            pass
        except KeyboardInterrupt:
            report.add("interrupted", False, "cleaning up before exit")
        finally:
            if args.keep and run.drill_id is not None:
                print(f"  [keep] range left running as drill {run.drill_id}; stop it from the UI.")
            else:
                run.cleanup()

    print(
        "\nRESULT:", "READY - safe to run the drill" if report.ok else "NOT READY - see FAIL lines"
    )
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
