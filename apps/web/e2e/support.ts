import { type APIRequestContext, type Page, expect } from '@playwright/test';

export const ADMIN = { sub: 'admin', password: 'Admin12345!' };
export const RED = { sub: 'redplayer', password: 'Player12345!' };

export async function signIn(page: Page, user: { sub: string; password: string }) {
  await page.goto('/app/login');
  await page.getByLabel('Username').fill(user.sub);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function signInAsAdmin(page: Page) {
  await signIn(page, ADMIN);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

export async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: ADMIN });
  return (await res.json()).token;
}

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const uniqueName = (prefix: string) => `${prefix} ${unique()}`;

/** Create a drill through the API (faster than the wizard when a test just needs one). */
export async function createDrill(request: APIRequestContext, title: string, scenarioId: number | null = null) {
  const token = await adminToken(request);
  const res = await request.post('/api/v2/drills', {
    headers: { 'X-Divide-Token': token },
    data: { title, drill_type: 'individual', duration_limit_minutes: 60, max_participants: 10, scenario_id: scenarioId },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).drill_id as number;
}

export async function firstScenarioId(request: APIRequestContext): Promise<number> {
  const res = await request.get('/api/v1/scenarios');
  return (await res.json()).items[0].id;
}
