// @vitest-environment node
//
// HTTP-level tests for the two new route families.
//
// These go through the real `app.handle`, because the risks being tested are routing
// risks: the HubSpot webhook is public by necessity, so it must be reachable *without* a
// bearer token, and it must be the only connector route that is. Research routes must
// authenticate and scope like every other agency route.

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
import { createHubSpotConnector } from '../../../server/connectors/hubspot.mjs';
import { createConnectorRouter } from '../../../server/connectors/router.mjs';

const KEY = Buffer.alloc(32, 3);
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const BASE = 'https://api.test';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

const contact = (id: string) => ({
  id,
  properties: {
    hs_object_id: id,
    createdate: String(NOW - 3 * 24 * 3600 * 1000),
    hs_lastmodifieddate: String(NOW - 24 * 3600 * 1000),
    country: 'IN',
  },
  associations: {},
});

function harness({
  configured = true,
  publicBaseUrl = BASE as string | null,
  client = null,
}: { configured?: boolean; publicBaseUrl?: string | null; client?: any } = {}) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const store = createMemoryStore({ now });
  const users: Record<string, { uid: string; role: string }> = {
    'tok-owner': { uid: 'u_owner', role: 'owner' },
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
    secrets: [{ version: 'v1', secret: 'consent-secret-for-route-tests' }],
    currentVersion: 'v1',
    store,
    now,
  });
  const tenancy = createTenancy({ store, now });
  const sources = createSources({ store, tenancy, now });
  const ingestV2 = createEventIngest({ store, now });
  const agency = createAgencyApi({ tenancy, store, sources, now });

  const fakeClient = client ?? {
    contacts: { getPage: async () => ({ results: [], paging: undefined }), getById: async () => contact('c1') },
    deals: { getPage: async () => ({ results: [], paging: undefined }), getById: async () => contact('d1') },
  };

  const hubspot = createHubSpotConnector({
    store,
    tenancy,
    now,
    sleep: async () => {},
    encryptionKey: configured ? KEY : null,
    oauth: configured
      ? {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: 'https://app.test/oauth/callback',
          fetch: async () => ({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'sealed-access',
              refresh_token: 'sealed-refresh',
              expires_in: 1800,
              scope: 'crm.objects.contacts.read crm.objects.deals.read',
              hub_id: 1,
            }),
          }),
        }
      : { clientId: null, clientSecret: null, redirectUri: null },
    clientFactory: () => fakeClient,
    ingest: ingestV2,
  });

  const connectors = createConnectorRouter({ hubspot, publicBaseUrl: configured ? publicBaseUrl : publicBaseUrl });

  const app = createApp({
    env: { adsKey: 'k', capiKey: 'c', pixelId: 'p', trackOrigins: ['https://app.test'], ingestToleranceSeconds: 300 },
    auth,
    consent,
    store,
    agency,
    sources,
    ingestV2,
    connectors,
    rateLimit: createRateLimiter({ limit: 1000 }),
    dataset: async () => ({ rows: [] }),
    logger: quiet,
    now,
  });

  const call = (
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.handle({
      method,
      path,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body as Record<string, unknown>,
      rawBody: body === undefined ? undefined : JSON.stringify(body),
    });

  async function seed() {
    const org = await tenancy.createOrg({ uid: 'u_owner' }, { name: 'Agency A' });
    const ws = await tenancy.createWorkspace({ uid: 'u_owner' }, org.organizationId, {
      name: 'Acme India',
      clientName: 'Acme',
      timeZone: 'Asia/Kolkata',
      currency: 'INR',
      defaultLanguage: 'en-IN',
      targetMarkets: [{ countryCode: 'IN' }],
    });
    return { organizationId: org.organizationId, workspaceId: ws.workspaceId };
  }

  async function connect(org: { organizationId: string; workspaceId: string }) {
    const start = await call(
      'tok-owner',
      'POST',
      `/api/orgs/${org.organizationId}/workspaces/${org.workspaceId}/connectors/hubspot/connect`,
      {},
    );
    expect(start.status).toBe(200);
    const done = await call(
      'tok-owner',
      'POST',
      `/api/orgs/${org.organizationId}/workspaces/${org.workspaceId}/connectors/hubspot/connect/complete`,
      {
        code: 'auth-code',
        state: (start.body as { state: string }).state,
      },
    );
    expect(done.status).toBe(200);
    const [source] = await store.records.list('sources', { orgId: org.organizationId });
    return source;
  }

  return { store, tenancy, app, call, seed, connect, hubspot, clock };
}

describe('connector routes', () => {
  it('requires authentication for tenant routes', async () => {
    const h = harness();
    const org = await h.seed();
    const res = await h.call(
      null,
      'GET',
      `/api/orgs/${org.organizationId}/workspaces/${org.workspaceId}/connectors/hubspot`,
    );
    expect(res.status).toBe(401);
  });

  it('reports status and refuses writes from a viewer', async () => {
    const h = harness();
    const org = await h.seed();
    await h.tenancy.setMember({ uid: 'u_owner' }, org.organizationId, { userId: 'u_viewer', role: 'viewer' });

    const status = await h.call(
      'tok-viewer',
      'GET',
      `/api/orgs/${org.organizationId}/workspaces/${org.workspaceId}/connectors/hubspot`,
    );
    expect(status.status).toBe(200);
    expect((status.body as { status: string }).status).toBe('not_connected');

    const sync = await h.call(
      'tok-viewer',
      'POST',
      `/api/orgs/${org.organizationId}/workspaces/${org.workspaceId}/connectors/hubspot/sync`,
      {},
    );
    expect(sync.status).toBe(403);
  });

  it('answers 503 with the missing variables when no OAuth client is configured', async () => {
    const h = harness({ configured: false });
    const org = await h.seed();
    const res = await h.call(
      'tok-owner',
      'POST',
      `/api/orgs/${org.organizationId}/workspaces/${org.workspaceId}/connectors/hubspot/connect`,
      {},
    );
    expect(res.status).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe('connector_not_configured');
  });

  it('404s for another organization, before any provider call', async () => {
    const h = harness();
    const mine = await h.seed();
    await h.connect(mine);
    const org = await h.tenancy.createOrg({ uid: 'u_outsider' }, { name: 'Agency B' });
    const res = await h.call(
      'tok-outsider',
      'GET',
      `/api/orgs/${org.organizationId}/workspaces/${mine.workspaceId}/connectors/hubspot`,
    );
    expect(res.status).toBe(404);
  });

  it('serves a signed webhook without a bearer token, and only with a valid signature', async () => {
    const h = harness();
    const org = await h.seed();
    const source = await h.connect(org);
    const path = `/api/connectors/hubspot/webhook/${org.organizationId}/${source.sourceConnectionId}`;
    const body = [{ objectTypeId: '0-1', objectId: 'c1' }];
    const raw = JSON.stringify(body);
    const timestamp = String(NOW);
    const signature = createHmac('sha256', 'client-secret')
      .update(`POST${BASE}${path}${raw}${timestamp}`)
      .digest('base64');

    // No Authorization header: the signature is the credential.
    const ok = await h.call(null, 'POST', path, body, {
      'x-hubspot-signature-v3': signature,
      'x-hubspot-request-timestamp': timestamp,
    });
    expect(ok.status).toBe(200);

    const unsigned = await h.call(null, 'POST', path, body);
    expect(unsigned.status).toBe(401);

    const wrong = await h.call(null, 'POST', path, body, {
      'x-hubspot-signature-v3': 'not-a-signature',
      'x-hubspot-request-timestamp': timestamp,
    });
    expect(wrong.status).toBe(401);
  });

  it('refuses the webhook when PUBLIC_BASE_URL is unset, rather than guessing the signed URL', async () => {
    const h = harness({ publicBaseUrl: null });
    const org = await h.seed();
    const source = await h.connect(org);
    const res = await h.call(
      null,
      'POST',
      `/api/connectors/hubspot/webhook/${org.organizationId}/${source.sourceConnectionId}`,
      [],
    );
    expect(res.status).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe('webhook_not_configured');
  });
});

describe('research routes', () => {
  it('serves the plan, and saves and lists runs for a permitted role', async () => {
    const h = harness();
    const org = await h.seed();
    const base = `/api/orgs/${org.organizationId}/workspaces/${org.workspaceId}/research`;

    const plan = await h.call('tok-owner', 'GET', `${base}/plan`);
    expect(plan.status).toBe(200);
    expect((plan.body as { steps: unknown[] }).steps.length).toBeGreaterThan(0);

    const created = await h.call('tok-owner', 'POST', `${base}/runs`, { goal: 'sources' });
    expect(created.status).toBe(201);
    const runId = (created.body as { runId: string }).runId;

    const list = await h.call('tok-owner', 'GET', `${base}/runs`);
    expect(list.status).toBe(200);
    expect((list.body as { runs: { runId: string }[] }).runs.map((r) => r.runId)).toEqual([runId]);

    const one = await h.call('tok-owner', 'GET', `${base}/runs/${runId}`);
    expect(one.status).toBe(200);

    const removed = await h.call('tok-owner', 'DELETE', `${base}/runs/${runId}`);
    expect(removed.status).toBe(200);
    const gone = await h.call('tok-owner', 'GET', `${base}/runs/${runId}`);
    expect(gone.status).toBe(404);
  });

  it('lets a viewer read but not create, and hides runs from another organization', async () => {
    const h = harness();
    const org = await h.seed();
    await h.tenancy.setMember({ uid: 'u_owner' }, org.organizationId, { userId: 'u_viewer', role: 'viewer' });
    const base = `/api/orgs/${org.organizationId}/workspaces/${org.workspaceId}/research`;

    expect((await h.call('tok-viewer', 'GET', `${base}/plan`)).status).toBe(200);
    expect((await h.call('tok-viewer', 'POST', `${base}/runs`, { goal: 'sources' })).status).toBe(403);

    const other = await h.tenancy.createOrg({ uid: 'u_outsider' }, { name: 'Agency B' });
    const foreign = await h.call(
      'tok-outsider',
      'GET',
      `/api/orgs/${other.organizationId}/workspaces/${org.workspaceId}/research/plan`,
    );
    expect(foreign.status).toBe(404);
  });

  it('rejects an unauthenticated research call', async () => {
    const h = harness();
    const org = await h.seed();
    const res = await h.call(
      null,
      'GET',
      `/api/orgs/${org.organizationId}/workspaces/${org.workspaceId}/research/plan`,
    );
    expect(res.status).toBe(401);
  });
});
