# Running a team competition

A drill can hold up to **20 players in 2, 4 or 6 teams**. Teams swap sides between rounds, so every
team attacks once and defends once; points from all rounds are added up.

## Before the event
1. Create the exercise from an organization (Organizations → Create exercise).
2. **Competition → Teams**: create the teams (4 is typical), then add players. Players can also join
   by invitation link; use *New invitation link* on a team card so they land in the right team.
3. **Competition → Rounds**: *Plan 2 rounds*. Round 1 has the first half of the teams as red and the
   second half as blue; round 2 swaps them. Optionally set a **freeze time** for each round.
4. Prepare and start the exercise as usual (Exercises → Prepare range, then Start).

## During a round
- **Start round** makes the team sides live: each player sees the machines of their team's side.
- Players submit flags on the live map. A flag scores **once per team per round**, only for the side
  the team plays, with the usual time decay. The first team to capture a flag in a round gets a
  25% bonus. More than 10 attempts a minute are refused.
- Referees use **Scoreboard and referee** to add or remove points. A written reason is mandatory and
  every change stays in the ledger with the referee's name and time.
- After a round's **freeze time**, players see the scoreboard as it was at that moment. Referees
  always see live points. Finishing the round reveals everything.
- Ties are broken by whichever team reached its score first.

## Flags per round
Starting a round gives every flag that lives on a machine a new value, `FLAG{<name>_r<round>_<hex>}`,
derived from a per-drill secret. The value is written to the machine first and saved only when that
worked, so a flag whose planting failed keeps its old value (the card then offers **Re-plant flags**).
Flags with no machine, or drills with no prepared range, are left alone. Run **Reset range** before the
round: a reset rolls the machines back to their baseline, which holds the scenario's original files.
A player who submits a previous round's value is told it is from an earlier round.

## Captains
Each team has one captain: the first player added is elected automatically, and a referee can change
it on the Teams tab ("Make captain"). When the captain leaves the team, the next member takes over;
an empty team has none. While a team plays **Blue**, only its captain can submit answers; the others
see who the captain is. **Red** submissions are open to every member (the per-minute limit still
applies). A team without a valid captain has no restriction.

## Between rounds
Finish the round, then press **Reset range** on the Rounds tab (or `POST /api/v2/drills/{id}/range/reset`).
Every machine rolls back to its `clean-baseline` snapshot, boots, and is checked; the drill stays as it
is. The next round cannot start while the reset is running or after it failed. Starting a round also
requires the earlier ones to be finished.

Reset needs snapshot baselines for every machine. Set `provisioning.auto_baseline: true` in the
scenario and the first prepare builds them (see `examples/scenarios/README.md`). A range cloned
without baselines cannot be reset in place; the reset refuses and names the machines.

## What is not automatic yet
- **Flags are per round, not per team.** Starting a round plants fresh values on the machines (guest
  agent) and saves them; round 1's values stop scoring. Teams that attack the same machine in the same
  round still share its value. Per-team values need one range copy per match.
- **The reset check stops at the network:** after a reset it waits (up to 150 s) for every guest agent
  to report the address the scenario gives that machine, and fails naming the machine otherwise. The
  OPNsense router has no agent and is skipped. It does not test that services answer; do that from
  the Blue workstation before the first round.
- **Blue-team detection points** are awarded by a referee ("Detection" in the referee form); nothing
  scores blue automatically from alerts.
- **Flags are fixed strings**, the same for every team. Teams that share a flag will both score it;
  use the ledger and rate limit to spot this, and keep the rules of engagement written down.
- **Memory:** see the scenario RAM footprints before choosing a scenario for 20 players.
