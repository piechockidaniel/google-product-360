import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Browser smoke tests against the self-contained demo (synthetic data, no Google).
 *
 *   npm run test:e2e              # builds, starts the demo on :8123 with its own database, runs the suite
 *   npx playwright test --ui      # interactive (from the repo root: -c e2e/playwright.config.ts)
 *
 * The demo server is started by Playwright itself (webServer) and torn down afterwards; the
 * database lives in a unique data/e2e-*.sqlite file so concurrent or interrupted runs do not
 * delete a database that the Playwright web server has already opened.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.E2E_PORT ?? 8123);
const runId = `${process.pid}-${Date.now()}`;
export const E2E_DB = process.env.E2E_DB_PATH ?? path.join(root, 'data', `e2e-${runId}.sqlite`);
export const BASE_URL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts/,
  globalSetup: path.join(here, 'global-setup.ts'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: path.join(root, 'test-results'),
  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `node --disable-warning=ExperimentalWarning dist/server/index.js`,
    cwd: root,
    url: `${BASE_URL}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      DEMO_MODE: 'true',
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_PATH: E2E_DB,
      SESSION_SECRET: 'e2e-only-session-secret-not-for-production',
      LOG_LEVEL: 'warn',
    },
  },
});
