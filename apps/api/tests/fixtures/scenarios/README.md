Frozen copies of two retired example scenarios, kept only as test inputs.

- `red-vs-blue-baseline`: 6 VMs, a two-NIC router and three zones; pins the multi-network bridge/clone logic in `test_f3_networks.py`.
- `first-live-drill`: single-VM drill used by `test_day1_wizard_flow.py`.

They are not part of the shipped catalog, so CI's `validate_scenario.py examples/scenarios/` does not cover them; they still have to validate against `schemas/scenario.schema.json`.
