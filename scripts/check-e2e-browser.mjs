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

// Same rule as playwright.config.ts: an explicit binary wins, otherwise Playwright's own
// resolution is checked. Keeping the two in step is the point — a preflight that passed on
// a path the suite would ignore would be worse than no preflight.
const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || null;

let reason = null;
let resolved = override;

if (override) {
  if (!existsSync(override)) {
    reason = `PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a missing file: ${override}`;
    resolved = null;
  }
} else {
  let chromium = null;
  try {
    ({ chromium } = require('playwright-core'));
  } catch (error) {
    reason = `playwright-core is not installed: ${error?.message ?? error}`;
  }
  if (chromium) {
    resolved = chromium.executablePath?.() ?? null;
    if (!resolved) {
      reason = 'playwright could not resolve a Chromium executable path';
    } else if (!existsSync(resolved)) {
      reason = `Chromium is not installed at ${resolved} (run: npx playwright install chromium)`;
    }
  }
}

if (reason) {
  console.error(`E2E GATE: BLOCKED — ${reason}`);
  console.error('The browser suite did not run. This is not a pass.');
  process.exit(2);
}

console.log(`E2E GATE: BROWSER READY — ${resolved}`);
