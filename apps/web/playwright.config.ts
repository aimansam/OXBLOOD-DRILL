import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const python = process.env.E2E_PYTHON ?? 'python3';
const redis = process.env.DIVIDE_REDIS_URL ?? 'redis://127.0.0.1:6399/0';
const db = process.env.E2E_DB ?? '/tmp/oxblood-e2e.sqlite';

// A throwaway stack: the real API (SQLite + the mock Proxmox adapter) behind the real Flask portal,
// serving the production build. Needs a Redis at DIVIDE_REDIS_URL and `npm run build` done first
// (`npm run test:e2e` does both).
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1, // one shared database
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://localhost:5100',
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `rm -f ${db} && ${python} -m alembic upgrade head && ${python} -m uvicorn app.main:app --port 8100`,
      cwd: path.join(repo, 'apps/api'),
      url: 'http://localhost:8100/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      env: {
        DIVIDE_DB_URL: `sqlite+aiosqlite:///${db}`,
        DIVIDE_REDIS_URL: redis,
        DIVIDE_SCENARIOS_DIR: path.join(repo, 'examples/scenarios'),
      },
    },
    {
      command: `${python} -m flask --app flask_app run --port 5100`,
      cwd: path.join(repo, 'apps/portal'),
      url: 'http://localhost:5100/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'ignore',
      env: { API_BACKEND: 'http://127.0.0.1:8100', WEB_DIR: path.join(repo, 'apps/web/dist') },
    },
  ],
});
