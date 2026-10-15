# Range Preparation and Exercise Start

## Lifecycle

1. **Prepare range** reserves the shared environment and provisions the machines.
   The drill remains `scheduled`; `actual_start_at` stays empty.
2. The runner checks template availability, boot-disk presence, conservative RAM
   and full-clone disk capacity, and the shared VLAN bridge before cloning.
3. After guest seeding completes, required readiness probes run. Powered-on VMs
   alone no longer mark preparation complete.
4. **Start exercise** performs fresh checks and starts the exercise clock only
   when they pass. Participants still need enrollment and a started drill.
5. **Stop** also works during preparation and cancels/cleans that environment.

The environment remains reserved during preparation, validation, and the ready
state. Logging out is not a lifecycle transition. Operators can use VM console
access during preparation; participants cannot.

## API

- `GET /api/v2/drills/scenario-preflight/{scenario_id}`: read-only capacity checks.
- `POST /api/v2/drills/{id}/prepare`: prepare or retry failed provisioning.
- `GET /api/v2/drills/{id}/range-health`: current readiness diagnostics.
- `POST /api/v2/drills/{id}/start`: start an already prepared exercise.
- The legacy `start-from-scenario` URL now creates a scheduled lobby and starts
  preparation only. API clients must call `/start` separately after readiness.

Preparation errors require correction/cleanup before retrying. Validation errors
do not require recloning: use the map's readiness panel to inspect and recheck,
then Start exercise to validate again and begin play.

## Capacity and Validation

`DIVIDE_RANGE_HOST_RESERVE_MB` defaults to 2048. Preflight reserves running guest
allocations even if current usage is lower. No permanent SIEM VM is started or
budgeted by the runner. Storage budgeting uses full provisioned disk sizes;
this is conservative and does not promise thin-provisioning savings.

The Enterprise File Breach reference scenario checks DC01 TCP DNS/LDAP reachability,
both workstation RDP endpoints, seeded objectives/flags, completed guest setup,
and every expected machine running without a provisioning error. Port reachability
is not an authenticated desktop session, a DNS lookup, or proof of AD health.
Telemetry declarations are explicitly informational, not proof of delivered logs.

V2 runner rows persist `timeout_min=-1` because the drill lifecycle owns the
exercise timer. Legacy watchdog recovery skips those rows after an API restart.

## Verification and Remaining Work

- 56 focused lifecycle, runner, timeout, and Windows-seed tests passed.
- Two inline-handler wiring checks passed.
- Seven mocked PVE preflight cases passed (capacity, bridge, missing/locked
  templates, and unknown disk size), with no write calls.
- `tools/probes/range_preparation_selenium.py` checks the live preflight API,
  local UI lifecycle fixtures, and the live readiness dialog at desktop/mobile
  sizes. It does not launch or stop drills.
- Older static UI tests still expect removed tabs, sidebar, and workspace cards.
  Broader adapter tests also have stale clone/seed expectations; the full suite
  is not claimed green.

The read-only deployment check found all eight templates and the VLAN bridge,
but host RAM visibility is blocked by missing `Sys.Audit` on `/nodes/pve`.
Clone storage had about 51.7 GiB available against a conservative 224 GiB budget.
These values are point-in-time diagnostics, not permanent capacity assumptions.
No permissions were changed and no VMs or storage were deleted.

Three complete live prepare/play/reset cycles have not been executed. Remaining
milestones include template guest/driver certification, live telemetry delivery
checks, immutable run specifications, reset baselines, evidence-backed scoring,
and full debrief verification. This change is the preparation/readiness foundation,
not completion of those milestones.
