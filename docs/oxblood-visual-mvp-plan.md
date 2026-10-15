# OxBlood Visual MVP Plan

Goal: make OxBlood Drill feel like a live cyber range, not a text-heavy admin panel. The UI should communicate scenario state, role intent, VM access, and scoring at a glance with purposeful graphics.

## Principles

- Prefer visual state over explanatory copy.
- Make every graphic operational: topology, access, scoring, progress, readiness.
- Keep the corporate dark style, but reduce dense paragraphs.
- Use role-specific views so Red, Blue, and Admin do not see the same screen.
- Keep custom scenario images optional; reserve clean media slots for later assets.

## Phase 1: Scenario Topology Hero

Build a large topology graphic for the Scenario tab.

- Show networks as lanes: red, DMZ/shared, blue.
- Show assets as nodes: attacker, router, file server, log aggregator, blue console.
- Draw directional links between nodes.
- Add node badges for `ready`, `booting`, `offline`, `seeded`, and `error`.
- Add network labels and CIDR blocks directly on the lanes.
- Keep it readable on desktop and compact on mobile.

Primary impact: the drill instantly looks like a cyber range.

## Phase 2: VM Access Tiles

Replace text-heavy access lists with machine tiles.

- One tile per VM/asset.
- Include role, IP, network, power state, seed state, and console/open action.
- Red users see attacker machine plus allowed target hints.
- Blue users see blue console and log sources.
- Admin sees all machines with cleanup/retry actions.
- Disable buttons when VM is not ready, booting, or user role lacks access.

Primary impact: users know where to start without reading the whole briefing.

## Phase 3: Role Mission Pages

Make Red and Blue views visually distinct.

Red should see:
- Start here
- Target hints
- Attacker machine
- Flag submit

Blue should see:
- Start here
- Log source
- Detection objectives
- Blue console
- Evidence notes

Use icon-led mission cards and short action labels. Keep briefing details available, but secondary.

Primary impact: role pages feel guided and game-ready.

## Phase 4: Live Drill Status Strip

Add a compact visual status strip at the top of an active drill.

- Timer
- Drill state
- Active teams
- VM readiness
- Flags solved
- Current phase
- Provision/cleanup state if relevant

Use meters, pills, and small progress visuals instead of long text blocks.

Primary impact: operators can understand drill health in seconds.

## Phase 5: Provision Flow Graphic

Upgrade the create-drill wizard provision step.

- Visual steps: templates, networks, clone VMs, seed files, boot, ready.
- Show current step, completed steps, failed step, and retry action.
- Surface lock/collision status clearly when another provision is running.
- Offer cleanup action for detected leftover VMs before retry.

Primary impact: provisioning feels controlled, not mysterious.

## Phase 6: Scoring Progress Lanes

Turn objectives and flags into a visual progress map.

- Display objectives as lanes or checkpoints.
- Show solved/unsolved flags with points.
- Highlight first blood.
- Show Red and Blue progress separately where applicable.
- Keep raw submissions available below for operators.

Primary impact: scoring becomes readable during live play.

## Phase 7: Scenario Catalog Cards

Improve catalog browsing without forcing generated art.

- One large scenario card at a time in the create wizard.
- Empty poster/media slot ready for future uploaded image.
- Show difficulty stripe, asset count, network count, objective count, flag count.
- Include mini topology preview where scenario data is available.
- Keep title and summary short.

Primary impact: scenario selection feels curated instead of form-based.

## Phase 8: Report Graphics

Add visual debrief summaries.

- Flags solved over time.
- Team score bars.
- Objective completion.
- First blood markers.
- VM/provision events.
- Evidence notes for Blue.

Primary impact: the drill has a satisfying post-exercise artifact.

## Suggested Implementation Order

1. Scenario topology hero.
2. VM access tiles.
3. Role mission pages.
4. Live drill status strip.
5. Provision flow graphic.
6. Scoring progress lanes.
7. Scenario catalog card polish.
8. Report charts.

## Current Status

Implemented in the first visual MVP pass:

- Full-width live drill status strip.
- Scenario topology hero with network lanes, legend, and node cards.
- VM access machine tiles with grouped Red, Blue, and Shared summaries.
- Role mission foundation for Red and Blue users.
- Create-drill provision flow graphic.
- Scoring summary ring and objective progress lanes.
- Scenario catalog mini-topology preview.
- Report summary graphics.

Still incomplete or shallow:

- Topology nodes show live telemetry by scenario role, but duplicate/multi-instance role matching still needs refinement.
- Reports include lightweight HTML/CSS charts, but not a full charting library or exported visual report artifact.
- Red and Blue mission pages have stronger action-card dashboards, but still need browser QA and content tuning.
- Access tiles use fallback text when backend seed/status fields are unavailable.
- Scenario media slots can render an optional image field, but uploaded image management is not built yet.
- Browser screenshot QA has not been added for desktop/mobile visual regression.

## Next Polish Pass

1. Live topology telemetry
   - Done: merge `/drills/{id}/access` and range-health data into topology nodes.
   - Done: show node power state, IP, and seed state directly on the topology.
   - Remaining: exact matching for duplicate roles and multiple VM instances.
   - Highlight failed or booting VMs in-place.

2. Real report charts
   - Done: add flags-over-time chart.
   - Done: add team score bars.
   - Done: add objective completion chart.
   - Done: add first-blood summary markers.
   - Remaining: richer report export and chart interaction.

3. Stronger Red and Blue mission dashboards
   - Done: Red action cards for attacker console, target, and objectives.
   - Done: Blue action cards for console, telemetry, detections, and evidence notes.
   - Remaining: content tuning after browser review.

4. Better provision failure recovery
   - Done: show failed provision step.
   - Done: show lock/collision reason when returned by the API.
   - Done: offer cleanup/setup CTA before retry.
   - Remaining: inline list of exact leftover VM IDs inside the wizard.
   - Disable unsafe retry/start actions while locks or workers are active.

5. Scenario image support
   - Done: support optional `image`, `image_url`, `media`, `metadata.image`, or `metadata.image_url` fields.
   - Done: render custom scenario images in catalog/detail slots.
   - Remaining: upload/manage image flow.
   - Keep topology fallback when no image exists.

6. Visual QA
   - Add Playwright screenshot checks for dashboard, drill detail, create wizard, scenario tab, access tab, and participant role views.
   - Check desktop and mobile widths.
   - Add guards for overflow, clipped buttons, and unreadable tabs.

## MVP Acceptance

- Admin can open a drill and understand topology, VM readiness, team state, and score without reading paragraphs.
- Red can identify the attacker machine, first target, and flag submit path immediately.
- Blue can identify log source, console, detection objectives, and evidence notes immediately.
- Provisioning failures show the failed step and next action visually.
- Completed drills produce at least one graphical report summary.
