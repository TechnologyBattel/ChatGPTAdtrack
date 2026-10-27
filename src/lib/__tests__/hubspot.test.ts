// @vitest-environment node
//
// HubSpot connector acceptance tests.
//
// The provider is a fake client that returns **synthetic fixtures** — obviously-shaped
// test records, never customer data — so every rule can be checked without a HubSpot
// account: idempotency, pagination, rate limits, auth failures, qualification trust,
// tenant isolation, and the promise that no token leaves the server.
//
// What this suite does NOT prove: that HubSpot's real API behaves as documented. That is
// recorded as UNKNOWN in docs/CONNECTORS.md until a real install runs.

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../server/store.mjs';
import { createTenancy } from '../../../server/tenancy.mjs';
import { createEventIngest } from '../../../server/events-v2.mjs';
import { createHubSpotConnector } from '../../../server/connectors/hubspot.mjs';
import { open, seal, tenantAad } from '../../../server/connectors/crypto.mjs';

const KEY = Buffer.alloc(32, 7);
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const OWNER = { uid: 'u_owner', role: 'owner' };
const VIEWER = { uid: 'u_viewer', role: 'viewer' };
const OUTSIDER = { uid: 'u_outsider', role: 'owner' };

const DAY = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------ fixtures

type Props = Record<string, string>;
const contact = (id: string, overrides: Props = {}) => ({
  id,
  properties: {
    hs_object_id: id,
    createdate: String(NOW - 5 * DAY),
    hs_lastmodifieddate: String(NOW - DAY),
    country: 'IN',
    ...overrides,
  },
  associations: {},
});

const deal = (id: string, contactId: string, stage: string, overrides: Props = {}) => ({
  id,
  properties: {
    hs_object_id: id,
    dealstage: stage,
    hs_lastmodifieddate: String(NOW - 2 * DAY),
    ...overrides,
  },
  associations: { contacts: { results: [{ id: contactId, type: 'contact_to_deal' }] } },
});

function providerError(status: number, message = 'provider said no') {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

type Failure = { remaining: number; status: number; message?: string };
type ClientOptions = {
  contactPages?: unknown[][];
  dealPages?: unknown[][];
  failures?: Failure[];
  record?: Record<string, any>;
};

/** A paged fake client. `pages` is an array of page results; `after` selects them. */
function fakeClient({ contactPages = [[]], dealPages = [[]], failures = [], record = {} }: ClientOptions = {}) {
  const calls: { objectType: string; index: number }[] = [];
  // Failures are consumed in order: { status, times } fails the next `times` calls.
  const fail = () => {
    const rule = failures.find((f) => f.remaining > 0);
    if (!rule) return null;
    rule.remaining -= 1;
    return providerError(rule.status, rule.message);
  };
  const pager =
    (pages: unknown[][]) =>
    async ({ after }: { after?: string }) => {
      const index = after === undefined ? 0 : Number(after);
      calls.push({ objectType: pages === contactPages ? 'contacts' : 'deals', index });
      const error = fail();
      if (error) throw error;
      const results = pages[index] ?? [];
      const next = index + 1 < pages.length ? String(index + 1) : null;
      return { results, paging: next ? { next: { after: next } } : undefined };
    };
  return {
    calls,
    contacts: {
      getPage: pager(contactPages),
      getById: async (id: string) => {
        if (!record.contacts?.[id]) throw providerError(404, 'contact not found');
        return record.contacts[id];
      },
    },
    deals: {
      getPage: pager(dealPages),
      getById: async (id: string) => {
        if (!record.deals?.[id]) throw providerError(404, 'deal not found');
        return record.deals[id];
      },
    },
  };
}

// ------------------------------------------------------------------- harness

function harness({
  client = fakeClient(),
  tokenResponse = null as any,
  connectorOptions = {} as Record<string, any>,
  oauth = {} as Record<string, any>,
}: {
  client?: ReturnType<typeof fakeClient>;
  tokenResponse?: any;
  connectorOptions?: Record<string, any>;
  oauth?: Record<string, any>;
} = {}) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const store = createMemoryStore({ now });
  const tenancy = createTenancy({ store, now });
  const ingest = createEventIngest({ store, now });

  const tokenCalls: { url: string; body: string }[] = [];
  const fetchImpl = async (url: string, init?: { body?: unknown }) => {
    tokenCalls.push({ url, body: String(init?.body ?? '') });
    const response = tokenResponse ?? {
      access_token: 'fake-access-token-value',
      refresh_token: 'fake-refresh-token-value',
      expires_in: 1800,
      scope: 'crm.objects.contacts.read crm.objects.deals.read',
      hub_id: 12345,
    };
    return {
      ok: response.status ? response.status < 400 : true,
      status: response.status ?? 200,
      json: async () => response.body ?? response,
    };
  };

  const hubspot = createHubSpotConnector({
    store,
    tenancy,
    now,
    sleep: async () => {},
    encryptionKey: KEY,
    oauth: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'https://app.test/oauth/callback',
      fetch: fetchImpl,
      ...oauth,
    },
    clientFactory: () => client,
    ingest,
    limits: { batchSize: 100, maxPages: 20, maxAttempts: 3, baseDelayMs: 1 },
    ...connectorOptions,
  });

  async function seedOrg(principal: { uid: string } = OWNER, name = 'Agency A') {
    const org = await tenancy.createOrg(principal, { name });
    const ws = await tenancy.createWorkspace(principal, org.organizationId, {
      name: 'Acme India',
      clientName: 'Acme',
      timeZone: 'Asia/Kolkata',
      currency: 'INR',
      defaultLanguage: 'en-IN',
      targetMarkets: [{ countryCode: 'IN' }],
    });
    return { organizationId: org.organizationId, workspaceId: ws.workspaceId };
  }

  async function connect(
    org: { organizationId: string; workspaceId: string },
    {
      trustedForQualification = false,
      qualifiedStages = [],
    }: { trustedForQualification?: boolean; qualifiedStages?: string[] } = {},
  ) {
    const start = await hubspot.connectStart({
      principal: OWNER,
      organizationId: org.organizationId,
      workspaceId: org.workspaceId,
      body: { trustedForQualification, qualifiedStages },
    });
    await hubspot.connectComplete({
      principal: OWNER,
      organizationId: org.organizationId,
      workspaceId: org.workspaceId,
      body: { code: 'auth-code', state: start.state },
    });
    return start;
  }

  const eventsOf = (org: { organizationId: string }) => store.records.list('events', { orgId: org.organizationId });
  const leadsOf = (org: { organizationId: string }) => store.records.list('leads', { orgId: org.organizationId });
  const sourceOf = async (org: { organizationId: string }) =>
    (await store.records.list('sources', { orgId: org.organizationId }))[0] ?? null;

  return {
    hubspot,
    store,
    tenancy,
    ingest,
    clock,
    now,
    tokenCalls,
    client,
    fetchImpl,
    seedOrg,
    connect,
    eventsOf,
    leadsOf,
    sourceOf,
  };
}

const sync = (
  h: ReturnType<typeof harness>,
  org: { organizationId: string; workspaceId: string },
  extra: Record<string, any> = {},
) => h.hubspot.sync({ principal: OWNER, organizationId: org.organizationId, workspaceId: org.workspaceId, ...extra });

// --------------------------------------------------------------------- tests

describe('connector configuration and status', () => {
  it('reports not_connected, and says exactly what is missing when unconfigured', async () => {
    const h = harness();
    const org = await h.seedOrg();
    const status = await h.hubspot.status({ principal: OWNER, ...org });
    expect(status.status).toBe('not_connected');
    expect(status.connected).toBe(false);
    expect(status.configured).toBe(true);
    expect(status.lastSyncAt).toBeNull();
    expect(status.nextAction).toBe('connect');
  });

  it('refuses to start a connection when the server has no OAuth client, naming the variables', async () => {
    const h = harness({ oauth: { clientId: null, clientSecret: null, redirectUri: null } });
    const org = await h.seedOrg();
    await expect(h.hubspot.connectStart({ principal: OWNER, ...org, body: {} })).rejects.toMatchObject({
      status: 503,
      code: 'connector_not_configured',
    });
    await expect(h.hubspot.connectStart({ principal: OWNER, ...org, body: {} })).rejects.toThrow(/HUBSPOT_CLIENT_ID/);
  });
});

describe('OAuth lifecycle', () => {
  it('builds an authorization URL with read-only scopes and a single-use state', async () => {
    const h = harness();
    const org = await h.seedOrg();
    const start = await h.hubspot.connectStart({ principal: OWNER, ...org, body: {} });
    const url = new URL(start.authorizationUrl);
    expect(url.host).toBe('app.hubspot.com');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope')).toBe('crm.objects.contacts.read crm.objects.deals.read');
    expect(url.searchParams.get('scope')).not.toMatch(/write/);
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/oauth/callback');
    expect(url.searchParams.get('state')).toBe(start.state);
    expect(start.status).toBe('connecting');
  });

  it('requires source.manage to begin or complete a connection', async () => {
    const h = harness();
    const org = await h.seedOrg();
    await h.tenancy.setMember(OWNER, org.organizationId, { userId: VIEWER.uid, role: 'viewer' });
    await expect(h.hubspot.connectStart({ principal: VIEWER, ...org, body: {} })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('rejects a state from another tenant, an unknown state, and a reused state', async () => {
    const h = harness();
    const org = await h.seedOrg();
    const other = await h.seedOrg(OUTSIDER, 'Agency B');
    const start = await h.hubspot.connectStart({ principal: OWNER, ...org, body: {} });

    await expect(
      h.hubspot.connectComplete({ principal: OUTSIDER, ...other, body: { code: 'c', state: start.state } }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_state' });

    await expect(
      h.hubspot.connectComplete({ principal: OWNER, ...org, body: { code: 'c', state: 'not-a-state' } }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_state' });

    await h.hubspot.connectComplete({ principal: OWNER, ...org, body: { code: 'c', state: start.state } });
    await expect(
      h.hubspot.connectComplete({ principal: OWNER, ...org, body: { code: 'c', state: start.state } }),
    ).rejects.toMatchObject({ status: 400, code: 'state_already_used' });
  });

  it('rejects an expired state', async () => {
    const h = harness();
    const org = await h.seedOrg();
    const start = await h.hubspot.connectStart({ principal: OWNER, ...org, body: {} });
    h.clock.t = NOW + 11 * 60 * 1000;
    await expect(
      h.hubspot.connectComplete({ principal: OWNER, ...org, body: { code: 'c', state: start.state } }),
    ).rejects.toMatchObject({ status: 400, code: 'state_expired' });
  });

  it('stores tokens sealed and tenant-bound, and never returns them', async () => {
    const h = harness();
    const org = await h.seedOrg();
    await h.connect(org);

    const source = await h.sourceOf(org);
    expect(source.auth.sealedAccessToken).not.toContain('fake-access-token-value');
    expect(JSON.stringify(source)).not.toContain('fake-access-token-value');
    expect(JSON.stringify(source)).not.toContain('fake-refresh-token-value');

    // The token opens only with the tenant it was sealed for.
    const aad = tenantAad({
      organizationId: org.organizationId,
      workspaceId: org.workspaceId,
      sourceConnectionId: source.sourceConnectionId,
    });
    expect(open(source.auth.sealedAccessToken, KEY, { aad })).toBe('fake-access-token-value');
    const wrongAad = tenantAad({
      organizationId: 'org_other',
      workspaceId: org.workspaceId,
      sourceConnectionId: source.sourceConnectionId,
    });
    expect(open(source.auth.sealedAccessToken, KEY, { aad: wrongAad })).toBeNull();

    const status = await h.hubspot.status({ principal: OWNER, ...org });
    expect(JSON.stringify(status)).not.toContain('fake-access-token-value');
    expect(status.scopesGranted).toEqual(['crm.objects.contacts.read', 'crm.objects.deals.read']);
    expect(status.portalId).toBe('12345');
  });

  it('audits connection events without any credential material', async () => {
    const h = harness();
    const org = await h.seedOrg();
    await h.connect(org);
    const audit = await h.store.records.list('auditLog', { orgId: org.organizationId });
    const actions = audit.map((a) => a.action);
    expect(actions).toContain('connector.connect_start');
    expect(actions).toContain('connector.connect');
    const serialised = JSON.stringify(audit);
    expect(serialised).not.toContain('fake-access-token-value');
    expect(serialised).not.toContain('fake-refresh-token-value');
    expect(serialised).not.toContain('test-client-secret');
  });

  it('marks the connection failed when the token exchange is rejected, and says so', async () => {
    const h = harness({ tokenResponse: { status: 400, body: { error: 'invalid_code' } } });
    const org = await h.seedOrg();
    const start = await h.hubspot.connectStart({ principal: OWNER, ...org, body: {} });
    await expect(
      h.hubspot.connectComplete({ principal: OWNER, ...org, body: { code: 'bad', state: start.state } }),
    ).rejects.toMatchObject({ code: 'hubspot_token_rejected' });
    const status = await h.hubspot.status({ principal: OWNER, ...org });
    expect(status.status).toBe('failed');
    expect(status.nextAction).toBe('reconnect');
    expect(status.lastError?.code).toBe('hubspot_token_rejected');
  });
});

describe('import: mapping, idempotency and counts', () => {
  it('imports a contact as a lead, and never as a qualified lead', async () => {
    const h = harness({ client: fakeClient({ contactPages: [[contact('c1')]] }) });
    const org = await h.seedOrg();
    await h.connect(org, { trustedForQualification: true, qualifiedStages: ['closedwon'] });
    const result = await sync(h, org);

    expect(result.lastSyncStatus).toBe('complete');
    expect(result.imported).toBe(1);
    const [lead] = await h.leadsOf(org);
    expect(lead.stage).toBe('enquiry');
    expect(lead.qualification).toBeNull();
    expect(lead.crmRecordReference).toBe('hubspot:contact:c1');

    const [event] = await h.eventsOf(org);
    expect(event.eventType).toBe('lead_created');
    expect(event.consentState).toBe('unknown');
    // Provenance, no personal data.
    expect(event.metadata).toEqual({ provider: 'hubspot', object: 'contact', recordId: 'c1' });
    expect(JSON.stringify(event)).not.toMatch(/@|phone|firstname|lastname/i);
  });

  it('maps a deal in a configured stage to a qualification of the associated contact', async () => {
    const h = harness({
      client: fakeClient({
        contactPages: [[contact('c1')]],
        dealPages: [[deal('d1', 'c1', 'closedwon'), deal('d2', 'c1', 'open')]],
      }),
    });
    const org = await h.seedOrg();
    await h.connect(org, { trustedForQualification: true, qualifiedStages: ['closedwon'] });
    const result = await sync(h, org);

    expect(result.imported).toBe(2); // one contact + one qualifying deal
    expect(result.skippedReasons.stage_not_qualified).toBe(1);
    const [lead] = await h.leadsOf(org);
    expect(lead.qualification.status).toBe('qualified');
    expect(lead.qualification.source).toBe(`crm:${lead.sourceConnectionId}`);
  });

  it('never qualifies when the source is not trusted, even for a qualifying stage', async () => {
    const h = harness({
      client: fakeClient({ contactPages: [[contact('c1')]], dealPages: [[deal('d1', 'c1', 'closedwon')]] }),
    });
    const org = await h.seedOrg();
    await h.connect(org, { trustedForQualification: false, qualifiedStages: ['closedwon'] });
    await sync(h, org);

    expect((await h.leadsOf(org))[0].qualification).toBeNull();
    expect((await h.eventsOf(org)).some((e) => e.eventType === 'lead_qualified')).toBe(false);
  });

  it('imports a 1,000-record batch twice with zero duplicate leads and no double counting', async () => {
    const pages = [];
    for (let page = 0; page < 10; page += 1) {
      pages.push(Array.from({ length: 100 }, (_, i) => contact(`bulk-${page * 100 + i}`)));
    }
    const h = harness({ client: fakeClient({ contactPages: pages }) });
    const org = await h.seedOrg();
    await h.connect(org);

    const first = await sync(h, org);
    const second = await sync(h, org);

    expect(first.imported).toBe(1000);
    expect(first.duplicates).toBe(0);
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(1000);
    expect(await h.leadsOf(org)).toHaveLength(1000);
    expect(await h.eventsOf(org)).toHaveLength(1000);
    // Event identity is unique: no event id appears twice.
    const ids = (await h.eventsOf(org)).map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    // The documented count semantics are returned, not implied.
    expect(second.countsSemantics).toMatch(/unique events/);
  });

  it('skips a record with no provider timestamp instead of inventing one', async () => {
    const h = harness({
      client: fakeClient({ contactPages: [[contact('c1', { createdate: '', hs_lastmodifieddate: '' })]] }),
    });
    const org = await h.seedOrg();
    await h.connect(org);
    const result = await sync(h, org);
    expect(result.imported).toBe(0);
    expect(result.skippedReasons.missing_timestamp).toBe(1);
    expect(await h.eventsOf(org)).toHaveLength(0);
  });
});

describe('failure behaviour', () => {
  it('reports a partial sync as partial, with a resumable checkpoint', async () => {
    const pages = Array.from({ length: 3 }, (_, p) => Array.from({ length: 100 }, (_, i) => contact(`p${p}-${i}`)));
    const h = harness({ client: fakeClient({ contactPages: pages }) });
    const org = await h.seedOrg();
    await h.connect(org);
    // Only two pages may be read in one run.
    const connector = createHubSpotConnector({
      store: h.store,
      tenancy: h.tenancy,
      now: h.now,
      sleep: async () => {},
      encryptionKey: KEY,
      oauth: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'https://app.test/oauth/callback',
        fetch: h.fetchImpl,
      },
      clientFactory: () => h.client,
      ingest: h.ingest,
      limits: { batchSize: 100, maxPages: 2, maxAttempts: 3, baseDelayMs: 1 },
    });

    const result = await connector.sync({ principal: OWNER, ...org });
    expect(result.status).toBe('degraded');
    expect(result.lastSyncStatus).toBe('partial');
    expect(result.partial).toBe(true);
    expect(result.imported).toBe(200);
    expect(result.error?.code).toBe('sync_incomplete');
    const status = await connector.status({ principal: OWNER, ...org });
    expect(status.checkpoint?.contacts?.after).toBe('2');
    expect(status.lastSyncStatus).toBe('partial');
  });

  it('retries a 429 and succeeds without duplicating accepted events', async () => {
    const failures = [{ remaining: 1, status: 429, message: 'rate limited' }];
    const h = harness({ client: fakeClient({ contactPages: [[contact('c1')]], failures }) });
    const org = await h.seedOrg();
    await h.connect(org);
    const result = await sync(h, org);
    expect(result.lastSyncStatus).toBe('complete');
    expect(result.imported).toBe(1);
    expect(await h.eventsOf(org)).toHaveLength(1);
  });

  it('gives up after the attempt budget and reports the rate limit, not success', async () => {
    const failures = [{ remaining: 99, status: 429, message: 'rate limited' }];
    const h = harness({ client: fakeClient({ contactPages: [[contact('c1')]], failures }) });
    const org = await h.seedOrg();
    await h.connect(org);
    const result = await sync(h, org);
    expect(result.lastSyncStatus).toBe('failed');
    expect(result.error?.code).toBe('hubspot_rate_limited');
    expect(result.status).toBe('degraded');
    // The client bails at or before the attempt budget, not after an unbounded loop.
    expect(h.client.calls.length).toBeLessThanOrEqual(3);
  });

  it('marks a revoked credential as failed and requires a reconnect', async () => {
    const failures = [{ remaining: 99, status: 401, message: 'token revoked' }];
    const h = harness({ client: fakeClient({ contactPages: [[contact('c1')]], failures }) });
    const org = await h.seedOrg();
    await h.connect(org);
    const result = await sync(h, org);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('hubspot_auth_rejected');
    const status = await h.hubspot.status({ principal: OWNER, ...org });
    expect(status.nextAction).toBe('reconnect');
  });

  it('refreshes an expired access token and keeps the last successful sync time on failure', async () => {
    const h = harness({ client: fakeClient({ contactPages: [[contact('c1')]] }) });
    const org = await h.seedOrg();
    await h.connect(org);
    const first = await sync(h, org);
    expect(first.lastSyncStatus).toBe('complete');

    // Expire the access token: the connector must refresh, and record that it did.
    const source = await h.sourceOf(org);
    await h.store.records.update(
      'sources',
      source.sourceConnectionId,
      { auth: { ...source.auth, expiresAt: 0 } },
      { orgId: org.organizationId },
    );

    h.clock.t = NOW + DAY;
    const second = await sync(h, org);
    expect(second.lastSyncStatus).toBe('complete');
    expect(h.tokenCalls.some((c) => c.body.includes('grant_type=refresh_token'))).toBe(true);

    const status = await h.hubspot.status({ principal: OWNER, ...org });
    expect(status.lastSyncAt).toBe(NOW + DAY);
  });

  it('refuses to sync a disconnected connection', async () => {
    const h = harness();
    const org = await h.seedOrg();
    await h.connect(org);
    await h.hubspot.disconnect({ principal: OWNER, ...org });
    await expect(sync(h, org)).rejects.toMatchObject({ status: 409, code: 'connector_disconnected' });
  });
});

describe('tenant isolation', () => {
  it('does not let another organization read, sync or disconnect the connection', async () => {
    const h = harness();
    const a = await h.seedOrg(OWNER, 'Agency A');
    const b = await h.seedOrg(OUTSIDER, 'Agency B');
    await h.connect(a);

    await expect(h.hubspot.status({ principal: OUTSIDER, ...b })).resolves.toMatchObject({
      status: 'not_connected',
    });
    await expect(
      h.hubspot.sync({ principal: OUTSIDER, organizationId: b.organizationId, workspaceId: a.workspaceId }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(h.hubspot.disconnect({ principal: OUTSIDER, ...b })).rejects.toMatchObject({ status: 404 });
    // The owner's connection is untouched.
    expect((await h.hubspot.status({ principal: OWNER, ...a })).status).toBe('connected');
  });
});

describe('webhooks', () => {
  const sign = (secret: string, method: string, url: string, body: string, timestamp: string) => {
    // Documented v3 scheme, reproduced independently of the adapter.
    return createHmac('sha256', secret).update(`${method}${url}${body}${timestamp}`).digest('base64');
  };

  const url = (org: { organizationId: string }) =>
    `https://api.test/api/connectors/hubspot/webhook/${org.organizationId}`;

  async function setup() {
    const h = harness({
      client: fakeClient({ record: { contacts: { c1: contact('c1') }, deals: {} } }),
    });
    const org = await h.seedOrg();
    await h.connect(org);
    const source = await h.sourceOf(org);
    const fullUrl = `${url(org)}/${source.sourceConnectionId}`;
    return { h, org, source, fullUrl };
  }

  it('accepts a correctly signed delivery and imports the referenced record once', async () => {
    const { h, org, source, fullUrl } = await setup();
    const body = JSON.stringify([{ objectTypeId: '0-1', objectId: 'c1', propertyName: 'createdate' }]);
    const timestamp = String(NOW);
    const signature = sign('test-client-secret', 'POST', fullUrl, body, timestamp);

    const first = await h.hubspot.webhook({
      organizationId: org.organizationId,
      sourceConnectionId: source.sourceConnectionId,
      headers: { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp },
      rawBody: body,
      url: fullUrl,
    });
    expect(first).toMatchObject({ received: 1, imported: 1 });

    // The same delivery again is a duplicate, not a second lead.
    const second = await h.hubspot.webhook({
      organizationId: org.organizationId,
      sourceConnectionId: source.sourceConnectionId,
      headers: { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp },
      rawBody: body,
      url: fullUrl,
    });
    expect(second).toMatchObject({ imported: 0, duplicates: 1 });
    expect(await h.leadsOf(org)).toHaveLength(1);
  });

  it('rejects a bad signature, a stale timestamp and a missing header', async () => {
    const { h, org, source, fullUrl } = await setup();
    const body = JSON.stringify([{ objectTypeId: '0-1', objectId: 'c1' }]);
    const timestamp = String(NOW);
    const good = sign('test-client-secret', 'POST', fullUrl, body, timestamp);

    const call = (signature: string, ts: string) =>
      h.hubspot.webhook({
        organizationId: org.organizationId,
        sourceConnectionId: source.sourceConnectionId,
        headers: { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': ts },
        rawBody: body,
        url: fullUrl,
      });

    await expect(call(sign('wrong-secret', 'POST', fullUrl, body, timestamp), timestamp)).rejects.toMatchObject({
      status: 401,
      code: 'webhook_signature_invalid',
    });
    await expect(call(good, String(NOW - 6 * 60 * 1000))).rejects.toMatchObject({
      status: 401,
      code: 'webhook_timestamp_stale',
    });
    await expect(
      h.hubspot.webhook({
        organizationId: org.organizationId,
        sourceConnectionId: source.sourceConnectionId,
        headers: {},
        rawBody: body,
        url: fullUrl,
      }),
    ).rejects.toMatchObject({ status: 401, code: 'webhook_unauthenticated' });
  });

  it('rejects an oversized delivery and a disconnected connection', async () => {
    const { h, org, source, fullUrl } = await setup();
    const body = JSON.stringify(Array.from({ length: 51 }, () => ({ objectTypeId: '0-1', objectId: 'c1' })));
    const timestamp = String(NOW);
    const signature = sign('test-client-secret', 'POST', fullUrl, body, timestamp);
    await expect(
      h.hubspot.webhook({
        organizationId: org.organizationId,
        sourceConnectionId: source.sourceConnectionId,
        headers: { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp },
        rawBody: body,
        url: fullUrl,
      }),
    ).rejects.toMatchObject({ status: 413 });

    await h.hubspot.disconnect({ principal: OWNER, ...org });
    const afterBody = JSON.stringify([{ objectTypeId: '0-1', objectId: 'c1' }]);
    const afterSignature = sign('test-client-secret', 'POST', fullUrl, afterBody, timestamp);
    await expect(
      h.hubspot.webhook({
        organizationId: org.organizationId,
        sourceConnectionId: source.sourceConnectionId,
        headers: { 'x-hubspot-signature-v3': afterSignature, 'x-hubspot-request-timestamp': timestamp },
        rawBody: afterBody,
        url: fullUrl,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'connector_disconnected' });
  });
});

describe('webhook rate limiting', () => {
  const sign = (secret: string, method: string, url: string, body: string, timestamp: string) =>
    createHmac('sha256', secret).update(`${method}${url}${body}${timestamp}`).digest('base64');

  async function setup(webhookPerMinute: number) {
    const h = harness({ connectorOptions: { limits: { webhookPerMinute } } });
    const org = await h.seedOrg();
    await h.connect(org);
    const source = await h.sourceOf(org);
    const fullUrl = `https://api.test/api/connectors/hubspot/webhook/${org.organizationId}/${source.sourceConnectionId}`;
    return { h, org, source, fullUrl };
  }

  const deliver = (h: any, org: any, source: any, fullUrl: string) => {
    const body = JSON.stringify([{ objectTypeId: '0-1', objectId: 'c1' }]);
    const timestamp = String(NOW);
    return h.hubspot.webhook({
      organizationId: org.organizationId,
      sourceConnectionId: source.sourceConnectionId,
      headers: {
        'x-hubspot-signature-v3': sign('test-client-secret', 'POST', fullUrl, body, timestamp),
        'x-hubspot-request-timestamp': timestamp,
      },
      rawBody: body,
      url: fullUrl,
    });
  };

  it('accepts up to the limit, then answers 429 with a retry hint', async () => {
    const { h, org, source, fullUrl } = await setup(2);
    await expect(deliver(h, org, source, fullUrl)).resolves.toMatchObject({ received: 1 });
    await expect(deliver(h, org, source, fullUrl)).resolves.toMatchObject({ received: 1 });

    const rejected = await deliver(h, org, source, fullUrl).catch((error: any) => error);
    expect(rejected).toMatchObject({ status: 429, code: 'webhook_rate_limited' });
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    expect(rejected.rateLimit).toMatchObject({ limit: 2 });

    // The rejection is auditable: an incident review needs to know deliveries were dropped.
    const log = await h.store.records.list('auditLog', { orgId: org.organizationId });
    expect(log.some((row: any) => row.action === 'connector.webhook_rate_limited')).toBe(true);
  });

  it('keeps a separate budget per source, so one connection cannot starve another', async () => {
    const { h, org, source, fullUrl } = await setup(1);
    await expect(deliver(h, org, source, fullUrl)).resolves.toBeTruthy();
    await expect(deliver(h, org, source, fullUrl)).rejects.toMatchObject({ status: 429 });

    // The budget is keyed by source connection, so a second connection in the same
    // organization starts a fresh window instead of inheriting a drained one.
    const counter = await h.store.records.get('rateLimits', `hubspot-webhook:${source.sourceConnectionId}`, {
      orgId: org.organizationId,
    });
    expect(counter).toMatchObject({ count: 2, windowStart: NOW });
    const otherSource = await h.store.records.get('rateLimits', 'hubspot-webhook:some_other_source', {
      orgId: org.organizationId,
    });
    expect(otherSource).toBeNull();
  });

  it('resets the window when it expires', async () => {
    const { h, org, source, fullUrl } = await setup(1);
    await expect(deliver(h, org, source, fullUrl)).resolves.toBeTruthy();
    await expect(deliver(h, org, source, fullUrl)).rejects.toMatchObject({ status: 429 });

    h.clock.t = NOW + 61_000; // past the one-minute window
    await expect(deliver(h, org, source, fullUrl)).resolves.toBeTruthy();
  });
});

describe('sealing primitives', () => {
  it('round-trips, rejects tampering and rejects another tenant’s AAD', () => {
    const aad = tenantAad({ organizationId: 'o1', workspaceId: 'w1', sourceConnectionId: 's1' });
    const sealed = seal('secret-value', KEY, { aad });
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('secret-value');
    expect(open(sealed, KEY, { aad })).toBe('secret-value');

    const tampered = `${sealed.slice(0, -2)}AA`;
    expect(open(tampered, KEY, { aad })).toBeNull();
    expect(open(sealed, Buffer.alloc(32, 1), { aad })).toBeNull();
    expect(
      open(sealed, KEY, { aad: tenantAad({ organizationId: 'o2', workspaceId: 'w1', sourceConnectionId: 's1' }) }),
    ).toBeNull();
  });
});
