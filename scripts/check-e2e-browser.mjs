// Preflight for the browser gate.
//
// A release gate must be able to say "blocked". Playwright exits 1 when a browser is
// missing, but a CI job can accidentally treat that as "nothing to run" or someone reads
// a skipped suite as a pass. This script answers one question with an explicit status:
//
//   exit 0  BROWSER READY        — a real Chromium is installed; run `npm run e2e`
//   exit 2  BROWSER UNAVAILABLE  — cannot run here; the release gate is BLOCKED
//
// Exit 2 (not 0) is the point: a missing browser must fail the gate loudly, never be
// mistaken for success.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let chromium = null;
let reason = null;
try {
  ({ chromium } = require('playwright-core'));
} catch (error) {
  reason = `playwright-core is not installed: ${error?.message ?? error}`;
}

if (chromium) {
  const executable = chromium.executablePath?.();
  if (!executable) {
    reason = 'playwright could not resolve a Chromium executable path';
  } else if (!existsSync(executable)) {
    reason = `Chromium is not installed at ${executable} (run: npx playwright install chromium)`;
  }
}

if (reason) {
  console.error(`E2E GATE: BLOCKED — ${reason}`);
  console.error('The browser suite did not run. This is not a pass.');
  process.exit(2);
}

console.log(`E2E GATE: BROWSER READY — ${chromium.executablePath()}`);
