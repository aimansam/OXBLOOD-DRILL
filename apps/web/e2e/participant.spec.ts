import { expect, test } from '@playwright/test';
import { RED, adminToken, createDrill, firstScenarioId, signIn, uniqueName } from './support';

test('a player sees only their mission screen and cannot reach operator pages', async ({ page }) => {
  await signIn(page, RED);
  await expect(page).toHaveURL(/\/app\/mission$/);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  for (const path of ['/app/settings', '/app/infrastructure', '/app/teams']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/app\/mission$/);
  }
});

test('an enrolled player sees the waiting state for a scheduled exercise', async ({ page, request }) => {
  const token = await adminToken(request);
  const headers = { 'X-Divide-Token': token };
  const users = await (await request.get('/api/v1/auth/users', { headers })).json();
  const rows = Array.isArray(users) ? users : (users.items ?? users.users);
  const player = rows.find((u: { sub: string }) => u.sub === RED.sub);
  // One scheduled exercise at a time keeps the mission screen deterministic.
  const existing = await (await request.get('/api/v2/drills', { headers })).json();
  for (const d of existing.drills.filter((x: { status: string }) => x.status === 'scheduled')) {
    await request.delete(`/api/v2/drills/${d.id}`, { headers });
  }
  const id = await createDrill(request, uniqueName('E2E mission'), await firstScenarioId(request));
  const enrolled = await request.post(`/api/v2/drills/${id}/participants`, { headers, data: { user_id: player.id, role: 'red' } });
  expect(enrolled.ok()).toBeTruthy();

  await signIn(page, RED);
  await expect(page.getByRole('heading', { name: /Waiting for operator|Range preparing/ })).toBeVisible();
  await expect(page.getByText('RED TEAM // ASSIGNED')).toBeVisible();
});
