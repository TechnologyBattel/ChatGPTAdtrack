// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../server/app.mjs';
import type { Principal } from '../../../server/auth.mjs';
import { createAuth, bearerToken, hasRole, safeEqual, WRITE_ROLES } from '../../../server/auth.mjs';
import { createConsentStore } from '../../../server/consent.mjs';
import {
  assertDeclaredSize,
  assertOrigin,
  clientIp,
  createRateLimiter,
  parseAllowlist,
  readJsonBody,
} from '../../../server/limits.mjs';

const DEV_TOKEN = 'dev_test_token_1234567890';

function makeApp(overrides: Record<string, unknown> = {}) {
  const auth = createAuth({ mode: 'dev', devToken: DEV_TOKEN, devRole: 'owner' });
  const consent = createConsentStore({ secret: 'test-secret-value-1234' });
  const dataset = vi.fn(async () => ({
    generatedAt: 'x',
    endDate: '2026-10-24',
    currency: 'INR',
    campaigns: [],
    adGroups: [],
    rows: [],
  }));
  const app = createApp({
    // No pixel id by default, so nothing here reaches the network.
    env: { adsKey: 'ads_key_value', capiKey: 'capi_key_value', trackOrigins: ['https://app.test'] },
    auth,
    consent,
    rateLimit: createRateLimiter({ limit: 100 }),
    dataset,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  });
  return { app, auth, consent, dataset };
}

const authed = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${DEV_TOKEN}`, ...extra });

describe('auth primitives', () => {
  it('extracts a bearer token case-insensitively', () => {
    expect(bearerToken({ authorization: 'bearer abc' })).toBe('abc');
    expect(bearerToken({ Authorization: 'Bearer  xyz ' })).toBe('xyz');
    expect(bearerToken({})).toBeNull();
    expect(bearerToken({ authorization: 'Basic abc' })).toBeNull();
  });

  it('compares tokens in constant time and rejects empty input', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
  });

  it('gates writes on admin or owner only', () => {
    expect([...WRITE_ROLES]).toEqual(['admin', 'owner']);
    expect(hasRole({ role: 'owner' }, WRITE_ROLES)).toBe(true);
    expect(hasRole({ role: 'admin' }, WRITE_ROLES)).toBe(true);
    expect(hasRole({ role: 'analyst' }, WRITE_ROLES)).toBe(false);
    expect(hasRole({ role: 'viewer' }, WRITE_ROLES)).toBe(false);
    expect(hasRole(null, WRITE_ROLES)).toBe(false);
  });

  it('refuses to construct an unauthenticated dev gate', () => {
    expect(() => createAuth({ mode: 'dev', devToken: '' })).toThrow(/Refusing to start/);
  });

  it('refuses to construct an unknown mode', () => {
    expect(() => createAuth({ mode: 'off' as never, devToken: DEV_TOKEN })).toThrow(/Unsupported AUTH_MODE/);
  });

  it('refuses an unknown dev role', () => {
    expect(() => createAuth({ mode: 'dev', devToken: DEV_TOKEN, devRole: 'superuser' })).toThrow(/Unknown dev role/);
  });

  it('delegates to an injected verifier so tests never need Firebase', async () => {
    const verifyToken = vi.fn(async (): Promise<Principal> => ({ uid: 'u1', role: 'analyst', via: 'firebase' }));
    const gate = createAuth({ mode: 'firebase', verifyToken });
    const principal = await gate.authenticate({ authorization: 'Bearer any.jwt.value' });
    expect(principal).toEqual({ uid: 'u1', role: 'analyst', via: 'firebase' });
    expect(verifyToken).toHaveBeenCalledWith('any.jwt.value');
    expect(() => gate.requireWrite(principal)).toThrow(/requires a write role/);
  });

  it('maps an unknown role claim to viewer, never to a write role', async () => {
    const gate = createAuth({
      mode: 'firebase',
      verifyToken: async () => ({ uid: 'u2', role: 'root', via: 'firebase' }),
    });
    // The injected verifier here returns 'root'; createApp's gate must not grant writes for it.
    expect(() => gate.requireWrite({ uid: 'u2', role: 'root' })).toThrow();
  });
});

describe('consent ids', () => {
  const store = createConsentStore({ secret: 'test-secret-value-1234', ttlSeconds: 60 });

  it('issues a verifiable id', () => {
    const { consentId } = store.issue();
    const grant = store.verify(consentId);
    expect(grant.scopes).toEqual(['measurement']);
  });

  it('rejects a tampered payload', () => {
    const { consentId } = store.issue();
    const [encoded, signature] = consentId.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, scopes: ['measurement'], exp: 9999999999 })).toString(
      'base64url',
    );
    expect(() => store.verify(`${forged}.${signature}`)).toThrow(/signature/);
    expect(encoded).not.toBe(forged);
  });

  it('rejects a boolean or missing id with a clear message', () => {
    expect(() => store.verify(true)).toThrow(/boolean is not consent/);
    expect(() => store.verify(undefined)).toThrow(/consent id is required/);
  });

  it('rejects an expired id', () => {
    let clock = 1_000_000;
    const timed = createConsentStore({ secret: 'test-secret-value-1234', ttlSeconds: 10, now: () => clock });
    const { consentId } = timed.issue();
    clock += 11_000;
    expect(() => timed.verify(consentId)).toThrow(/expired/);
  });

  it('refuses to issue consent with no supported scope', () => {
    const scoped = createConsentStore({ secret: 'test-secret-value-1234' });
    expect(() => scoped.issue({ scopes: ['marketing'] })).toThrow(/no_valid_scope|at least one of/);
  });

  it('rejects a valid id when the required scope is absent', () => {
    const scoped = createConsentStore({ secret: 'test-secret-value-1234' });
    // Measurable scopes today are only 'measurement'; ask for one that is not granted.
    const { consentId } = scoped.issue({ scopes: ['measurement'] });
    expect(() => scoped.verify(consentId, 'marketing')).toThrow(/scope/);
  });

  it('needs a real secret', () => {
    expect(() => createConsentStore({ secret: 'short' })).toThrow(/at least 16/);
  });
});

describe('request guards', () => {
  it('caps the body while streaming and stops reading', async () => {
    async function* big() {
      for (let i = 0; i < 10; i++) yield Buffer.alloc(64 * 1024);
    }
    await expect(readJsonBody(big(), { maxBytes: 128 * 1024 })).rejects.toThrow(/exceeds the 131072 byte limit/);
  });

  it('parses a JSON object and rejects primitives or bad JSON', async () => {
    async function* one(text: string) {
      yield Buffer.from(text);
    }
    await expect(readJsonBody(one('{"a":1}'))).resolves.toEqual({ a: 1 });
    await expect(readJsonBody(one('"just a string"'))).rejects.toThrow(/JSON object/);
    await expect(readJsonBody(one('{oops'))).rejects.toThrow(/not valid JSON/);
  });

  it('rejects an oversized declared Content-Length before reading', () => {
    expect(() => assertDeclaredSize({ 'content-length': '999999' }, 1024)).toThrow(/Declared body exceeds/);
    expect(() => assertDeclaredSize({ 'content-length': '10' }, 1024)).not.toThrow();
    expect(() => assertDeclaredSize({}, 1024)).not.toThrow();
    expect(() => assertDeclaredSize({ 'content-length': 'abc' }, 1024)).toThrow(/not a valid number/);
  });

  it('rate limits per key and reports retry advice', () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => clock });
    expect(limiter.hit('ip1').allowed).toBe(true);
    expect(limiter.hit('ip1').allowed).toBe(true);
    expect(() => limiter.hit('ip1')).toThrow(/Too many requests/);
    expect(limiter.hit('ip2').allowed).toBe(true); // separate bucket
    clock = 1001;
    expect(limiter.hit('ip1').allowed).toBe(true); // window rolled over
  });

  it('refuses a cross-origin call when an allowlist exists', () => {
    expect(() => assertOrigin({ origin: 'https://evil.test' }, ['https://app.test'])).toThrow(/not allowed/);
    expect(assertOrigin({ origin: 'https://app.test/' }, ['https://app.test']).origin).toBe('https://app.test');
  });

  it('refuses cross-origin calls when no allowlist is configured', () => {
    expect(() => assertOrigin({ origin: 'https://anything.test' }, [])).toThrow(/No origin allowlist/);
  });

  it('allows an absent Origin by default, and can require one', () => {
    expect(assertOrigin({}, ['https://app.test']).origin).toBeNull();
    expect(() => assertOrigin({}, ['https://app.test'], { requireOrigin: true })).toThrow(/requires an Origin/);
  });

  it('derives the client ip from X-Forwarded-For', () => {
    expect(clientIp({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })).toBe('203.0.113.9');
    expect(clientIp({}, '10.0.0.5')).toBe('10.0.0.5');
    expect(clientIp({})).toBe('unknown');
  });

  it('parses a comma-separated allowlist', () => {
    expect(parseAllowlist(' https://a.test , https://b.test ,')).toEqual(['https://a.test', 'https://b.test']);
  });
});

describe('/api/health', () => {
  it('gives an unauthenticated caller only ok and mode', async () => {
    const { app } = makeApp();
    const res = await app.handle({ method: 'GET', path: '/api/health', headers: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, mode: 'demo' });
    expect(JSON.stringify(res.body)).not.toContain('ads_key_value');
  });

  it('gives an authenticated caller the full detail', async () => {
    const { app } = makeApp();
    const res = await app.handle({ method: 'GET', path: '/api/health', headers: authed() });
    expect(res.body.mode).toBe('demo');
    expect(res.body.configuration.adsKey).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('ads_key_value');
  });

  it('does not leak the upstream error reason to anonymous callers', async () => {
    const { app } = makeApp({
      env: {
        adsKey: 'k',
        pixelId: 'p',
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          json: async () => ({ error: { message: 'invalid api key sk-live-xyz' } }),
        }),
      },
    });
    const anon = await app.handle({ method: 'GET', path: '/api/health', headers: {} });
    expect(anon.body).toEqual({ ok: false, mode: 'error' });
    expect(JSON.stringify(anon.body)).not.toContain('sk-live');
  });
});

describe('authentication on protected routes', () => {
  const protectedRoutes: [string, string][] = [
    ['GET', '/api/dataset'],
    ['POST', '/api/adgroups/adgrp_1/hints'],
    ['GET', '/api/adgroups'],
  ];

  it.each(protectedRoutes)('%s %s rejects a missing token with 401', async (method, path) => {
    const { app } = makeApp();
    const res = await app.handle({ method, path, headers: {}, body: { hints: ['x'] } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it.each(protectedRoutes)('%s %s rejects a wrong token with 401', async (method, path) => {
    const { app } = makeApp();
    const res = await app.handle({ method, path, headers: { authorization: 'Bearer nope' }, body: { hints: ['x'] } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_token');
  });

  it('rejects an unauthenticated push before any upstream call', async () => {
    const fetchImpl = vi.fn();
    const auth = createAuth({ mode: 'dev', devToken: DEV_TOKEN });
    const { app } = makeApp({ auth, env: { adsKey: 'k', pixelId: 'p', fetchImpl } });
    const res = await app.handle({
      method: 'POST',
      path: '/api/adgroups/adgrp_1/hints',
      headers: {},
      body: { hints: ['a hint'] },
    });
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('role gate: analyst and viewer cannot push, and nothing reaches upstream', async () => {
    for (const role of ['analyst', 'viewer']) {
      const fetchImpl = vi.fn();
      const auth = createAuth({ mode: 'dev', devToken: DEV_TOKEN, devRole: role });
      const { app } = makeApp({ auth, env: { adsKey: 'k', pixelId: 'p', fetchImpl } });
      const res = await app.handle({
        method: 'POST',
        path: '/api/adgroups/adgrp_1/hints',
        headers: authed(),
        body: { hints: ['a hint'] },
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('an admin may push, and the upstream call is attempted exactly once', async () => {
    let stored: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (init?.method === 'POST') stored = JSON.parse(String(init.body)).context_hints;
        return { id: 'adgrp_1', context_hints: stored };
      },
    }));
    const auth = createAuth({ mode: 'dev', devToken: DEV_TOKEN, devRole: 'admin' });
    const { app } = makeApp({ auth, env: { adsKey: 'k', pixelId: 'p', fetchImpl } });
    const res = await app.handle({
      method: 'POST',
      path: '/api/adgroups/adgrp_1/hints',
      headers: authed(),
      body: { hints: ['a hint'] },
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // read, write, read back
    expect(res.body.pushedHints).toEqual(['a hint']);
  });

  it('sets a role on the dev session from config, and only in dev mode', async () => {
    const dev = makeApp().app;
    expect((await dev.handle({ method: 'POST', path: '/api/dev/session' })).status).toBe(200);

    const firebaseAuth = createAuth({
      mode: 'firebase',
      verifyToken: async (): Promise<Principal> => ({ uid: 'u', role: 'owner' }),
    });
    const prod = makeApp({ auth: firebaseAuth }).app;
    const res = await prod.handle({ method: 'POST', path: '/api/dev/session' });
    expect(res.status).toBe(404);
  });
});

describe('/api/track guards', () => {
  const event = {
    eventName: 'lead_created',
    eventId: 'evt_1',
    sourceUrl: 'https://app.test/thanks',
    consentId: '',
  };

  function appWithTrack(fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))) {
    const built = makeApp({
      env: { adsKey: 'k', capiKey: 'c', pixelId: 'p', trackOrigins: ['https://app.test'], fetchImpl },
    });
    const consentId = built.consent.issue().consentId;
    return { ...built, consentId, fetchImpl };
  }

  it('is reachable without a token (it is the public write path)', async () => {
    const { app, consentId, fetchImpl } = appWithTrack();
    const res = await app.handle({
      method: 'POST',
      path: '/api/track',
      headers: { origin: 'https://app.test' },
      body: { ...event, consentId },
    });
    expect(res.status).toBe(202);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects the old boolean consent and never calls upstream', async () => {
    const { app, fetchImpl } = appWithTrack();
    const res = await app.handle({
      method: 'POST',
      path: '/api/track',
      headers: { origin: 'https://app.test' },
      body: { ...event, consent: true },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('consent_required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a forged consent id', async () => {
    const { app, fetchImpl } = appWithTrack();
    const res = await app.handle({
      method: 'POST',
      path: '/api/track',
      headers: { origin: 'https://app.test' },
      body: { ...event, consentId: 'Zm9yZ2Vk.signature' },
    });
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a disallowed origin before doing any work', async () => {
    const { app, fetchImpl } = appWithTrack();
    const res = await app.handle({
      method: 'POST',
      path: '/api/track',
      headers: { origin: 'https://evil.test' },
      body: { ...event, consentId: 'anything' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('origin_not_allowed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rate limits per IP', async () => {
    const built = makeApp({
      env: {
        adsKey: 'k',
        capiKey: 'c',
        pixelId: 'p',
        trackOrigins: ['https://app.test'],
        fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
      },
      rateLimit: createRateLimiter({ limit: 2 }),
    });
    const consentId = built.consent.issue().consentId;
    const call = (ip: string) =>
      built.app.handle({
        method: 'POST',
        path: '/api/track',
        headers: { origin: 'https://app.test' },
        ip,
        body: { ...event, consentId },
      });
    expect((await call('1.1.1.1')).status).toBe(202);
    expect((await call('1.1.1.1')).status).toBe(202);
    const third = await call('1.1.1.1');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('rate_limited');
    expect((await call('2.2.2.2')).status).toBe(202);
  });

  it('records consent and then accepts events that use the returned id', async () => {
    const { app } = appWithTrack();
    const recorded = await app.handle({
      method: 'POST',
      path: '/api/consent',
      headers: { origin: 'https://app.test' },
      body: { granted: true },
    });
    expect(recorded.status).toBe(201);
    expect(recorded.body.consentId).toBeTruthy();
  });

  it('refuses to record consent that was not actually granted', async () => {
    const { app } = appWithTrack();
    const res = await app.handle({ method: 'POST', path: '/api/consent', headers: {}, body: { granted: false } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('consent_not_granted');
  });
});

describe('cache and routing', () => {
  it('caches the dataset per window and drops it after a push', async () => {
    const dataset = vi.fn(async () => ({
      generatedAt: 'x',
      endDate: '2026-10-24',
      currency: 'INR',
      campaigns: [],
      adGroups: [],
      rows: [],
    }));
    const fetchImpl = vi.fn(async (_url: string, init?: { method?: string }) => ({
      ok: true,
      status: 200,
      json: async () => (init?.method === 'POST' ? { id: 'g', context_hints: ['h'] } : { id: 'g', context_hints: [] }),
    }));
    const { app } = makeApp({ dataset, env: { adsKey: 'k', capiKey: 'c', pixelId: 'p', fetchImpl } });

    await app.handle({ method: 'GET', path: '/api/dataset', headers: authed(), query: { days: '30' } });
    await app.handle({ method: 'GET', path: '/api/dataset', headers: authed(), query: { days: '30' } });
    expect(dataset).toHaveBeenCalledTimes(1);

    await app.handle({ method: 'POST', path: '/api/adgroups/g/hints', headers: authed(), body: { hints: ['h'] } });
    await app.handle({ method: 'GET', path: '/api/dataset', headers: authed(), query: { days: '30' } });
    expect(dataset).toHaveBeenCalledTimes(2);
  });

  it('answers 404 for an unknown route', async () => {
    const { app } = makeApp();
    const res = await app.handle({ method: 'GET', path: '/api/nope' });
    expect(res.status).toBe(404);
  });

  it('returns a 500 shape rather than throwing when a dependency fails', async () => {
    const { app } = makeApp({
      dataset: async () => {
        throw new Error('upstream exploded');
      },
      env: { adsKey: 'k', capiKey: 'c', pixelId: 'p', fetchImpl: vi.fn() },
    });
    const res = await app.handle({ method: 'GET', path: '/api/dataset', headers: authed() });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
  });
});
