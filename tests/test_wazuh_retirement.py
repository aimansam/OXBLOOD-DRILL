"""The maintained catalog cannot reintroduce the retired SIEM dependency."""
import json
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]


def test_catalog_has_no_wazuh_sink_or_objective():
    for path in (ROOT / "examples/scenarios").glob("*.yaml"):
        spec = yaml.safe_load(path.read_text())["spec"]
        assert all(sink["type"] != "wazuh" for sink in spec.get("telemetry", {}).get("sinks", []))
        assert "wazuh" not in str(spec.get("objectives", {})).lower()


def test_schema_rejects_retired_sink():
    scenario = yaml.safe_load((ROOT / "examples/scenarios/enterprise-file-breach.scenario.yaml").read_text())
    schema = json.loads((ROOT / "schemas/scenario.schema.json").read_text())
    validator = Draft202012Validator(schema)
    assert not list(validator.iter_errors(scenario))
    scenario["spec"]["telemetry"]["sinks"].append({"type": "wazuh", "endpoint": "retired:1514"})
    assert any("wazuh" in error.message for error in validator.iter_errors(scenario))
