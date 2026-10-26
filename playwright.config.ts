// Browser tests, kept separate from vitest: they need a real Chromium, which is not
// installed in every environment (`npx playwright install chromium`). `npm run verify`
// therefore does not include them — see docs/CONNECTORS.md for what has actually been
// run and where.
//
// Two servers, because the browser must never talk to a provider directly: Vite proxies
// /api to the API process on 8787.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts/,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node server/server.mjs',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: true,
      timeout: 30_000,
      env: { AUTH_MODE: 'dev', API_PORT: '8787' },
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
