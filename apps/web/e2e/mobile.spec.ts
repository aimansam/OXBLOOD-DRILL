import { expect, test } from '@playwright/test';
import { RED, signIn, signInAsAdmin } from './support';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true });

const noHorizontalScroll = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('operator pages fit a phone and the menu opens', async ({ page }) => {
  await signInAsAdmin(page);
  for (const path of ['/app/', '/app/exercises', '/app/organizations', '/app/teams', '/app/mission-control', '/app/settings']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await noHorizontalScroll(page), path).toBeLessThanOrEqual(1);
  }
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
});

test('the player mission screen fits a phone', async ({ page }) => {
  await signIn(page, RED);
  await expect(page).toHaveURL(/\/app\/mission$/);
  expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(1);
});
