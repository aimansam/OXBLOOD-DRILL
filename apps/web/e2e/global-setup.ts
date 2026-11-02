import { request } from '@playwright/test';
import { ADMIN, RED } from './support';

/** Seed the first admin and a red-team player. Safe to re-run against a reused stack. */
export default async function globalSetup() {
  const api = await request.newContext({ baseURL: 'http://localhost:5100' });
  const setup = await api.get('/api/v1/auth/setup');
  if ((await setup.json()).needs_setup) {
    const created = await api.post('/api/v1/auth/setup', { data: { sub: ADMIN.sub, password: ADMIN.password } });
    if (!created.ok()) throw new Error(`admin setup failed: ${created.status()} ${await created.text()}`);
  }
  const login = await api.post('/api/v1/auth/login', { data: ADMIN });
  const { token } = await login.json();
  // 409 means the player already exists from an earlier run.
  const red = await api.post('/api/v1/auth/users', { headers: { 'X-Divide-Token': token }, data: { ...RED, role: 'red' } });
  if (!red.ok() && red.status() !== 409) throw new Error(`red user failed: ${red.status()}`);
  await api.dispose();
}
