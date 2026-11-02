import { expect, test } from '@playwright/test';
import { createDrill, firstScenarioId, signInAsAdmin, uniqueName } from './support';

test('create an exercise from an organization through the wizard', async ({ page }) => {
  const title = uniqueName('E2E wizard');
  await signInAsAdmin(page);
  await page.getByRole('link', { name: 'Organizations', exact: true }).click();
  await page.getByRole('listitem').first().getByRole('link').click();
  await page.getByRole('button', { name: 'Create exercise' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('New exercise')).toBeVisible();
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Next' }).click();

  // No Proxmox in the test stack: one clear banner, details collapsed.
  await expect(dialog.getByText('Proxmox is not connected.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create scheduled' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).last().click();

  await expect(page).toHaveURL(/\/app\/exercises\?drill=\d+/);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
});

test('the wizard rejects more than 20 participants', async ({ page }) => {
  await signInAsAdmin(page);
  await page.getByRole('button', { name: 'New exercise' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('option').first().click();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByLabel('Max participants').fill('50');
  await expect(dialog.getByText('Enter 1 to 20 participants')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('listitem', { name: 'Setup' })).toHaveCount(0); // stayed on Details
  await expect(dialog.getByLabel('Max participants')).toBeVisible();
});

test('edit, duplicate and delete an exercise', async ({ page, request }) => {
  const title = uniqueName('E2E actions');
  const id = await createDrill(request, title, await firstScenarioId(request));
  await signInAsAdmin(page);
  await page.goto(`/app/exercises?drill=${id}`);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Max participants').fill('6');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('6 seats')).toBeVisible();

  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByText(`${title} (Copy)`).first()).toBeVisible();

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Exercise deleted')).toBeVisible();
});

test('a scheduled exercise with a scenario can be prepared; one without cannot', async ({ page, request }) => {
  const withScenario = await createDrill(request, uniqueName('E2E prep'), await firstScenarioId(request));
  const without = await createDrill(request, uniqueName('E2E noscenario'));
  await signInAsAdmin(page);
  await page.goto(`/app/exercises?drill=${withScenario}`);
  await expect(page.getByRole('button', { name: 'Prepare range' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
  await page.goto(`/app/exercises?drill=${without}`);
  await expect(page.getByRole('button', { name: 'Prepare range' })).toHaveCount(0);
});
