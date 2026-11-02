import { expect, test } from '@playwright/test';
import { adminToken, createDrill, firstScenarioId, signInAsAdmin, uniqueName } from './support';

test('operators create and revoke invitation links', async ({ page, request }) => {
  const id = await createDrill(request, uniqueName('E2E teams'), await firstScenarioId(request));
  await signInAsAdmin(page);
  await page.goto(`/app/teams?drill=${id}`);
  await page.getByRole('button', { name: 'New red link' }).click();
  await expect(page.getByText('RED link ready')).toBeVisible();
  await expect(page.getByLabel('Participant invitation link')).toHaveValue(/\/join#token=[\w-]{43}$/);
  await expect(page.getByText('Pending links (1)')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Link revoked')).toBeVisible();
});

test('an invited player registers once and lands on their mission screen', async ({ page, context, request }) => {
  const id = await createDrill(request, uniqueName('E2E invite'), await firstScenarioId(request));
  const token = await adminToken(request);
  const invite = await (await request.post(`/api/v2/drills/${id}/invitations`, { headers: { 'X-Divide-Token': token }, data: { side: 'blue' } })).json();

  // The secret is in the fragment, and survives the /join -> /app/join redirect.
  await page.goto(`/join#token=${invite.token}`);
  await expect(page).toHaveURL(/\/app\/join#token=/);
  await expect(page.getByText('BLUE TEAM')).toBeVisible();
  const name = `invitee${Date.now().toString(36)}`;
  await page.getByLabel('Username').fill(name);
  await page.getByLabel('Password').fill('Invitee12345!');
  await page.getByRole('button', { name: 'Create account & join' }).click();
  await expect(page).toHaveURL(/\/app\/mission$/);
  expect(page.url()).not.toContain('token=');

  // Single use.
  const second = await context.newPage();
  await second.goto(`/join#token=${invite.token}`);
  await expect(second.getByText('Link unavailable')).toBeVisible();
});

test('a missing or malformed token is unavailable', async ({ page }) => {
  await page.goto('/app/join');
  await expect(page.getByText('Link unavailable')).toBeVisible();
  await page.goto('/app/join#token=short');
  await expect(page.getByText('Link unavailable')).toBeVisible();
});
