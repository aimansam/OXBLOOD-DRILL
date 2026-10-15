# File Breach Investigation: Enterprise Standard

## Compact baseline

- Seven disposable VMs across four VLANs, sized for a constrained host.
- Red workstation, router, DMZ host, DC01, file server, backup server, and blue workstation.
- Static addresses and routed access are deterministic per run.
- Flags and objectives are seeded from the scenario catalog.
- Blue investigation evidence is seeded onto the blue workstation as a compact
  timeline bundle alongside native guest logs.
- No external SIEM is required. Legacy template names are retained until
  replacement images are certified; Linux clones remove the retired agent.
- Generated VMs are stopped and destroyed during cleanup.

## Upgrade track

### Phase 1: Range reliability

- Keep all Linux templates offline-bootable.
- Keep guest-agent seeding as the authoritative seed path.
- Validate every run for VM state, addresses, flags, objectives, and service readiness.
- Block concurrent clone and cleanup operations with the PVE lifecycle lock.

Acceptance: seven VMs provision, receive role data, and clean up with no orphaned VMs.

### Phase 2: Investigation telemetry

- Preserve authentication, web access, file access, network-flow, and system channels.
- Seed the Blue workstation with a scenario timeline and preserve local logs.
- Add scenario-specific event markers for web compromise, file access, staging, and backup access.
- Keep raw artifacts in MinIO with a run tag and retention policy.

Acceptance: blue can reconstruct source, first access, pivot, collection, and backup targeting from the investigation workstation.

### Phase 2.5: Lightweight evidence validation

- Keep Windows event logs locally; centralized Windows forwarding is not yet
  certified. Do not claim that a declared sink delivers these events.
- Validate the investigation bundle and a tagged local event during a live acceptance run.
- Preserve raw evidence and historical drill records during SIEM retirement.

Acceptance: the blue team can retrieve real guest evidence without an external
SIEM, and missing delivery is reported rather than marked ready.

### Phase 3: Evidence-based scoring

- Award objective credit from submitted flags and evidence, not flags alone.
- Record one detection and one containment milestone per participant.
- Detection response earns 25 / 15 / 5 points at <=5 / <=10 / >10 minutes.
- Containment response earns 40 / 25 / 10 points at <=10 / <=20 / >20 minutes.
- Store containment time and response points in score history for debrief reporting.
- Attach evidence to a specific objective and preserve it in the after-action report.
- Keep red and blue scoring independent.

Acceptance: two teams can receive different scores for the same flag count based on speed, evidence quality, and containment.

### Phase 4: Instructor control

- Add timed injects for suspicious login, web compromise, archive creation, and backup access.
- Allow pause, resume, reset, and replay from a clean scenario snapshot.
- Record every instructor action in the drill timeline.

Acceptance: an instructor can run the exercise repeatedly without manual PVE repair.

### Phase 5: Enterprise reporting

- Produce a debrief with topology, timeline, flags, evidence, team scores, and unresolved objectives.
- Export JSON and CSV for audit or learning-management integration.
- Include run ID, scenario version, template versions, VLANs, and cleanup status.

Acceptance: the report is sufficient for a repeatable internal exercise review without opening the PVE console.

## Explicit non-goals

- No VPN is required for the participant workflow.
- Participants use assigned range workstations, not personal machines.
- Production credentials, uncontrolled internet egress, and destructive ransomware behavior remain out of scope.
