// Gate for `npm run verify`: the real server must boot in demo mode and enforce
// every guard we claim. Uses a fixed DEV_AUTH_TOKEN so the checks are deterministic.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = '8799';
const TOKEN = 'gate_dev_token_0123456789';
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ['server/server.mjs'], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    AUTH_MODE: 'dev',
    DEV_AUTH_TOKEN: TOKEN,
    DEV_AUTH_ROLE: 'owner',
    API_PORT: PORT,
    OPENAI_ADS_API_KEY: '',
    OPENAI_CONVERSIONS_API_KEY: '',
    OPENAI_PIXEL_ID: '',
    TRACK_ORIGINS: 'https://app.test',
    CONSENT_SECRET: 'gate-consent-secret-0123456789',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => (out += d.toString()));
child.stderr.on('data', (d) => (out += d.toString()));

const call = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: await res.json() };
};

function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}\n--- server log ---\n${out}`);
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try {
      await fetch(`${BASE}/api/health`);
      up = true;
      break;
    } catch {
      /* still booting */
    }
  }
  check(up, 'server did not start');

  // 1. health is public but shallow; details need auth.
  const anonHealth = await call('/api/health');
  check(anonHealth.status === 200, 'anonymous health should be 200');
  check(
    JSON.stringify(Object.keys(anonHealth.body).sort()) === '["mode","ok"]',
    `anonymous health leaked detail: ${JSON.stringify(anonHealth.body)}`,
  );
  const authHealth = await call('/api/health', { headers: { Authorization: `Bearer ${TOKEN}` } });
  check(authHealth.body.configuration?.adsKey === false, 'authenticated health should include configuration');
  console.log('ok  health: public {ok,mode}, details behind auth');

  // 2. protected routes reject anonymous callers.
  for (const path of ['/api/dataset?days=30', '/api/adgroups']) {
    const res = await call(path);
    check(res.status === 401, `${path} should reject anonymous callers, got ${res.status}`);
  }
  const anonPush = await call('/api/adgroups/adgrp_x/hints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hints: ['someone asking about gst filing'] }),
  });
  check(anonPush.status === 401, `anonymous push must be 401, got ${anonPush.status}`);
  check(anonPush.body.error.code === 'unauthenticated', 'anonymous push must report unauthenticated');
  console.log('ok  unauthenticated push rejected before any upstream call');

  // 3. a wrong token is not a valid token.
  const wrong = await call('/api/dataset', { headers: { Authorization: 'Bearer wrong_token_value' } });
  check(wrong.status === 401 && wrong.body.error.code === 'invalid_token', 'wrong token must be 401 invalid_token');
  console.log('ok  wrong token rejected');

  // 4. dataset falls back to demo with a valid token.
  const dataset = await call('/api/dataset?days=30', { headers: { Authorization: `Bearer ${TOKEN}` } });
  check(dataset.body.mode === 'demo', `dataset should be demo, got ${JSON.stringify(dataset.body)}`);
  console.log('ok  authenticated dataset falls back to demo without keys');

  // 5. track refuses a boolean consent and enforces the origin allowlist.
  const booleanConsent = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({ eventName: 'lead_created', eventId: 'x', sourceUrl: 'https://app.test/x', consent: true }),
  });
  check(booleanConsent.status === 403, `boolean consent must be 403, got ${booleanConsent.status}`);
  check(booleanConsent.body.error.code === 'consent_required', 'boolean consent must report consent_required');

  const badOrigin = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' },
    body: JSON.stringify({ eventName: 'lead_created', eventId: 'x', sourceUrl: 'https://evil.test/x' }),
  });
  check(badOrigin.status === 403 && badOrigin.body.error.code === 'origin_not_allowed', 'bad origin must be refused');
  console.log('ok  track: boolean consent refused, origin allowlist enforced');

  // 6. consent must be recorded first, then the id activates events.
  const consent = await call('/api/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({ granted: true }),
  });
  check(consent.status === 201 && consent.body.consentId, 'consent record should return an id');
  const withConsent = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({
      eventName: 'lead_created',
      eventId: 'x',
      sourceUrl: 'https://app.test/x',
      consentId: consent.body.consentId,
    }),
  });
  // No upstream keys here, so the CAPI call itself fails closed with 503.
  check(withConsent.status === 503, `a valid consent id should reach the CAPI stage, got ${withConsent.status}`);
  check(withConsent.body.error.code === 'missing_capi_key', 'CAPI stage should report the missing key');
  console.log('ok  valid consent id is accepted; event stops at the missing-key boundary');

  // 7. Body size limit. Sent through raw http so the declared Content-Length can
  //    lie about the payload; the server must reject before reading the body.
  const huge = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/api/track',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://app.test', 'Content-Length': '9999999' },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
      },
    );
    req.on('error', reject);
    req.write('{}');
    // The server answers 413 without waiting for the full body; close our side.
    req.setTimeout(2000, () => req.destroy());
    req.end();
  });
  check(huge.status === 413, `oversized body must be 413, got ${huge.status}`);
  console.log('ok  declared body size limit enforced');

  // 8. no key material in any response.
  const leak = JSON.stringify([anonHealth.body, authHealth.body, dataset.body, anonPush.body]);
  check(!/sk-|ak_live|ck_live/.test(leak), 'a response leaked key material');
  console.log('ok  no key material in any response');
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
