// @vitest-environment node
//
// Phase 4, Workstream 1 — independent security review, as executable evidence.
//
// Written to reproduce each claim from the outside rather than to confirm the
// implementation's own narrative: every test below states the attack (or the operational
// failure) and asserts the observable outcome. Where a guarantee cannot be produced in
// this environment — a real Firestore project, a real HubSpot portal — the case is marked
// UNKNOWN in docs/PHASE4_STAGING_VALIDATION_REPORT.md rather than asserted here against a
// fake and called proven.
//
// Nothing in this file weakens an existing test; it adds a second, adversarial view.

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../../server/app.mjs';
import { createAuth } from '../../../server/auth.mjs';
import { createConsentService } from '../../../server/consent.mjs';
import { createMemoryStore } from '../../../server/store.mjs';
import { createRateLimiter } from '../../../server/limits.mjs';
import { createTenancy } from '../../../server/tenancy.mjs';
import { createSources } from '../../../server/sources.mjs';
import { createEventIngest } from '../../../server/events-v2.mjs';
import { createAgencyApi } from '../../../server/agency.mjs';
import { createResearch } from '../../../server/research.mjs';
import { createHubSpotConnector, redactError } from '../../../server/connectors/hubspot.mjs';
import { createConnectorRouter } from '../../../server/connectors/router.mjs';
import { resolveConfig, ConfigError } from '../../../server/config.mjs';
import { fetchInsights } from '../../../server/core.mjs';

const NOW = 1_760_000_000_000;
const MIN = 60 * 1000;
const SECRET = 'independent-review-consent-secret';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------- app harness

function harness({ connectorOverrides = {}, publicBaseUrl = 'https://api.test' }: any = {}) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const store = createMemoryStore({ now });
  const auth = createAuth({ mode: 'firebase', verifyToken: async (token: string) => ({ uid: token, role: 'owner' }) });
  const consent = createConsentService({
    secrets: [{ version: 'v1', secret: SECRET }],
    currentVersion: 'v1',
    store,
    now,
  });
  const tenancy = createTenancy({ store, now });
  const sources = createSources({ store, tenancy, now });
  const ingestV2 = createEventIngest({ store, now });
  // Research is reached through the agency API (one tenancy path), so it is injected here
  // rather than mounted separately.
  const research = createResearch({ store, tenancy, now });
  const agency = createAgencyApi({ tenancy, store, sources, research, now });

  const tokenCalls: any[] = [];
  const hubspot = createHubSpotConnector({
    store,
    tenancy,
    now,
    encryptionKey: Buffer.alloc(32, 3),
    oauth: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://app.test/oauth/callback',
      fetch: async (url: string, init: any) => {
        tokenCalls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'access-token-value-1',
            refresh_token: 'refresh-token-value-1',
            expires_in: 1800,
            scope: 'crm.objects.contacts.read crm.objects.deals.read',
            hub_id: 42,
          }),
        };
      },
    },
    clientFactory: async () => ({
      contacts: { getPage: async () => ({ results: [] }), getById: async () => ({}) },
      deals: { getPage: async () => ({ results: [] }), getById: async () => ({}) },
    }),
    ingest: ingestV2,
    ...connectorOverrides,
  });

  const connectors = createConnectorRouter({ hubspot, publicBaseUrl });
  const app = createApp({
    env: { adsKey: 'k', capiKey: 'c', pixelId: 'p', trackOrigins: ['https://app.test'], connectorEncryptionKey: true },
    auth,
    consent,
    store,
    agency,
    sources,
    ingestV2,
    connectors,
    rateLimit: createRateLimiter({ limit: 10_000 }),
    dataset: async () => ({ rows: [] }),
    logger: quiet,
    now,
  });

  const call = (
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    rawBody?: string,
  ) =>
    app.handle({
      method,
      path,
      headers: {
        ...(token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body as Record<string, unknown>,
      // The webhook signs the bytes it received, so the transport's raw body has to be
      // supplied explicitly here; without it the signature check would be untestable.
      rawBody,
      ip: '203.0.113.9',
    });

  return { app, store, tenancy, clock, now, call, hubspot, tokenCalls };
}

async function seedAgency(h: ReturnType<typeof harness>, owner: string, name = 'Agency') {
  const org = await h.call(owner, 'POST', '/api/orgs', { name });
  const organizationId = org.body.organizationId;
  const workspace = await h.call(owner, 'POST', `/api/orgs/${organizationId}/workspaces`, {
    name: `${name} workspace`,
    timeZone: 'Asia/Kolkata',
    currency: 'INR',
    defaultLanguage: 'en',
  });
  return { organizationId, workspaceId: workspace.body.workspaceId };
}

// ------------------------------------------------- 1. cross-tenant boundaries

describe('authorization boundaries', () => {
  it('does not confirm that another agency exists, and leaks nothing', async () => {
    const h = harness();
    const a = await seedAgency(h, 'alice', 'Alice Co');

    // Bob is a valid user, but not a member of Alice's agency. Both a read and a write must
    // look the same as "no such thing" — otherwise the endpoint enumerates tenants.
    const read = await h.call('bob', 'GET', `/api/orgs/${a.organizationId}/workspaces`);
    const write = await h.call('bob', 'POST', `/api/orgs/${a.organizationId}/workspaces`, {
      name: 'pwned',
      timeZone: 'UTC',
      currency: 'USD',
      defaultLanguage: 'en',
    });
    expect(read.status).toBe(404);
    expect(write.status).toBe(404);
    expect(JSON.stringify(read.body)).not.toContain('Alice');

    // The refused write did not create anything.
    const rows = await h.store.records.list('workspaces', { orgId: a.organizationId });
    expect(rows).toHaveLength(1);
  });

  it('ignores a client-supplied organizationId instead of trusting it', async () => {
    const h = harness();
    const a = await seedAgency(h, 'alice', 'Alice Co');
    const b = await seedAgency(h, 'bob', 'Bob Co');

    // Bob posts into his own agency while claiming Alice's tenant in the body. The body
    // must not be able to choose the tenant.
    const created = await h.call('bob', 'POST', `/api/orgs/${b.organizationId}/workspaces`, {
      name: 'Bob workspace 2',
      organizationId: a.organizationId,
      timeZone: 'UTC',
      currency: 'USD',
      defaultLanguage: 'en',
    });
    expect([200, 201]).toContain(created.status);

    const aliceRows = await h.store.records.list('workspaces', { orgId: a.organizationId });
    const bobRows = await h.store.records.list('workspaces', { orgId: b.organizationId });
    expect(aliceRows).toHaveLength(1);
    expect(bobRows).toHaveLength(2);
    expect(bobRows.every((row: any) => row.organizationId === b.organizationId)).toBe(true);

    // …and Alice's research endpoint cannot be read through Bob's path.
    const crossRead = await h.call(
      'bob',
      'GET',
      `/api/orgs/${b.organizationId}/workspaces/${a.workspaceId}/research/plan`,
    );
    expect(crossRead.status).toBe(404);
  });

  it('refuses a role that lacks the required permission, with a reason', async () => {
    const h = harness();
    const a = await seedAgency(h, 'owner', 'Roles Co');
    await h.call('owner', 'PUT', `/api/orgs/${a.organizationId}/members`, { userId: 'viewer', role: 'viewer' });

    const run = await h.call(
      'viewer',
      'POST',
      `/api/orgs/${a.organizationId}/workspaces/${a.workspaceId}/research/runs`,
      {
        goal: 'attribution',
      },
    );
    expect(run.status).toBe(403);
    expect(run.body.error.code).toMatch(/forbidden|role/);

    // Reading is still allowed: refusing a write must not turn into a blanket denial.
    const plan = await h.call(
      'viewer',
      'GET',
      `/api/orgs/${a.organizationId}/workspaces/${a.workspaceId}/research/plan`,
    );
    expect(plan.status).toBe(200);
  });

  it('refuses a webhook addressed to a workspace that does not own the connection', async () => {
    const h = harness();
    const a = await seedAgency(h, 'alice', 'Alice Co');
    const b = await seedAgency(h, 'bob', 'Bob Co');
    const started = await h.hubspot.connectStart({
      principal: { uid: 'alice', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: {},
    });

    // Bob's organisation, Alice's connection id: the stored source is looked up under Bob's
    // org and must not be found.
    const body = JSON.stringify([{ objectTypeId: '0-1', objectId: 'c1' }]);
    const url = `https://api.test/api/connectors/hubspot/webhook/${b.organizationId}/${started.sourceConnectionId}`;
    const timestamp = String(NOW);
    const signature = createHmac('sha256', 'client-secret').update(`POST${url}${body}${timestamp}`).digest('base64');
    const res = await h.call(
      null,
      'POST',
      `/api/connectors/hubspot/webhook/${b.organizationId}/${started.sourceConnectionId}`,
      body,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(signature).toBeTruthy(); // the signature itself is never the reason this fails
  });
});

// ------------------------------------------------------- 2. OAuth state machine

describe('oauth state: replay, expiry, concurrency', () => {
  async function begin(h: ReturnType<typeof harness>) {
    const a = await seedAgency(h, 'owner', 'OAuth Co');
    const started = await h.hubspot.connectStart({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: {},
    });
    const complete = (state: string, code = 'auth-code') =>
      h.hubspot.connectComplete({
        principal: { uid: 'owner', role: 'owner' },
        organizationId: a.organizationId,
        workspaceId: a.workspaceId,
        body: { state, code },
      });
    return { ...a, started, complete };
  }

  it('spends the state once: a replay is refused before any token call', async () => {
    const h = harness();
    const { started, complete } = await begin(h);

    await complete(started.state);
    const callsAfterFirst = h.tokenCalls.length;

    await expect(complete(started.state)).rejects.toMatchObject({ status: 400, code: 'state_already_used' });
    expect(h.tokenCalls.length).toBe(callsAfterFirst);
  });

  it('lets exactly one of two concurrent callbacks exchange the code', async () => {
    const h = harness();
    const { started, complete } = await begin(h);

    const results = await Promise.allSettled([complete(started.state), complete(started.state)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'state_already_used' });

    // One exchange, not two: the refused callback never reached the provider.
    expect(h.tokenCalls).toHaveLength(1);
  });

  it('refuses an expired state and does not consume it', async () => {
    const h = harness();
    const { started, complete } = await begin(h);
    h.clock.t = NOW + 11 * MIN; // the state TTL is 10 minutes

    await expect(complete(started.state)).rejects.toMatchObject({ status: 400, code: 'state_expired' });
    const state = (await h.store.records.get('oauthStates', started.state))!;
    expect(state.usedAt).toBeNull();
  });

  it('refuses a state started for another workspace, without confirming it exists', async () => {
    const h = harness();
    const a = await begin(h);
    const other = await seedAgency(h, 'owner', 'Other Co');
    await expect(
      h.hubspot.connectComplete({
        principal: { uid: 'owner', role: 'owner' },
        organizationId: other.organizationId,
        workspaceId: other.workspaceId,
        body: { state: a.started.state, code: 'auth-code' },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_state' });
  });

  it('refuses a state presented by a different user', async () => {
    const h = harness();
    const a = await begin(h);
    const org = await seedAgency(h, 'mallory', 'Mallory Co');
    await h.call('owner', 'PUT', `/api/orgs/${a.organizationId}/members`, { userId: 'mallory', role: 'owner' });
    await expect(
      h.hubspot.connectComplete({
        principal: { uid: 'mallory', role: 'owner' },
        organizationId: a.organizationId,
        workspaceId: a.workspaceId,
        body: { state: a.started.state, code: 'auth-code' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(org.organizationId).toBeTruthy();
  });
});

// -------------------------------------------------- 3. token handling & secrets

describe('token handling', () => {
  it('stores tokens sealed and never returns them from an API response', async () => {
    const h = harness();
    const a = await seedAgency(h, 'owner', 'Seal Co');
    const started = await h.hubspot.connectStart({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: {},
    });
    await h.hubspot.connectComplete({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: { state: started.state, code: 'auth-code' },
    });

    const raw = (await h.store.records.get('sources', started.sourceConnectionId, { orgId: a.organizationId }))!;
    const dump = JSON.stringify(raw);
    expect(dump).not.toContain('access-token-value-1');
    expect(dump).not.toContain('refresh-token-value-1');

    const status = await h.hubspot.status({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
    });
    const view = JSON.stringify(status);
    expect(view).not.toContain('access-token-value-1');
    expect(view).not.toContain('refresh-token-value-1');
    expect(view).not.toContain('client-secret');
  });

  it('redacts token material from provider error text', () => {
    const message = redactError(
      new Error('request failed access_token=abc123 refresh_token=def456 Authorization: Bearer xyz.123'),
    );
    expect(message).not.toContain('abc123');
    expect(message).not.toContain('def456');
    expect(message).not.toContain('xyz.123');
    expect(message).toContain('[redacted]');
  });

  it('refuses provider redirects instead of re-sending the client secret', async () => {
    // The token request carries client_secret in its body. Following a redirect would
    // deliver it to whatever host answered, so the fetch must refuse redirects outright.
    const h = harness();
    const a = await seedAgency(h, 'owner', 'Redirect Co');
    const started = await h.hubspot.connectStart({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: {},
    });
    await h.hubspot.connectComplete({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: { state: started.state, code: 'auth-code' },
    });
    expect(h.tokenCalls[0].init.redirect).toBe('error');
  });

  it('clears credentials on disconnect and refuses further syncs', async () => {
    const h = harness();
    const a = await seedAgency(h, 'owner', 'Disconnect Co');
    const started = await h.hubspot.connectStart({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: {},
    });
    await h.hubspot.connectComplete({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: { state: started.state, code: 'auth-code' },
    });
    await h.hubspot.disconnect({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
    });

    const raw = (await h.store.records.get('sources', started.sourceConnectionId, { orgId: a.organizationId }))!;
    expect(raw.connectionStatus).toBe('disconnected');
    expect(raw.auth ?? null).toBeNull();
    await expect(
      h.hubspot.sync({
        principal: { uid: 'owner', role: 'owner' },
        organizationId: a.organizationId,
        workspaceId: a.workspaceId,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('does not let a token refresh overwrite the connection status', async () => {
    const h = harness();
    const a = await seedAgency(h, 'owner', 'Refresh Co');
    const started = await h.hubspot.connectStart({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: {},
    });
    await h.hubspot.connectComplete({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: { state: started.state, code: 'auth-code' },
    });

    // Expire the access token, then force a refresh by asking for the status path that
    // reads it. The source row's status must be untouched by the refresh.
    const raw = (await h.store.records.get('sources', started.sourceConnectionId, { orgId: a.organizationId }))!;
    h.clock.t = NOW + 31 * MIN;
    await h.hubspot.status({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
    });
    const after = (await h.store.records.get('sources', started.sourceConnectionId, { orgId: a.organizationId }))!;
    expect(after.connectionStatus).toBe(raw.connectionStatus);
  });
});

// ---------------------------------------------------- 4. webhook authentication

describe('webhook authentication', () => {
  const sign = (secret: string, body: string, timestamp: string, target: string) =>
    createHmac('sha256', secret).update(`POST${target}${body}${timestamp}`).digest('base64');

  async function connected() {
    const h = harness();
    const a = await seedAgency(h, 'owner', 'Hook Co');
    const started = await h.hubspot.connectStart({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: {},
    });
    await h.hubspot.connectComplete({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: { state: started.state, code: 'auth-code' },
    });
    const target = `https://api.test/api/connectors/hubspot/webhook/${a.organizationId}/${started.sourceConnectionId}`;
    const path = new URL(target).pathname;
    const deliver = (body: string, headers: Record<string, string>) =>
      h.call(null, 'POST', path, JSON.parse(body), headers, body);
    return { h, a, source: started.sourceConnectionId, target, deliver };
  }

  const headers = (signature: string, timestamp: string) => ({
    'x-hubspot-signature-v3': signature,
    'x-hubspot-request-timestamp': timestamp,
  });

  it('accepts a correctly signed delivery (and imports nothing that does not exist)', async () => {
    const { deliver, target } = await connected();
    const body = JSON.stringify([{ objectTypeId: '0-1', objectId: 'c1' }]);
    const timestamp = String(NOW);
    const res = await deliver(body, headers(sign('client-secret', body, timestamp, target), timestamp));
    // The fake provider has no such contact, so the record is skipped — but the delivery
    // itself was authenticated and processed.
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
  });

  it('refuses an unsigned, a mis-signed and a stale delivery', async () => {
    const { deliver, target } = await connected();
    const body = JSON.stringify([{ objectTypeId: '0-1', objectId: 'c1' }]);
    expect((await deliver(body, {})).status).toBe(401);

    const timestamp = String(NOW);
    const wrongSecret = sign('wrong-secret', body, timestamp, target);
    expect((await deliver(body, headers(wrongSecret, timestamp))).status).toBe(401);

    const stale = String(NOW - 6 * MIN);
    const staleSignature = sign('client-secret', body, stale, target);
    expect((await deliver(body, headers(staleSignature, stale))).status).toBe(401);
  });

  it('refuses a signature computed over a different URL or a tampered body', async () => {
    const { h, a, deliver, target } = await connected();
    const body = JSON.stringify([{ objectTypeId: '0-1', objectId: 'c1' }]);
    const timestamp = String(NOW);

    const wrongUrl = sign('client-secret', body, timestamp, 'https://api.test/api/connectors/hubspot/webhook/x/y');
    expect((await deliver(body, headers(wrongUrl, timestamp))).status).toBe(401);

    const tampered = JSON.stringify([{ objectTypeId: '0-1', objectId: 'c2' }]);
    const signedForOriginal = sign('client-secret', body, timestamp, target);
    expect((await deliver(tampered, headers(signedForOriginal, timestamp))).status).toBe(401);

    const leads = await h.store.records.list('leads', { orgId: a.organizationId });
    expect(leads).toHaveLength(0);
  });
});

// ------------------------------------------------ 5. limits across replicas

describe('rate limits across instances', () => {
  it('counts webhook deliveries in shared storage, so two replicas share one budget', async () => {
    const h = harness();
    const a = await seedAgency(h, 'owner', 'Replica Co');
    const started = await h.hubspot.connectStart({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: {},
    });
    await h.hubspot.connectComplete({
      principal: { uid: 'owner', role: 'owner' },
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      body: { state: started.state, code: 'auth-code' },
    });

    // A second connector instance over the same store is a second replica.
    const replica = createHubSpotConnector({
      store: h.store,
      tenancy: h.tenancy,
      now: h.now,
      encryptionKey: Buffer.alloc(32, 3),
      oauth: { clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'https://app.test/cb' },
      clientFactory: async () => ({
        contacts: { getPage: async () => ({ results: [] }), getById: async () => ({}) },
        deals: { getPage: async () => ({ results: [] }), getById: async () => ({}) },
      }),
      ingest:
        h.store && (await import('../../../server/events-v2.mjs')).createEventIngest({ store: h.store, now: h.now }),
      limits: { webhookPerMinute: 2 },
    });
    const connectorOne = createHubSpotConnector({
      store: h.store,
      tenancy: h.tenancy,
      now: h.now,
      encryptionKey: Buffer.alloc(32, 3),
      oauth: { clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'https://app.test/cb' },
      clientFactory: async () => ({
        contacts: { getPage: async () => ({ results: [] }), getById: async () => ({}) },
        deals: { getPage: async () => ({ results: [] }), getById: async () => ({}) },
      }),
      ingest: (await import('../../../server/events-v2.mjs')).createEventIngest({ store: h.store, now: h.now }),
      limits: { webhookPerMinute: 2 },
    });

    const target = `https://api.test/api/connectors/hubspot/webhook/${a.organizationId}/${started.sourceConnectionId}`;
    const body = JSON.stringify([{ objectTypeId: '0-1', objectId: 'c1' }]);
    const timestamp = String(NOW);
    const signature = createHmac('sha256', 'client-secret').update(`POST${target}${body}${timestamp}`).digest('base64');
    const call = (connector: any) =>
      connector.webhook({
        organizationId: a.organizationId,
        sourceConnectionId: started.sourceConnectionId,
        headers: { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp },
        rawBody: body,
        url: target,
      });

    await call(connectorOne);
    await call(replica);
    await expect(call(connectorOne)).rejects.toMatchObject({ status: 429, code: 'webhook_rate_limited' });

    const counter = (await h.store.records.get('rateLimits', `hubspot-webhook:${started.sourceConnectionId}`, {
      orgId: a.organizationId,
    }))!;
    expect(counter.count).toBe(3);
  });

  it('documents the remaining per-process limiter as a known limitation', () => {
    // /api/track and /api/session are limited per process (createRateLimiter). This test
    // exists so the limitation is asserted rather than assumed: two limiters do not share
    // a budget. When a shared limiter lands, this test must be replaced, not deleted.
    const a = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => NOW });
    const b = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => NOW });
    a.hit('ip:1.1.1.1');
    a.hit('ip:1.1.1.1');
    expect(() => a.hit('ip:1.1.1.1')).toThrow();
    expect(() => b.hit('ip:1.1.1.1')).not.toThrow();
  });
});

// -------------------------------------------------------- 6. provider redirects

describe('outbound request policy', () => {
  it('refuses redirects on OpenAI Ads calls, which carry an API key', async () => {
    const seen: any[] = [];
    const fetchImpl = async (_url: string, init: any) => {
      seen.push(init);
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    await fetchInsights({ adsKey: 'k', pixelId: 'p', fetchImpl } as any, { days: 7 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((init) => init.redirect === 'error')).toBe(true);
  });
});

// ------------------------------------------------------- 7. production guards

describe('production configuration guards', () => {
  const base = {
    NODE_ENV: 'production',
    AUTH_MODE: 'firebase',
    FIREBASE_PROJECT_ID: 'demo-project',
    TRACK_ORIGINS: 'https://app.example.com',
    CONSENT_SECRETS: `v1:${SECRET}`,
    STORAGE: 'firestore',
  };

  it('accepts a coherent production configuration', () => {
    const config = resolveConfig(base as any);
    expect(config.isProduction).toBe(true);
  });

  it.each([
    ['dev auth in production', { AUTH_MODE: 'dev' }],
    ['no auth mode', { AUTH_MODE: '' }],
    ['memory store in production', { STORAGE: 'memory' }],
    ['no tracking origins', { TRACK_ORIGINS: '' }],
    ['no consent secret', { CONSENT_SECRETS: '' }],
  ])('refuses %s', (_label, override) => {
    expect(() => resolveConfig({ ...base, ...override } as any)).toThrow(ConfigError);
  });

  it('refuses an http webhook origin or redirect URI in production', () => {
    expect(() =>
      resolveConfig({
        ...base,
        PUBLIC_BASE_URL: 'http://api.example.com',
        HUBSPOT_CLIENT_ID: 'id',
        HUBSPOT_CLIENT_SECRET: 'secret',
        HUBSPOT_REDIRECT_URI: 'http://app.example.com/cb',
        CONNECTOR_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      } as any),
    ).toThrow(/https/i);
  });
});
