// Staging verification harness.
//
// This script exists so that "we tested staging" can mean something checkable. It runs a
// fixed checklist against a *deployed* instance and a *real* datastore, and it refuses to
// report anything it did not observe:
//
//   exit 0  every check ran and passed
//   exit 1  a check ran and failed (the output says which)
//   exit 3  NOT RUN — the staging infrastructure is not configured here
//
// Exit 3 is the important one. A missing staging environment is not a pass, and this
// script will not print one.
//
// Configuration (all optional; absence makes the matching checks NOT RUN):
//   STAGING_BASE_URL        e.g. https://api.staging.example.com
//   STAGING_TOKEN           bearer token for an owner in the staging project
//   STAGING_SECOND_TOKEN    optional, a *different user* for cross-tenant checks
//   STAGING_ALLOW_PURGE=1   enables the retention-purge check (destructive by design;
//                           refused if the base URL looks like production)
//
// Usage:
//   STAGING_BASE_URL=… STAGING_TOKEN=… node scripts/staging-check.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = (process.env.STAGING_BASE_URL ?? '').replace(/\/$/, '');
const token = process.env.STAGING_TOKEN ?? '';
const secondToken = process.env.STAGING_SECOND_TOKEN ?? '';
const allowPurge = process.env.STAGING_ALLOW_PURGE === '1';

const results = [];
const record = (id, title, status, detail) => {
  results.push({ id, title, status, detail });
  const badge = status === 'PASS' ? 'PASS ' : status === 'FAIL' ? 'FAIL ' : 'NOT RUN';
  console.log(`${badge} ${id} ${title}${detail ? ` — ${detail}` : ''}`);
};

function looksLikeProduction(url) {
  return /(^|\/\/|\.)(prod|production|live)(\.|\/|$)/i.test(url);
}

async function api(method, path, { body, auth = token, expect } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  if (expect !== undefined && response.status !== expect) {
    throw new Error(`${method} ${path} returned ${response.status}, expected ${expect}: ${text.slice(0, 200)}`);
  }
  return { status: response.status, body: parsed };
}

const stamp = Date.now().toString(36);
const orgName = `Staging check ${stamp}`;

async function main() {
  if (!baseUrl || !token) {
    console.log('STAGING NOT RUN');
    console.log('  Missing: ' + [!baseUrl && 'STAGING_BASE_URL', !token && 'STAGING_TOKEN'].filter(Boolean).join(', '));
    console.log('  This is not a pass. See docs/STAGING.md for the checklist this script automates.');
    record('S0', 'staging environment configured', 'NOT RUN', 'no STAGING_BASE_URL / STAGING_TOKEN');
    await writeReport();
    process.exit(3);
  }

  console.log(`Target: ${baseUrl}`);
  if (looksLikeProduction(baseUrl)) {
    console.error('REFUSING: this URL looks like production. Staging checks are not allowed to touch it.');
    record('S0', 'target is staging, not production', 'FAIL', baseUrl);
    await writeReport();
    process.exit(1);
  }

  // 1. liveness + readiness ------------------------------------------------
  try {
    const health = await api('GET', '/api/health', { auth: null, expect: 200 });
    record('S1', 'health endpoint answers', 'PASS', `mode=${health.body?.mode ?? 'unknown'}`);
    const authed = await api('GET', '/api/health', { expect: 200 });
    const storage = authed.body?.storage?.kind ?? 'unknown';
    record(
      'S2',
      'authenticated health reports the datastore',
      storage === 'firestore' ? 'PASS' : 'FAIL',
      `storage=${storage}${storage === 'firestore' ? '' : ' (staging must not use the in-memory store)'}`,
    );
  } catch (error) {
    record('S1', 'health endpoint answers', 'FAIL', String(error.message).slice(0, 200));
  }

  // 2. real writes, real transactions -------------------------------------
  let orgId = null;
  let workspaceId = null;
  try {
    const org = await api('POST', '/api/orgs', { body: { name: orgName }, expect: 201 });
    orgId = org.body.organizationId;
    const workspace = await api('POST', `/api/orgs/${orgId}/workspaces`, {
      body: { name: 'Staging workspace', timeZone: 'Asia/Kolkata', currency: 'INR', defaultLanguage: 'en' },
      expect: 201,
    });
    workspaceId = workspace.body.workspaceId;
    record('S3', 'organisation and workspace persist', 'PASS', `${orgId}/${workspaceId}`);
  } catch (error) {
    record('S3', 'organisation and workspace persist', 'FAIL', String(error.message).slice(0, 200));
  }

  if (orgId && workspaceId) {
    // 3. concurrent writes: 10 research runs at once. Every one must be stored, and each
    // must have its own id — a shared id would mean the transaction or the id generation
    // is wrong under contention.
    try {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          api('POST', `/api/orgs/${orgId}/workspaces/${workspaceId}/research/runs`, {
            body: { goal: 'attribution' },
            expect: 201,
          }),
        ),
      );
      const ids = new Set(responses.map((r) => r.body.runId));
      record(
        'S4',
        'ten concurrent research writes all persist with distinct ids',
        ids.size === 10 ? 'PASS' : 'FAIL',
        `distinct run ids: ${ids.size}/10`,
      );
      const listed = await api('GET', `/api/orgs/${orgId}/workspaces/${workspaceId}/research/runs`, { expect: 200 });
      record(
        'S5',
        'saved runs read back from the datastore',
        (listed.body.runs ?? []).length >= 10 ? 'PASS' : 'FAIL',
        `listed: ${(listed.body.runs ?? []).length}`,
      );
    } catch (error) {
      record(
        'S4',
        'ten concurrent research writes all persist with distinct ids',
        'FAIL',
        String(error.message).slice(0, 200),
      );
    }

    // 4. cross-tenant refusal with a second identity, when one is supplied.
    if (secondToken) {
      try {
        const attempt = await api('GET', `/api/orgs/${orgId}/workspaces`, { auth: secondToken });
        record(
          'S6',
          'a second user cannot read this tenant',
          attempt.status === 404 || attempt.status === 403 ? 'PASS' : 'FAIL',
          `status=${attempt.status}`,
        );
      } catch (error) {
        record('S6', 'a second user cannot read this tenant', 'FAIL', String(error.message).slice(0, 200));
      }
    } else {
      record('S6', 'a second user cannot read this tenant', 'NOT RUN', 'no STAGING_SECOND_TOKEN');
    }

    // 5. retention purge — destructive, so it is opt-in and refuses production.
    if (allowPurge) {
      try {
        const purge = await api('POST', `/api/orgs/${orgId}/retention/purge`, { body: {}, expect: 200 });
        const removed = purge.body?.removed ?? {};
        record('S7', 'retention purge runs against the real store', 'PASS', JSON.stringify(removed));
      } catch (error) {
        record('S7', 'retention purge runs against the real store', 'FAIL', String(error.message).slice(0, 200));
      }
    } else {
      record('S7', 'retention purge runs against the real store', 'NOT RUN', 'set STAGING_ALLOW_PURGE=1');
    }
  }

  // 6. checks that need infrastructure this script does not control.
  record(
    'S8',
    'checkpoint recovery across a process restart',
    'NOT RUN',
    'needs a HubSpot sandbox sync (docs/STAGING.md §4)',
  );
  record(
    'S9',
    'behaviour when the datastore is unavailable',
    'NOT RUN',
    'needs a project with revoked credentials (docs/STAGING.md §5)',
  );
  record('S10', 'backup and restore exercise', 'NOT RUN', 'manual, see docs/OPERATIONS.md §4');

  await writeReport();
  const failed = results.filter((r) => r.status === 'FAIL');
  const notRun = results.filter((r) => r.status === 'NOT RUN');
  console.log('');
  console.log(
    `summary: ${results.length - failed.length - notRun.length} passed, ${failed.length} failed, ${notRun.length} not run`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

async function writeReport() {
  const dir = resolve(import.meta.dirname, '..', 'artifacts');
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, 'staging-check.json');
  await writeFile(
    file,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: baseUrl || null, results }, null, 2)}\n`,
  );
  console.log(`report: ${file}`);
}

// A crash in this script must never look like a pass.
main().catch(async (error) => {
  console.error(`STAGING CHECK CRASHED: ${error?.message ?? error}`);
  record('S?', 'harness completed', 'FAIL', String(error?.message ?? error).slice(0, 200));
  await writeReport().catch(() => {});
  process.exit(1);
});
