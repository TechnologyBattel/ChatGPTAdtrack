// @vitest-environment node
//
// Security behaviour of the server, one describe block per guarantee. The tests
// are the specification: if a guard is dropped, one of these fails.

import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../server/app.mjs';
import type { Principal } from '../../../server/auth.mjs';
import { createAdminLoader, createAuth, bearerToken, hasRole, safeEqual, WRITE_ROLES } from '../../../server/auth.mjs';
import { createConsentService } from '../../../server/consent.mjs';
import { createMemoryStore } from '../../../server/store.mjs';
import {
  assertDeclaredSize,
  assertOrigin,
  clientIp,
  createRateLimiter,
  parseAllowlist,
  readJsonBody,
} from '../../../server/limits.mjs';

const DEV_TOKEN = 'dev_test_token_1234567890';
const SECRET_V1 = 'consent-secret-version-one';
const SECRET_V2 = 'consent-secret-version-two';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function makeApp(overrides: Record<string, unknown> = {}) {
  const auth = createAuth({ mode: 'dev', devToken: DEV_TOKEN, devRole: 'owner' });
  const store = createMemoryStore();
  const consent = createConsentService({
    secrets: [{ version: 'v1', secret: SECRET_V1 }],
    currentVersion: 'v1',
    store,
  });
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
    store,
    rateLimit: createRateLimiter({ limit: 100 }),
    dataset,
    logger: quiet,
    ...overrides,
  });
  return { app, auth, consent, store, dataset };
}

const authed = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${DEV_TOKEN}`, ...extra });

/** Full consent handshake; returns the pair a browser would hold. */
async function handshake(app: { handle: (req: Record<string, unknown>) => Promise<{ body: Record<string, any> }> }) {
  const session = await app.handle({
    method: 'POST',
    path: '/api/session',
    headers: { origin: 'https://app.test' },
    ip: '1.1.1.1',
  });
  const consent = await app.handle({
    method: 'POST',
    path: '/api/consent',
    headers: { origin: 'https://app.test' },
    ip: '1.1.1.1',
    body: { granted: true, sessionId: session.body.sessionId },
  });
  return { sessionId: session.body.sessionId, consentId: consent.body.consentId, session, consent };
}

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
    expect(() => gate.requireWrite({ uid: 'u2', role: 'root' })).toThrow();
  });
});

describe('firebase-admin is optional and lazily loaded (gap 7)', () => {
  it('explains a missing module instead of throwing a module error', async () => {
    const load = createAdminLoader({
      projectId: 'proj',
      importAdmin: async () => {
        const err = new Error("Cannot find package 'firebase-admin'");
        (err as Error & { code?: string }).code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      },
    });
    await expect(load()).rejects.toThrow(/AUTH_MODE=firebase but firebase-admin is not installed/);
    await expect(load()).rejects.toThrow(/optionalDependency/);
  });

  it('requires a project id even when the SDK is present', async () => {
    const load = createAdminLoader({ importAdmin: async () => ({ apps: [] }) });
    await expect(load()).rejects.toThrow(/FIREBASE_PROJECT_ID is not set/);
  });

  it('initialises once and reuses the app', async () => {
    const initializeApp = vi.fn();
    const admin = { apps: [] as unknown[], initializeApp, auth: () => ({}) };
    const load = createAdminLoader({ projectId: 'proj', importAdmin: async () => admin });
    await load();
    await load();
    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(initializeApp).toHaveBeenCalledWith({ projectId: 'proj' });
  });

  it('is declared as an optional dependency, not a required one', async () => {
    const pkg = JSON.parse(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
      ),
    );
    expect(pkg.optionalDependencies['firebase-admin']).toBeTruthy();
    expect(pkg.dependencies['firebase-admin']).toBeUndefined();
  });
});

describe('consent ids: who can get one, and what they can do with it (gap 2)', () => {
  function service({
    secrets,
    currentVersion = 'v1',
    now = (() => 1_000_000) as () => number,
  }: { secrets?: { version: string; secret: string }[]; currentVersion?: string; now?: () => number } = {}) {
    const store = createMemoryStore({ now });
    const consent = createConsentService({
      secrets: secrets ?? [{ version: 'v1', secret: SECRET_V1 }],
      currentVersion,
      store,
      now,
    });
    return { consent, store };
  }

  it('requires a session before it will record consent', async () => {
    const { consent } = service();
    await expect(consent.grant({ sessionId: 'nope' })).rejects.toThrow(/session is required/);
    await expect(consent.grant({ sessionId: 'sess_unknown' })).rejects.toThrow(/unknown or has expired/);
    await expect(consent.grant({})).rejects.toThrow(/session is required/);
  });

  it('binds the id to the session that granted it', async () => {
    const { consent } = service();
    const a = await consent.createSession({ ip: '1.1.1.1' });
    const grant = await consent.grant({ sessionId: a.sessionId });
    expect(grant.consentId.split('.')).toHaveLength(2);
    await expect(consent.consume({ consentId: grant.consentId, sessionId: 'sess_somebody_else' })).rejects.toThrow(
      /different session/,
    );
  });

  it('accepts a grant exactly once and reports a replay after that', async () => {
    const { consent } = service();
    const s = await consent.createSession({ ip: '1.1.1.1' });
    const grant = await consent.grant({ sessionId: s.sessionId });
    await expect(consent.consume({ consentId: grant.consentId, sessionId: s.sessionId })).resolves.toMatchObject({
      scopes: ['measurement'],
    });
    await expect(consent.consume({ consentId: grant.consentId, sessionId: s.sessionId })).rejects.toThrow(
      /already been used/,
    );
  });

  it('expires a grant on its own short clock', async () => {
    let clock = 1_000_000; // reassigned below to advance time
    const { consent } = service({ now: () => clock });
    const s = await consent.createSession({ ip: '1.1.1.1' });
    const grant = await consent.grant({ sessionId: s.sessionId });
    clock += 15 * 60 * 1000 + 1;
    await expect(consent.consume({ consentId: grant.consentId, sessionId: s.sessionId })).rejects.toThrow(/expired/);
  });

  it('expires the session independently of the grant', async () => {
    let clock = 1_000_000;
    const { consent } = service({ now: () => clock });
    const s = await consent.createSession({ ip: '1.1.1.1' });
    clock += 30 * 60 * 1000 + 1;
    await expect(consent.grant({ sessionId: s.sessionId })).rejects.toThrow(/unknown or has expired/);
  });

  it('survives a secret rotation and refuses a retired version', async () => {
    const clock = 1_000_000;
    const store = createMemoryStore({ now: () => clock });
    const v1Only = createConsentService({
      secrets: [{ version: 'v1', secret: SECRET_V1 }],
      currentVersion: 'v1',
      store,
      now: () => clock,
    });
    const s = await v1Only.createSession({ ip: '1.1.1.1' });
    const oldGrant = await v1Only.grant({ sessionId: s.sessionId });

    // Rotate: v2 signs new ids, v1 still verifies what is inside its TTL.
    const rotated = createConsentService({
      secrets: [
        { version: 'v2', secret: SECRET_V2 },
        { version: 'v1', secret: SECRET_V1 },
      ],
      currentVersion: 'v2',
      store,
      now: () => clock,
    });
    await expect(rotated.consume({ consentId: oldGrant.consentId, sessionId: s.sessionId })).resolves.toMatchObject({
      keyVersion: 'v1',
    });
    const newGrant = await rotated.grant({ sessionId: s.sessionId });
    expect(JSON.parse(Buffer.from(newGrant.consentId.split('.')[0], 'base64url').toString()).kv).toBe('v2');

    // Retiring v1 makes the old ids invalid rather than silently valid forever.
    const retired = createConsentService({
      secrets: [{ version: 'v2', secret: SECRET_V2 }],
      currentVersion: 'v2',
      store,
      now: () => clock,
    });
    const s2 = await retired.createSession({ ip: '1.1.1.1' });
    const v1Grant = await createConsentService({
      secrets: [{ version: 'v1', secret: SECRET_V1 }],
      currentVersion: 'v1',
      store,
      now: () => clock,
    }).grant({ sessionId: s2.sessionId });
    await expect(retired.consume({ consentId: v1Grant.consentId, sessionId: s2.sessionId })).rejects.toThrow(
      /no longer accepts/,
    );
  });

  it('rejects a tampered payload and a truncated id', async () => {
    const { consent } = service();
    const s = await consent.createSession({ ip: '1.1.1.1' });
    const grant = await consent.grant({ sessionId: s.sessionId });
    const [encoded, signature] = grant.consentId.split('.');
    const forged = Buffer.from(
      JSON.stringify({ v: 1, kv: 'v1', sid: s.sessionId, scopes: ['measurement'], exp: 9_999_999_999, jti: 'x' }),
    ).toString('base64url');
    await expect(consent.consume({ consentId: `${forged}.${signature}`, sessionId: s.sessionId })).rejects.toThrow(
      /signature is not valid/,
    );
    expect(encoded).not.toBe(forged);
    await expect(consent.consume({ consentId: 'short', sessionId: s.sessionId })).rejects.toThrow(
      /boolean is not consent/,
    );
    await expect(consent.consume({ consentId: 'y'.repeat(30), sessionId: s.sessionId })).rejects.toThrow(/malformed/);
  });

  it('refuses scopes it does not issue, and requires the scope on consume', async () => {
    const { consent } = service();
    const s = await consent.createSession({ ip: '1.1.1.1' });
    await expect(consent.grant({ sessionId: s.sessionId, scopes: ['marketing'] })).rejects.toThrow(/at least one of/);
    const grant = await consent.grant({ sessionId: s.sessionId, scopes: ['measurement'] });
    await expect(
      consent.consume({ consentId: grant.consentId, sessionId: s.sessionId, scope: 'marketing' }),
    ).rejects.toThrow(/scope/);
  });

  it('needs a signing secret and a version that exists', () => {
    const store = createMemoryStore();
    expect(() => createConsentService({ secrets: [], currentVersion: 'v1', store })).toThrow(
      /at least one signing secret/,
    );
    expect(() =>
      createConsentService({ secrets: [{ version: 'v1', secret: SECRET_V1 }], currentVersion: 'v9', store }),
    ).toThrow(/not in the secret list/);
    expect(() => createConsentService({ secrets: [{ version: 'v1', secret: SECRET_V1 }] } as never)).toThrow(
      /requires a store/,
    );
  });
});

describe('request guards', () => {
  it('stops a chunked body at the cap while streaming (gap 4)', async () => {
    let chunksRead = 0;
    async function* big() {
      for (let i = 0; i < 10; i++) {
        chunksRead += 1;
        yield Buffer.alloc(64 * 1024);
      }
    }
    await expect(readJsonBody(big(), { maxBytes: 128 * 1024 })).rejects.toThrow(/exceeds the 131072 byte limit/);
    // The loop breaks on the offending chunk: it does not buffer all 640 KB first.
    expect(chunksRead).toBeLessThan(10);
  });

  it('parses a JSON object and rejects primitives or bad JSON', async () => {
    async function* one(text: string) {
      yield Buffer.from(text);
    }
    await expect(readJsonBody(one('{"a":1}'))).resolves.toEqual({ a: 1 });
    await expect(readJsonBody(one('"just a string"'))).rejects.toThrow(/JSON object/);
    await expect(readJsonBody(one('{oops'))).rejects.toThrow(/not valid JSON/);
    await expect(readJsonBody(one(''))).resolves.toEqual({});
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
    expect(limiter.hit('ip2').allowed).toBe(true);
    clock = 1001;
    expect(limiter.hit('ip1').allowed).toBe(true);
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

  it('parses a comma-separated allowlist', () => {
    expect(parseAllowlist(' https://a.test , https://b.test ,')).toEqual(['https://a.test', 'https://b.test']);
  });
});

describe('client ip and TRUST_PROXY (gap 3)', () => {
  it('ignores X-Forwarded-For entirely when no proxy is trusted', () => {
    // The default. A client that sets its own header must not become "1.2.3.4".
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.7')).toBe('10.0.0.7');
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.7', { trustProxy: 0 })).toBe('10.0.0.7');
  });

  it('takes the rightmost hop with one trusted proxy', () => {
    // "spoofed" is what the attacker prepended; the real client is last.
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }, '10.0.0.7', { trustProxy: 1 })).toBe('203.0.113.9');
    // A single entry is both first and last.
    expect(clientIp({ 'x-forwarded-for': '203.0.113.9' }, '10.0.0.7', { trustProxy: 1 })).toBe('203.0.113.9');
  });

  it('walks in past each trusted hop', () => {
    const headers = { 'x-forwarded-for': 'spoofed, 198.51.100.4, 10.1.1.1' };
    expect(clientIp(headers, '10.0.0.7', { trustProxy: 1 })).toBe('10.1.1.1'); // our edge, not the client
    expect(clientIp(headers, '10.0.0.7', { trustProxy: 2 })).toBe('198.51.100.4'); // the real client
  });

  it('clamps instead of trusting more hops than the header can satisfy', () => {
    // Only two entries: asking for five trusted hops cannot invent addresses, so
    // the leftmost entry wins rather than a proxy address.
    const headers = { 'x-forwarded-for': 'spoofed, 10.1.1.1' };
    expect(clientIp(headers, '10.0.0.7', { trustProxy: 5 })).toBe('spoofed');
    expect(clientIp(headers, '10.0.0.7', { trustProxy: 2 })).toBe('spoofed');
  });

  it('falls back to the socket when the header is empty or malformed', () => {
    expect(clientIp({ 'x-forwarded-for': '' }, '10.0.0.7', { trustProxy: 1 })).toBe('10.0.0.7');
    expect(clientIp({ 'x-forwarded-for': ' , , ' }, '10.0.0.7', { trustProxy: 1 })).toBe('10.0.0.7');
    expect(clientIp({}, '10.0.0.7', { trustProxy: 3 })).toBe('10.0.0.7');
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4' }, undefined, { trustProxy: 1 })).toBe('1.2.3.4');
    expect(clientIp({})).toBe('unknown');
    // A hostile trustProxy value cannot widen trust.
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.7', { trustProxy: -4 })).toBe('10.0.0.7');
  });

  it('gives a spoofing client its own rate-limit bucket, not the victim address bucket', () => {
    // With one trusted proxy, the attacker cannot pick the bucket by setting XFF.
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    const attackerHeaders = { 'x-forwarded-for': '203.0.113.9, 198.51.100.4' };
    const attackerIp = clientIp(attackerHeaders, '10.0.0.7', { trustProxy: 1 });
    limiter.hit(`track:${attackerIp}`);
    // Same presented header again: still one bucket, so the second call is limited.
    const again = clientIp(attackerHeaders, '10.0.0.7', { trustProxy: 1 });
    expect(again).toBe(attackerIp);
    expect(() => limiter.hit(`track:${again}`)).toThrow(/Too many requests/);
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

  it('gives an authenticated caller the full detail, including storage and role', async () => {
    const { app } = makeApp();
    const res = await app.handle({ method: 'GET', path: '/api/health', headers: authed() });
    expect(res.body.mode).toBe('demo');
    expect(res.body.configuration.adsKey).toBe(true);
    expect(res.body.storage).toEqual({ kind: 'memory', ok: true });
    expect(res.body.auth).toEqual({ mode: 'dev', role: 'owner' });
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
    ['GET', '/api/audit'],
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
    const { app } = makeApp({ env: { adsKey: 'k', pixelId: 'p', fetchImpl } });
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

  it('an admin may push, the upstream call happens once, and the history is stored server-side', async () => {
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
    const { app, store } = makeApp({ auth, env: { adsKey: 'k', pixelId: 'p', fetchImpl } });
    const res = await app.handle({
      method: 'POST',
      path: '/api/adgroups/adgrp_1/hints',
      headers: authed(),
      body: { hints: ['a hint'] },
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // read, write, read back
    expect(res.body.pushedHints).toEqual(['a hint']);

    const entries = await store.audit.list({ adGroupId: 'adgrp_1' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'push', actor: 'dev-user', actorRole: 'admin', after: ['a hint'] });
  });

  it('exposes the stored history through GET /api/audit (gap 8)', async () => {
    let stored: string[] = ['old'];
    const fetchImpl = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (init?.method === 'POST') stored = JSON.parse(String(init.body)).context_hints;
        return { id: 'g1', context_hints: stored };
      },
    }));
    const { app } = makeApp({ env: { adsKey: 'k', pixelId: 'p', fetchImpl } });
    await app.handle({ method: 'POST', path: '/api/adgroups/g1/hints', headers: authed(), body: { hints: ['new'] } });

    const res = await app.handle({
      method: 'GET',
      path: '/api/audit',
      headers: authed(),
      query: { adGroupId: 'g1', limit: '10' },
    });
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].before).toEqual(['old']);
    expect(res.body.entries[0].after).toEqual(['new']);
    expect(res.body.actor).toBe('dev-user');
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
  };

  function appWithTrack(fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))) {
    const built = makeApp({
      env: { adsKey: 'k', capiKey: 'c', pixelId: 'p', trackOrigins: ['https://app.test'], fetchImpl },
    });
    return { ...built, fetchImpl };
  }

  it('accepts a first-party event after a real session + consent handshake', async () => {
    const { app, fetchImpl } = appWithTrack();
    const { sessionId, consentId } = await handshake(app);
    const res = await app.handle({
      method: 'POST',
      path: '/api/track',
      headers: { origin: 'https://app.test' },
      body: { ...event, sessionId, consentId },
    });
    expect(res.status).toBe(202);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.body.consent.consumedAt).toBeTruthy();
  });

  it('rejects a replay of the same consent id (gap 2)', async () => {
    const { app, fetchImpl } = appWithTrack();
    const { sessionId, consentId } = await handshake(app);
    const headers = { origin: 'https://app.test' };
    expect(
      (await app.handle({ method: 'POST', path: '/api/track', headers, body: { ...event, sessionId, consentId } }))
        .status,
    ).toBe(202);
    const replay = await app.handle({
      method: 'POST',
      path: '/api/track',
      headers,
      body: { ...event, sessionId, consentId },
    });
    expect(replay.status).toBe(403);
    expect(replay.body.error.code).toBe('consent_replayed');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the replay never reached upstream
  });

  it('rejects a consent id presented with a different session id (gap 2)', async () => {
    const { app, fetchImpl } = appWithTrack();
    const { consentId } = await handshake(app);
    const other = await handshake(app);
    const res = await app.handle({
      method: 'POST',
      path: '/api/track',
      headers: { origin: 'https://app.test' },
      body: { ...event, sessionId: other.sessionId, consentId },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('consent_session_mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an event with no session at all', async () => {
    const { app, fetchImpl } = appWithTrack();
    const res = await app.handle({
      method: 'POST',
      path: '/api/track',
      headers: { origin: 'https://app.test' },
      body: { ...event },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('session_required');
    expect(fetchImpl).not.toHaveBeenCalled();
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
    const { sessionId } = await handshake(app);
    const res = await app.handle({
      method: 'POST',
      path: '/api/track',
      headers: { origin: 'https://app.test' },
      body: { ...event, sessionId, consentId: 'Zm9yZ2Vk.signature' },
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

  it('rate limits per IP, so one visitor cannot exhaust another', async () => {
    const built = makeApp({
      env: {
        adsKey: 'k',
        capiKey: 'c',
        pixelId: 'p',
        trackOrigins: ['https://app.test'],
        fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
      },
      rateLimit: createRateLimiter({ limit: 1, now: () => 0 }),
    });
    const call = (ip: string) =>
      built.app.handle({
        method: 'POST',
        path: '/api/track',
        headers: { origin: 'https://app.test' },
        ip,
        body: { ...event },
      });
    // First call spends the single token in that address's bucket (403: no session).
    expect((await call('1.1.1.1')).body.error.code).toBe('session_required');
    // Second call from the same address is limited before any work happens.
    const limited = await call('1.1.1.1');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    // A different visitor still has their own bucket: the limit is per IP.
    expect((await call('2.2.2.2')).body.error.code).toBe('session_required');
  });

  it('records consent only for an existing session, and never for granted:false', async () => {
    const { app } = appWithTrack();
    const headers = { origin: 'https://app.test' };
    const session = await app.handle({ method: 'POST', path: '/api/session', headers, ip: '1.1.1.1' });
    expect(session.status).toBe(201);
    expect(session.body.expiresAt).toBeTruthy();

    const granted = await app.handle({
      method: 'POST',
      path: '/api/consent',
      headers,
      body: { granted: true, sessionId: session.body.sessionId },
    });
    expect(granted.status).toBe(201);
    expect(granted.body.consentId).toBeTruthy();

    const refused = await app.handle({ method: 'POST', path: '/api/consent', headers, body: { granted: false } });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('consent_not_granted');

    const noSession = await app.handle({ method: 'POST', path: '/api/consent', headers, body: { granted: true } });
    expect(noSession.status).toBe(403);
    expect(noSession.body.error.code).toBe('session_required');
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
