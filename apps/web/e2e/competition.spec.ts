import { expect, test } from '@playwright/test';
import { adminToken, createDrill, createPlayer, enroll, firstScenarioId, playerToken, signIn, signInAsAdmin, uniqueName } from './support';

// The first catalog scenario is enterprise-file-breach; its red flags are known.
const RED_FLAG = 'FLAG{enterprise_dmz_foothold}';

test('a referee runs a two-team round and the scoreboard follows', async ({ page, request }) => {
  const drill = await createDrill(request, uniqueName('E2E competition'), await firstScenarioId(request));
  const reds = await createPlayer(request, 'red');
  const blues = await createPlayer(request, 'blue');
  await enroll(request, drill, reds.id, 'red');
  await enroll(request, drill, blues.id, 'blue');

  // --- referee: teams, rounds
  await signInAsAdmin(page);
  await page.goto(`/app/competition?drill=${drill}`);
  await page.getByLabel('Number of teams').selectOption('2');
  await page.getByRole('button', { name: 'Create teams' }).click();
  await expect(page.getByText('Teams created')).toBeVisible();

  await page.getByLabel('Add a player to Alpha').selectOption({ label: `${reds.sub}` });
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await expect(page.getByText('1 of 2 enrolled players are in a team.')).toBeVisible(); // refresh finished
  await page.getByLabel('Add a player to Bravo').selectOption({ label: `${blues.sub}` });
  await page.getByRole('button', { name: 'Add', exact: true }).nth(1).click();
  await expect(page.getByText('2 of 2 enrolled players are in a team.')).toBeVisible();

  await page.getByRole('tab', { name: 'Rounds' }).click();
  await page.getByRole('button', { name: 'Plan 2 rounds (swap sides)' }).click();
  await expect(page.getByText('Round 2')).toBeVisible();
  await page.getByRole('button', { name: 'Start round' }).click();
  await expect(page.getByText('Round 1 started')).toBeVisible();

  // --- player: scores once, not twice
  const token = await playerToken(request, reds);
  const submit = async () =>
    (await request.post('/api/v2/submissions?user_id=0', { headers: { 'X-Divide-Token': token }, data: { drill_id: drill, lab_flag_id: 0, flag_value: RED_FLAG, hints_used: 0 } })).json();
  const first = await submit();
  expect(first.is_correct).toBe(true);
  expect(first.first_blood).toBe(true);
  const again = await submit();
  expect(again.already_captured).toBe(true);
  expect(again.points_earned).toBe(0);

  // --- referee: penalty needs a reason, then shows in the ledger and the totals
  await page.getByRole('tab', { name: 'Scoreboard and referee' }).click();
  await expect(page.getByText(reds.sub)).toHaveCount(0); // players are listed under "Top players", collapsed
  await page.getByLabel('Team', { exact: true }).selectOption({ label: 'Alpha' });
  await page.getByLabel('Type', { exact: true }).selectOption('penalty');
  await page.getByLabel('Points', { exact: true }).fill('20');
  await expect(page.getByRole('button', { name: 'Record' })).toBeDisabled(); // no reason yet
  await page.getByLabel('Reason').fill('broke the shared DNS');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('Penalty recorded')).toBeVisible();
  await expect(page.getByText('broke the shared DNS')).toBeVisible();
  const total = page.getByRole('row', { name: /Alpha/ }).locator('td').last();
  await expect(total).toHaveText(String(first.points_earned + first.first_blood_bonus - 20));

  // --- freeze: late points are hidden from players, visible to the referee
  const headers = { 'X-Divide-Token': await adminToken(request) };
  await request.put(`/api/v2/drills/${drill}/rounds/1/freeze`, { headers, data: { freeze_at: new Date(Date.now() - 60_000).toISOString() } });
  const player = await (await request.get(`/api/v2/drills/${drill}/scoreboard`, { headers: { 'X-Divide-Token': token } })).json();
  const referee = await (await request.get(`/api/v2/drills/${drill}/scoreboard`, { headers })).json();
  expect(player.frozen).toBe(true);
  expect(referee.frozen).toBe(false);
  const alpha = (b: { teams: { name: string; total: number }[] }) => b.teams.find((t) => t.name === 'Alpha')?.total ?? 0;
  expect(alpha(player)).toBeLessThan(alpha(referee) + 1); // the frozen view never shows more than the live one
});

test('a player sees their team, side and the standings on the mission screen', async ({ page, request }) => {
  const drill = await createDrill(request, uniqueName('E2E player view'), await firstScenarioId(request));
  const red = await createPlayer(request, 'red');
  const blue = await createPlayer(request, 'blue');
  await enroll(request, drill, red.id, 'red');
  await enroll(request, drill, blue.id, 'blue');
  const headers = { 'X-Divide-Token': await adminToken(request) };
  const teams = (await (await request.post(`/api/v2/drills/${drill}/teams`, { headers, data: { count: 2 } })).json()).teams;
  await request.put(`/api/v2/drills/${drill}/teams/${teams[0].id}/members/${red.id}`, { headers });
  await request.put(`/api/v2/drills/${drill}/teams/${teams[1].id}/members/${blue.id}`, { headers });
  await request.post(`/api/v2/drills/${drill}/rounds/plan`, { headers, data: { rounds: 2 } });
  await request.post(`/api/v2/drills/${drill}/rounds/1/start`, { headers });

  await signIn(page, red);
  await expect(page.getByText('Alpha').first()).toBeVisible();
  await expect(page.getByText(/Round 1: you play red/)).toBeVisible();
  await expect(page.getByRole('row', { name: /Bravo/ })).toBeVisible();

  // The other side's flags do not score for a team on the wrong side.
  const blueToken = await playerToken(request, blue);
  const wrong = await (await request.post('/api/v2/submissions?user_id=0', { headers: { 'X-Divide-Token': blueToken }, data: { drill_id: drill, lab_flag_id: 0, flag_value: RED_FLAG, hints_used: 0 } })).json();
  expect(wrong.is_correct).toBe(false);
});
