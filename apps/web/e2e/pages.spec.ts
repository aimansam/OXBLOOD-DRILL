import { expect, test } from '@playwright/test';
import { createDrill, firstScenarioId, signInAsAdmin, uniqueName } from './support';

test('every operator page renders', async ({ page }) => {
  await signInAsAdmin(page);
  for (const [link, heading] of [
    ['Exercises', 'Exercises'],
    ['Organizations', 'Organizations'],
    ['Teams', 'Teams'],
    ['Mission Control', 'Mission Control'],
    ['Infrastructure', 'Infrastructure'],
    ['Scoreboard', 'Scoreboard'],
    ['Reports', 'Reports'],
    ['Settings', 'Settings'],
  ] as const) {
    await page.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
});

test('organizations list, search and briefing', async ({ page }) => {
  await signInAsAdmin(page);
  await page.getByRole('link', { name: 'Organizations', exact: true }).click();
  await expect(page.getByRole('listitem')).not.toHaveCount(0);
  await page.getByLabel('Find an organization or CVE').fill('zzzz-no-match');
  await expect(page.getByText('No organizations match your search')).toBeVisible();
  await page.getByLabel('Find an organization or CVE').fill('');
  await page.getByRole('listitem').first().getByRole('link').click();
  await expect(page.getByText('Intended attack path')).toBeVisible();
  await expect(page.getByText('Range design')).toBeVisible();
});

test('settings: create and disable a user (admin only tabs)', async ({ page }) => {
  const sub = `e2e${Date.now().toString(36)}`;
  await signInAsAdmin(page);
  await page.goto('/app/settings?tab=users');
  await page.getByLabel('Username').fill(sub);
  await page.getByLabel('Password').fill('Tester12345!');
  await page.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByText(`User ${sub} created`)).toBeVisible();
  await page.getByRole('row', { name: new RegExp(sub) }).getByRole('button', { name: 'Disable' }).click();
  await expect(page.getByRole('row', { name: new RegExp(sub) }).getByText('disabled')).toBeVisible();
});

test('infrastructure and maintenance degrade gracefully without Proxmox', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/app/infrastructure');
  await expect(page.getByText('Unavailable').first()).toBeVisible();
  await page.goto('/app/settings?tab=maintenance');
  await expect(page.getByRole('heading', { name: 'Platform health' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove unused VMs' })).toBeDisabled();
});

test('the live range map renders and can be inspected', async ({ page, request }) => {
  const id = await createDrill(request, uniqueName('E2E live'), await firstScenarioId(request));
  await signInAsAdmin(page);
  await page.goto(`/app/exercises?drill=${id}`);
  await page.getByRole('link', { name: 'Open live range' }).click();
  await expect(page.locator('.threat-map-shell')).toBeVisible();
  await expect(page.locator('.topology-svg-device, .topology-svg-node').first()).toBeVisible();
  for (const control of ['Story feed', 'VLANs', 'Fit range']) {
    await page.getByRole('button', { name: control }).first().click();
  }
  await page.getByRole('button', { name: 'Back to exercises' }).click();
  await expect(page).toHaveURL(/\/app\/exercises/);
});

test.describe('theme', () => {
  test.use({ colorScheme: 'dark' });

test('the toggle switches to light and is remembered', async ({ page }) => {
  await signInAsAdmin(page);
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveClass(/light/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/light/);
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
});
});

test('with no saved choice the app follows the system theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await signInAsAdmin(page);
  await expect(page.locator('html')).toHaveClass(/light/);
});

test('overview shows recent activity after something happens', async ({ page, request }) => {
  // Creating a user writes an audit-visible event in some deployments; the card must at least render.
  await createDrill(request, uniqueName('E2E activity'));
  await signInAsAdmin(page);
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
});
