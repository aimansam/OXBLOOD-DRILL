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

## Between rounds
Finish the round, then restore the range from its baseline (stop and prepare it again) before
starting the next one. Starting a round requires the earlier ones to be finished.

## What is not automatic yet
- **Resetting the range between rounds** is a manual step.
- **Blue-team detection points** are awarded by a referee ("Detection" in the referee form); nothing
  scores blue automatically from alerts.
- **Flags are fixed strings**, the same for every team. Teams that share a flag will both score it;
  use the ledger and rate limit to spot this, and keep the rules of engagement written down.
- **Memory:** see the scenario RAM footprints before choosing a scenario for 20 players.
