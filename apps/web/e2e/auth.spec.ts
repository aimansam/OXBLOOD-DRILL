import { expect, test } from '@playwright/test';
import { ADMIN, signIn, signInAsAdmin } from './support';

test('anonymous visitors are sent to sign-in, and a wrong password is explained', async ({ page }) => {
  await page.goto('/app/');
  await expect(page).toHaveURL(/\/app\/login$/);
  await signIn(page, { sub: ADMIN.sub, password: 'not-the-password' });
  await expect(page.getByRole('alert')).toContainText(/invalid/i);
});

test('sign in lands on Overview and sign out returns to sign-in', async ({ page }) => {
  await signInAsAdmin(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/app\/login$/);
  await page.goto('/app/exercises');
  await expect(page).toHaveURL(/\/app\/login$/);
});

test('the retired classic URLs redirect into the app', async ({ page }) => {
  for (const old of ['/', '/login', '/drill/']) {
    await page.goto(old);
    await expect(page).toHaveURL(/\/app\/login$/);
  }
});

test('deep links survive a reload', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/app/exercises?view=archive');
  await expect(page.getByRole('heading', { name: 'Exercises' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Archive' })).toHaveAttribute('aria-selected', 'true');
});
