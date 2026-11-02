"""Prometheus alert rules stay valid and wired into the stack."""

from __future__ import annotations

from pathlib import Path

import yaml

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"


def test_alert_rules_parse_and_have_required_fields() -> None:
    doc = yaml.safe_load((DEPLOY / "prometheus" / "alerts.yml").read_text())
    rules = [rule for group in doc["groups"] for rule in group["rules"]]
    names = {rule["alert"] for rule in rules}
    assert {"ApiDown", "ApiHighErrorRate", "RangeRunFailed"} <= names
    for rule in rules:
        assert rule["expr"].strip()
        assert rule["labels"]["severity"] in {"critical", "warning", "info"}
        assert rule["annotations"]["summary"]


def test_rules_are_loaded_by_prometheus_and_mounted_in_compose() -> None:
    config = yaml.safe_load((DEPLOY / "prometheus" / "prometheus.yml").read_text())
    assert "/etc/prometheus/alerts.yml" in config["rule_files"]
    compose = yaml.safe_load((DEPLOY / "docker-compose.yml").read_text())
    volumes = compose["services"]["prometheus"]["volumes"]
    assert any(v.startswith("./prometheus/alerts.yml:/etc/prometheus/alerts.yml") for v in volumes)
