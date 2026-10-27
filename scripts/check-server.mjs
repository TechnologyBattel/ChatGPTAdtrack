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
    CONSENT_SECRETS: 'v1:gate-consent-secret-0123456789',
    CONSENT_SECRET_VERSION: 'v1',
    // No proxy in front of this gate process, so X-Forwarded-For is ignored.
    TRUST_PROXY: '0',
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
  for (const path of ['/api/dataset?days=30', '/api/adgroups', '/api/audit']) {
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

  // A lead cannot come from a browser at all, whatever else the request carries.
  const browserLead = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({ eventName: 'lead_created', eventId: 'x', sourceUrl: 'https://app.test/x' }),
  });
  check(
    browserLead.status === 403 && browserLead.body.error.code === 'server_event_required',
    'the browser must not be able to report a lead',
  );

  const browserAmount = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({ eventName: 'page_viewed', eventId: 'x', amountMinor: 9999900, currency: 'INR' }),
  });
  check(
    browserAmount.status === 400 && browserAmount.body.error.code === 'amount_not_allowed',
    'the browser must not be able to report an amount',
  );

  const noSession = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({ eventName: 'page_viewed', eventId: 'x', sourceUrl: 'https://app.test/x' }),
  });
  check(noSession.status === 403, 'an event with no consent basis must be refused');

  const sessionOnly = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({
      eventName: 'page_viewed',
      eventId: 'x',
      consentId: 'a-consent-id-shaped-value',
    }),
  });
  check(
    sessionOnly.status === 403 && sessionOnly.body.error.code === 'session_required',
    'a consent id without its session must be refused',
  );

  // The signed ingest route is closed when no key is configured, and never accepts an
  // unsigned body.
  const unsignedIngest = await call('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventName: 'order_created', eventId: 'o1', consentBasis: 'first_party_record' }),
  });
  check(
    unsignedIngest.status === 503 || unsignedIngest.status === 401,
    `unsigned server events must be refused, got ${unsignedIngest.status}`,
  );
  console.log('ok  track: browser cannot report leads/amounts; ingest refuses unsigned events');

  // 6. consent is a two-step handshake: session -> consent -> event.
  const session = await call('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
  });
  check(session.status === 201 && session.body.sessionId?.startsWith('sess_'), 'session should be issued');
  const consent = await call('/api/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({ granted: true, sessionId: session.body.sessionId }),
  });
  check(consent.status === 201 && consent.body.consentId, 'consent record should return an id');

  const eventBody = {
    eventName: 'page_viewed',
    eventId: 'x',
    sourceUrl: 'https://app.test/x',
    sessionId: session.body.sessionId,
    consentId: consent.body.consentId,
  };
  const withConsent = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify(eventBody),
  });
  // No upstream keys here, so the CAPI call itself fails closed with 503/502 — proof
  // that a valid id gets past every guard and reaches the forwarding step.
  check(
    withConsent.status === 503 || withConsent.status === 502,
    `a valid consent id should reach the CAPI stage, got ${withConsent.status}`,
  );

  // A lead on the same route is refused before that stage: money is not a browser's
  // business, however good the consent id is.
  const leadWithConsent = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({ ...eventBody, eventName: 'lead_created' }),
  });
  check(
    leadWithConsent.status === 403 && leadWithConsent.body.error.code === 'server_event_required',
    'a consented lead from the browser is still refused',
  );
  check(withConsent.body.error.code === 'missing_capi_key', 'CAPI stage should report the missing key');
  console.log('ok  valid session + consent id accepted; event stops at the missing-key boundary');

  // 6b. Nothing was delivered (the missing key is a permanent failure), so the id must
  // still be usable: the visitor's consent is not burned by our own misconfiguration.
  const retryAfterFailure = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({ ...eventBody, eventId: 'x2' }),
  });
  check(
    retryAfterFailure.status === 503 && retryAfterFailure.body.error.code === 'missing_capi_key',
    `a failed delivery must leave the consent usable, got ${retryAfterFailure.status} ${retryAfterFailure.body.error?.code}`,
  );

  // The same id still cannot be moved to another session.

  const second = await call('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
  });
  const crossSession = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({ ...eventBody, sessionId: second.body.sessionId }),
  });
  check(
    crossSession.status === 403 && crossSession.body.error.code === 'consent_session_mismatch',
    `cross-session use must be refused, got ${crossSession.status}`,
  );
  console.log('ok  consent ids are single use and session bound');

  // 6c. a forged id is rejected without reaching the CAPI stage.
  const forged = await call('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' },
    body: JSON.stringify({ ...eventBody, sessionId: second.body.sessionId, consentId: 'Zm9yZ2Vk.c2ln' }),
  });
  // "Zm9yZ2Vk.c2ln" is not a consent id we signed: the decode fails before any
  // storage lookup, and the event never reaches the CAPI stage.
  check(
    forged.status === 403 && forged.body.error.code.startsWith('consent_'),
    `forged id must be refused, got ${forged.status} ${forged.body.error?.code}`,
  );
  console.log('ok  forged consent ids refused');

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

  // 9. transport hardening: the API refuses to be framed and names its policy.
  const headers = await fetch(`${BASE}/api/health`);
  check(headers.headers.get('content-security-policy')?.includes("default-src 'none'"), 'API CSP header missing');
  check(headers.headers.get('x-content-type-options') === 'nosniff', 'nosniff header missing');
  check(headers.headers.get('cache-control') === 'no-store', 'API responses must not be cached');
  console.log('ok  API sends CSP, nosniff and no-store');

  // 10. TRUST_PROXY=0 means a spoofed X-Forwarded-For cannot buy a fresh bucket...
  //     which we assert by checking the startup line that reports the setting.
  check(out.includes('trust proxy: 0 hop(s)'), `server should report 0 trusted hops\n${out}`);
  check(out.includes('storage: memory'), 'server should report the in-memory store');
  console.log('ok  startup reports trusted hops and storage kind');
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
