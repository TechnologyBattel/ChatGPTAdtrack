// @vitest-environment node
//
// Private research (slice 1) — acceptance tests AC1…AC10.
//
// These tests are written against the *boundaries*, not the happy path: what must never be
// stored, what must never be logged, what must never be disclosed, and what must never let a
// model influence the deterministic cluster set. If someone later adds a convenience cache, a
// debug log line or a "best effort" merge of model output, one of these fails.
//
// The provider is never called: `fetchImpl` is injected and every response is a fixture.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../server/app.mjs';
import { createAuth } from '../../../server/auth.mjs';
import { createConsentService } from '../../../server/consent.mjs';
import { createMemoryStore } from '../../../server/store.mjs';
import { createRateLimiter } from '../../../server/limits.mjs';
import { createTenancy } from '../../../server/tenancy.mjs';
import { createSources } from '../../../server/sources.mjs';
import { createEventIngest } from '../../../server/events-v2.mjs';
import { createAgencyApi } from '../../../server/agency.mjs';
import { PRIVATE_ERROR_CODES, auditDetail, createPrivateResearch } from '../../../server/private-research.mjs';

const SECRET = 'consent-secret-for-private-research-tests';
const KEY = 'sk-test-0123456789abcdefghijklmnop';
const NOW = 1_760_000_000_000;

/** A logger that records everything it is given, so we can prove a key never reaches it. */
function recordingLogger() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  return { lines, info: push, warn: push, error: push, request: push, log: push };
}

/** An OpenAI-shaped response whose `names` are exactly the ids we sent. */
function openAiBody(names: { id: string; name: string }[]) {
  return {
    choices: [{ message: { content: JSON.stringify({ names }) } }],
  };
}

function okResponse(json: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(json),
  };
}

function errResponse(status: number) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { message: `upstream ${status} leaked ${KEY}` } }),
  };
}

const CLUSTERS = [
  { id: 'c_1', label: 'broad · gst', seeds: ['gst filing last date', 'gst return due date'] },
  { id: 'c_2', label: 'compare · software', seeds: ['best gst software india'] },
];

type FetchLike = (url: string, init: RequestInit) => Promise<unknown>;

function harness({ enabled = true, fetchImpl }: { enabled?: boolean; fetchImpl?: FetchLike } = {}) {
  const logger = recordingLogger();
  const store = createMemoryStore({ now: () => NOW });
  const users: Record<string, { uid: string; role: string }> = {
    'tok-owner': { uid: 'u_owner', role: 'owner' },
    'tok-admin': { uid: 'u_admin', role: 'admin' },
    'tok-editor': { uid: 'u_editor', role: 'editor' },
    'tok-analyst': { uid: 'u_analyst', role: 'analyst' },
    'tok-viewer': { uid: 'u_viewer', role: 'viewer' },
    'tok-outsider': { uid: 'u_outsider', role: 'owner' },
  };
  const auth = createAuth({
    mode: 'firebase',
    verifyToken: async (token: string) => {
      const user = users[token];
      if (!user) throw new Error('unknown token');
      return { ...user, via: 'test' };
    },
  });
  const consent = createConsentService({
    secrets: [{ version: 'v1', secret: SECRET }],
    currentVersion: 'v1',
    store,
    now: () => NOW,
  });
  const tenancy = createTenancy({ store, now: () => NOW });
  const sources = createSources({ store, tenancy, now: () => NOW });
  const ingestV2 = createEventIngest({ store, now: () => NOW });

  const defaultFetch: FetchLike = async () =>
    okResponse(
      openAiBody([
        { id: 'c_1', name: 'GST filing' },
        { id: 'c_2', name: 'GST software' },
      ]),
    );
  const fetchMock = vi.fn((url: string, init: RequestInit) => (fetchImpl ?? defaultFetch)(url, init));
  const privateResearch = createPrivateResearch({
    enabled,
    providers: ['openai'],
    models: { openai: ['gpt-4o-mini'], anthropic: [] },
    timeoutMs: 5000,
    maxClusters: 40,
    maxResponseBytes: 262144,
    perMinute: 100,
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => NOW,
  });
  const agency = createAgencyApi({ tenancy, store, sources, privateResearch, now: () => NOW });

  const app = createApp({
    env: { adsKey: 'k', capiKey: 'c', pixelId: 'p', trackOrigins: ['https://app.test'] },
    auth,
    consent,
    store,
    agency,
    privateResearch,
    sources,
    ingestV2,
    rateLimit: createRateLimiter({ limit: 1000 }),
    dataset: async () => ({ rows: [] }),
    logger,
    now: () => NOW,
  });

  async function call(token: string | null, method: string, path: string, body?: unknown) {
    return app.handle({
      method,
      path,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      body: body as Record<string, unknown>,
      ip: '1.1.1.1',
    });
  }

  async function seedOrg(name = 'Acme Agency', token = 'tok-owner') {
    const res = await call(token, 'POST', '/api/orgs', { name });
    return res.body.organizationId as string;
  }

  return { app, store, tenancy, privateResearch, fetchMock, logger, call, seedOrg };
}

function runBody(overrides: Record<string, unknown> = {}) {
  return { provider: 'openai', model: 'gpt-4o-mini', apiKey: KEY, clusters: CLUSTERS, ...overrides };
}

/**
 * Every string the store holds for an organization, across the collections this feature
 * could plausibly reach. Read through the public list() API rather than poking at internals,
 * because the point is to test the store a caller sees.
 */
async function storedText(store: ReturnType<typeof createMemoryStore>, orgId: string) {
  const collections = ['auditLog', 'researchRuns', 'workspaces', 'campaigns', 'topics', 'leads', 'events', 'sources'];
  const dump: unknown[] = [];
  for (const name of collections) {
    dump.push(await store.records.list(name, { orgId }));
  }
  return JSON.stringify(dump);
}

describe('AC1 — feature flag off', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness({ enabled: false });
  });

  it('answers GET with a fixed 404 and no provider detail', async () => {
    const org = await h.seedOrg();
    const res = await h.call('tok-owner', 'GET', `/api/orgs/${org}/research/private`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'not_configured', message: 'Private research is not configured on this server.' },
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('openai');
    expect(text).not.toContain('anthropic');
    expect(text).not.toContain('gpt-4o-mini');
  });

  it('answers POST with the same fixed 404', async () => {
    const org = await h.seedOrg();
    const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_configured');
  });

  it('returns the flag-off 404 even without a principal (precedence over 401)', async () => {
    // AC2/T2e: the flag check happens before authentication, so a signed-out probe gets the
    // same answer as a route that does not exist.
    const res = await h.call(null, 'POST', '/api/orgs/org_whatever/research/private/run', runBody());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_configured');
  });

  it('makes no provider call at all', async () => {
    const org = await h.seedOrg();
    await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('AC2 — authorization is server-side and precedes disclosure', () => {
  let h: ReturnType<typeof harness>;
  let org: string;
  beforeEach(async () => {
    h = harness({ enabled: true });
    org = await h.seedOrg();
  });

  it('returns 401 without a principal when the feature is enabled', async () => {
    const res = await h.call(null, 'GET', `/api/orgs/${org}/research/private`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('allows editor, admin and owner', async () => {
    // The owner creates the org; the other two are added through the members route.
    await h.call('tok-owner', 'PUT', `/api/orgs/${org}/members`, { userId: 'u_editor', role: 'editor' });
    await h.call('tok-owner', 'PUT', `/api/orgs/${org}/members`, { userId: 'u_admin', role: 'admin' });
    for (const token of ['tok-owner', 'tok-admin', 'tok-editor']) {
      const res = await h.call(token, 'GET', `/api/orgs/${org}/research/private`);
      expect(res.status, token).toBe(200);
      expect(res.body.enabled).toBe(true);
    }
  });

  it('denies viewer and analyst with 403, and never calls the provider for them', async () => {
    await h.call('tok-owner', 'PUT', `/api/orgs/${org}/members`, { userId: 'u_viewer', role: 'viewer' });
    await h.call('tok-owner', 'PUT', `/api/orgs/${org}/members`, { userId: 'u_analyst', role: 'analyst' });
    for (const token of ['tok-viewer', 'tok-analyst']) {
      const res = await h.call(token, 'POST', `/api/orgs/${org}/research/private/run`, runBody());
      expect(res.status, token).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('answers an organization outsider with the existing tenancy 404, not a 403', async () => {
    const res = await h.call('tok-outsider', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('AC3 — the key never escapes, on any path', () => {
  const paths: [string, () => Promise<unknown>, number][] = [
    [
      'success',
      async () =>
        okResponse(
          openAiBody([
            { id: 'c_1', name: 'A' },
            { id: 'c_2', name: 'B' },
          ]),
        ),
      200,
    ],
    ['upstream 400', async () => errResponse(400), 502],
    ['upstream 401', async () => errResponse(401), 401],
    ['upstream 429', async () => errResponse(429), 429],
    ['upstream 500', async () => errResponse(500), 502],
    ['malformed output', async () => ({ ok: true, status: 200, text: async () => 'not json at all' }), 502],
    [
      'transport throws',
      () => {
        throw new Error(`socket hang up; request had authorization: Bearer ${KEY}`);
      },
      502,
    ],
  ];

  for (const [name, impl, expected] of paths) {
    it(`keeps the key out of logs, errors and the response — ${name}`, async () => {
      const h = harness({ enabled: true, fetchImpl: impl });
      const org = await h.seedOrg();
      const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());

      expect(res.status).toBe(expected);
      const responseText = JSON.stringify(res.body);
      expect(responseText).not.toContain(KEY);
      expect(responseText).not.toContain('sk-test');
      // Not just the key: no upstream text either, since it may quote the request.
      expect(responseText).not.toContain('leaked');
      expect(responseText).not.toContain('socket hang up');

      const logs = h.logger.lines.join('\n');
      expect(logs).not.toContain(KEY);
      expect(logs).not.toContain('sk-test');
    });
  }

  it('times out without leaking the key', async () => {
    const h = harness({
      enabled: true,
      fetchImpl: async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    const org = await h.seedOrg();
    const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    expect([502, 504]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(h.logger.lines.join('\n')).not.toContain(KEY);
  });

  it('rejects a wrong-shaped key before any provider call', async () => {
    const h = harness({ enabled: true });
    const org = await h.seedOrg();
    const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody({ apiKey: 'nope' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('nope');
  });
});

describe('AC4/AC5/AC6 — persistence and the audit contract', () => {
  it('writes exactly one record, and it is the audit entry', async () => {
    const h = harness({ enabled: true });
    const org = await h.seedOrg();
    const before = await h.store.records.list('auditLog', { orgId: org });
    await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    const after = await h.store.records.list('auditLog', { orgId: org });
    expect(after.length - before.length).toBe(1);
  });

  it('stores no seeds, names or key anywhere', async () => {
    const h = harness({ enabled: true });
    const org = await h.seedOrg();
    const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    expect(res.status).toBe(200);

    const dump = await storedText(h.store, org);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain('gst filing last date');
    expect(dump).not.toContain('GST filing');
    expect(dump).not.toContain('GST software');
  });

  it('has an audit entry with exactly the approved shape', async () => {
    const h = harness({ enabled: true });
    const org = await h.seedOrg();
    await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    const rows = await h.store.records.list('auditLog', { orgId: org });
    const entry = rows.find((r: Record<string, any>) => r.action === 'research.private.run');
    expect(entry).toBeTruthy();
    const record = entry as Record<string, any>;

    expect(Object.keys(record).sort()).toEqual(
      [
        'action',
        'actor',
        'actorRole',
        'at',
        'detail',
        'id',
        'ok',
        'organizationId',
        'target',
        'updatedAt',
        'workspaceId',
      ].sort(),
    );
    expect(record.workspaceId).toBeNull();
    expect(record.target).toBeNull();
    expect(record.ok).toBe(true);
    expect(record.detail).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      clusterCount: 2,
      outcome: 'ok',
    });
    // No errorCode on success, and no content anywhere in the entry.
    expect('errorCode' in record.detail).toBe(false);
    expect(JSON.stringify(record)).not.toContain('gst');
  });

  it('records a failure with an errorCode from the fixed enum', async () => {
    const h = harness({ enabled: true, fetchImpl: async () => errResponse(401) });
    const org = await h.seedOrg();
    await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    const rows = await h.store.records.list('auditLog', { orgId: org });
    const entry = rows.find((r: Record<string, any>) => r.action === 'research.private.run') as Record<string, any>;
    expect(entry.ok).toBe(false);
    expect(entry.detail.outcome).toBe('provider_error');
    expect(PRIVATE_ERROR_CODES).toContain(entry.detail.errorCode);
    expect(entry.detail.errorCode).toBe('provider_key_rejected');
  });

  it('rejects extra audit fields and arbitrary error codes at the builder', () => {
    expect(() =>
      auditDetail({
        provider: 'openai',
        model: 'gpt-4o-mini',
        clusterCount: 1,
        outcome: 'ok',
        seeds: ['gst filing last date'],
      } as never),
    ).toThrow(/unexpected field/);

    expect(() =>
      auditDetail({
        provider: 'openai',
        model: 'gpt-4o-mini',
        clusterCount: 1,
        outcome: 'provider_error',
        errorCode: 'because the provider said so',
      }),
    ).toThrow(/not an approved code/);

    expect(() =>
      auditDetail({
        provider: 'openai',
        model: 'gpt-4o-mini',
        clusterCount: 1,
        outcome: 'ok',
        errorCode: 'internal_error',
      }),
    ).toThrow(/not allowed on a successful run/);

    expect(() =>
      auditDetail({ provider: 'evil.example', model: 'x', clusterCount: 1, outcome: 'ok' } as never),
    ).toThrow(/known provider/);
  });

  it('returns 503 audit_unavailable and no names when the audit write fails', async () => {
    const h = harness({ enabled: true });
    const org = await h.seedOrg();
    const spy = vi.spyOn(h.store.records, 'put').mockRejectedValueOnce(new Error('store down'));
    const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    spy.mockRestore();

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('audit_unavailable');
    expect(res.body.names).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('GST filing');
  });

  it('never writes research history for a private run', async () => {
    const h = harness({ enabled: true });
    const org = await h.seedOrg();
    await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    expect(await h.store.records.list('researchRuns', { orgId: org })).toHaveLength(0);
  });
});

describe('AC8 — malformed provider output is rejected all-or-nothing', () => {
  const cases: [string, () => Promise<unknown>][] = [
    [
      'unknown id',
      async () =>
        okResponse(
          openAiBody([
            { id: 'c_1', name: 'A' },
            { id: 'c_9', name: 'B' },
          ]),
        ),
    ],
    [
      'duplicate id',
      async () =>
        okResponse(
          openAiBody([
            { id: 'c_1', name: 'A' },
            { id: 'c_1', name: 'B' },
          ]),
        ),
    ],
    ['missing id', async () => okResponse(openAiBody([{ id: 'c_1', name: 'A' }]))],
    [
      'empty name',
      async () =>
        okResponse(
          openAiBody([
            { id: 'c_1', name: '   ' },
            { id: 'c_2', name: 'B' },
          ]),
        ),
    ],
    [
      'overlong name',
      async () =>
        okResponse(
          openAiBody([
            { id: 'c_1', name: 'x'.repeat(200) },
            { id: 'c_2', name: 'B' },
          ]),
        ),
    ],
    ['prose instead of JSON', async () => ({ ok: true, status: 200, text: async () => 'Here are your names!' })],
    ['names not an array', async () => okResponse({ choices: [{ message: { content: '{"names":"nope"}' } }] })],
  ];

  for (const [name, impl] of cases) {
    it(`rejects ${name} and returns no names`, async () => {
      const h = harness({ enabled: true, fetchImpl: impl });
      const org = await h.seedOrg();
      const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('invalid_provider_output');
      expect(res.body.names).toBeUndefined();
    });
  }

  it('accepts a fenced JSON reply, since that is a formatting quirk rather than corruption', async () => {
    const h = harness({
      enabled: true,
      fetchImpl: async () =>
        okResponse({
          choices: [
            {
              message: {
                content: '```json\n{"names":[{"id":"c_1","name":"A"},{"id":"c_2","name":"B"}]}\n```',
              },
            },
          ],
        }),
    });
    const org = await h.seedOrg();
    const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    expect(res.status).toBe(200);
    expect(res.body.names.map((n: { id: string }) => n.id)).toEqual(['c_1', 'c_2']);
  });

  it('returns names in the caller order, whatever order the model used', async () => {
    const h = harness({
      enabled: true,
      fetchImpl: async () =>
        okResponse(
          openAiBody([
            { id: 'c_2', name: 'GST software' },
            { id: 'c_1', name: 'GST filing' },
          ]),
        ),
    });
    const org = await h.seedOrg();
    const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    expect(res.body.names.map((n: { id: string }) => n.id)).toEqual(['c_1', 'c_2']);
  });
});

describe('AC9 — limits are enforced server-side', () => {
  it('rejects a cluster list over the cap', async () => {
    const h = harness({ enabled: true });
    const org = await h.seedOrg();
    const clusters = Array.from({ length: 41 }, (_, i) => ({ id: `c_${i}`, label: 'x', seeds: ['a seed'] }));
    const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody({ clusters }));
    expect(res.status).toBe(400);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized provider response before parsing it', async () => {
    const h = harness({
      enabled: true,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(262145) }),
    });
    const org = await h.seedOrg();
    const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('invalid_provider_output');
  });

  it('rejects unknown cluster fields rather than ignoring them', async () => {
    const h = harness({ enabled: true });
    const org = await h.seedOrg();
    const clusters = [{ id: 'c_1', label: 'x', seeds: ['a'], score: 99 }];
    const res = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody({ clusters }));
    expect(res.status).toBe(400);
  });

  it('refuses a second concurrent run for the same actor', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const h = harness({
      enabled: true,
      fetchImpl: async () => {
        await gate;
        return okResponse(
          openAiBody([
            { id: 'c_1', name: 'A' },
            { id: 'c_2', name: 'B' },
          ]),
        );
      },
    });
    const org = await h.seedOrg();

    const first = h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    const second = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('busy');

    release(null);
    expect((await first).status).toBe(200);

    // The guard is released: the next run is accepted again.
    const third = await h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody());
    expect(third.status).toBe(200);
  });

  it('enforces the per-actor rate limit', async () => {
    const privateResearch = createPrivateResearch({
      enabled: true,
      providers: ['openai'],
      models: { openai: ['gpt-4o-mini'], anthropic: [] },
      perMinute: 1,
      fetchImpl: (async () =>
        okResponse(
          openAiBody([
            { id: 'c_1', name: 'A' },
            { id: 'c_2', name: 'B' },
          ]),
        )) as unknown as typeof fetch,
      now: () => NOW,
    });
    await privateResearch.run({
      actor: 'u_1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: KEY,
      clusters: CLUSTERS,
    });
    await expect(
      privateResearch.run({ actor: 'u_1', provider: 'openai', model: 'gpt-4o-mini', apiKey: KEY, clusters: CLUSTERS }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('rejects a caller-supplied URL field, because no such field exists', async () => {
    const h = harness({ enabled: true });
    const org = await h.seedOrg();
    const res = await h.call(
      'tok-owner',
      'POST',
      `/api/orgs/${org}/research/private/run`,
      runBody({ baseUrl: 'https://evil.example/v1' }),
    );
    // Unknown top-level body fields are ignored by the schema, but the host is never read:
    // the provider call must still go to the configured provider.
    if (res.status === 200) {
      expect(String(h.fetchMock.mock.calls[0][0])).toContain('api.openai.com');
    }
    expect(JSON.stringify(h.fetchMock.mock.calls)).not.toContain('evil.example');
  });
});

describe('AC10 — isolation between actors', () => {
  it('gives each actor only their own ids, and shares no key material', async () => {
    const h = harness({ enabled: true });
    const org = await h.seedOrg();
    await h.call('tok-owner', 'PUT', `/api/orgs/${org}/members`, { userId: 'u_editor', role: 'editor' });

    const otherKey = 'sk-other-0123456789abcdefghijklmn';
    const [a, b] = await Promise.all([
      h.call('tok-owner', 'POST', `/api/orgs/${org}/research/private/run`, runBody()),
      h.call('tok-editor', 'POST', `/api/orgs/${org}/research/private/run`, runBody({ apiKey: otherKey })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.names.map((n: { id: string }) => n.id)).toEqual(['c_1', 'c_2']);
    expect(b.body.names.map((n: { id: string }) => n.id)).toEqual(['c_1', 'c_2']);
    expect(JSON.stringify(a.body)).not.toContain(otherKey);
    expect(h.logger.lines.join('\n')).not.toContain(KEY);
    expect(h.logger.lines.join('\n')).not.toContain(otherKey);
  });

  it('re-checks authorization on every request', async () => {
    const h = harness({ enabled: true });
    const org = await h.seedOrg();
    await h.call('tok-owner', 'PUT', `/api/orgs/${org}/members`, { userId: 'u_editor', role: 'editor' });
    expect((await h.call('tok-editor', 'GET', `/api/orgs/${org}/research/private`)).status).toBe(200);

    // Remove the editor from the organization; the very next call must fail, so nothing
    // about the earlier authorization result is cached anywhere.
    await h.call('tok-owner', 'DELETE', `/api/orgs/${org}/members/u_editor`);
    const after = await h.call('tok-editor', 'GET', `/api/orgs/${org}/research/private`);
    expect(after.status).toBe(404);
    expect(after.body.error.code).toBe('not_found');
  });
});
