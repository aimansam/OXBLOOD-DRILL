# Scenario plan: Ledger Leak

Status: plan only, nothing built. Designed for 20 participants in 4 teams on a node with about 20 GiB
of RAM for the range.

## Story
A supplier portal in the DMZ leaks a ledger database. Red breaks in through the portal, finds
credentials, pivots to the internal app server, escalates to root and exfiltrates `ledger.db`. Blue
traces the intrusion from real logs and contains it.

## Rules that separate it from the shipped scenarios
- **Real weaknesses we build ourselves** (portal upload or SSRF flaw; app server with credential reuse
  and a sudo misconfiguration). Each stage has a solve script that proves the weakness works, run
  when the images are built. A stage without a passing solve script is not "verified" in the UI.
- **Per-team, per-round flags** derived from the team and the round and planted on every range reset
  through the guest agent, so a flag learned in round 1 is useless in round 2 and teams cannot share.
- **Blue is scored on facts.** Blue submits attacker IP, entry endpoint, compromised account and the
  persistence found. The platform knows the true values from the match. Containment is checked by a
  probe run from the Red machine that must fail after Blue acts.
- **Linux only in version 1.** No domain controller, so no 8 GiB Windows server. Windows is version 2.
- **Logs come from the real attack** (web access, auth, auditd). No hard-coded timeline.

## Stages
| # | Red step | Points |
|---|---|---|
| 1 | Foothold on the portal | 100 |
| 2 | Find credentials, SSH to the app server | 150 |
| 3 | Escalate to root | 200 |
| 4 | Exfiltrate `ledger.db`, submit its hash | 250 |

Blue earns up to about 1000 from four evidence answers, detection and containment, with the same
time decay and first-blood rules as the competition scoring.

## Format
Four teams of five. Two matches run in parallel on separate copies of the range: team A against C and
team B against D. Round 2 swaps sides, and scores add up. Roughly 90 minutes per round, 4 hours with
briefing and debrief.

## Memory budget (20 GiB)
| Machine | RAM per match |
|---|---|
| Router (Linux, snapshot-capable) | 0.5 GiB |
| Portal | 1 GiB |
| App server | 1 GiB |
| Data server | 1 GiB |
| Blue workstation | 1.5 GiB |
| Kali | 3 GiB |
| **Per match** | **8 GiB** |

Two matches use 16 GiB. The remaining 4 GiB covers the host reserve (the preflight keeps 2 GiB by
default, `range_host_reserve_mb`) and headroom for snapshots and spikes. Measure real use on the node
before the pilot; if it runs hot, cut the Kali to 2 GiB or run the matches in two shifts.

## Platform work this needs, in order
1. **Per-match range copies.** The competition model has teams and rounds but no notion of a match
   instance. A team must map to one range copy, with access and scoring following it.
2. **Per-team, per-round flags** planted on reset.
3. **Automatic verification**: solve scripts at build time, a containment probe at play time, and a
   check that the baseline matches the scenario version.
4. **Reproducible image builds** from scripts (the templates are hand-made today).
5. **Deeper reset check**: guest agent answers and the portal responds, not only "VM running".

Done so far: the runner can run **range copies** (`RunRequest.instance`). Copy N shifts every VLAN by
20 x (N-1), prefixes the short VM names with `M<N>-`, and has its own baselines (`snapshot_baselines.instance`).
Subnets and addresses stay the same because the VLANs keep copies apart. A scenario whose router is an
OPNsense image cannot make copies, since that image has its VLANs baked in; Ledger Leak therefore uses a
Linux router configured at seed time. Still to do: the drill-level team-to-match mapping and
provisioning one run per match.

Already in place: the range memory check in preflight (counts running guests plus a host reserve),
snapshot baselines built automatically on first prepare, and range reset between rounds.

## Before the real event
Dry run with two testers, then a pilot with four to six people, measuring RAM, reset time and how long
each stage takes. Only then 20 participants.

## Decisions still open
- One shared Kali per team (multi-user over xrdp) or one per player. Per player does not fit 20 GiB.
- Whether the data server is separate or folded into the app server to save 1 GiB.
