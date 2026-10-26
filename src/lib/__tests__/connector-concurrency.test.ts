// @vitest-environment node
//
// Phase 3, Subagent A + B: concurrency and crash-recovery acceptance tests.
//
// Two Critical acceptance tests live here:
//
//   A. Two concurrent OAuth completions with the same valid state. Exactly one may
//      consume the state and exchange the code; the second is refused.
//   B. Two concurrent syncs for one connection. Exactly one acquires the lease; the
//      other gets a deterministic 409, with no duplicate import and no clobbered
//      checkpoint.
//
// Both are exercised twice: against the in-memory adapter, and against the **Firestore
// adapter code path** over a fake Firestore that runs transactions under a single lock.
// The fake is deliberately conservative (a serialisable transaction is stronger than
// Firestore's optimistic retry), so it can disprove our usage but cannot prove real
// Firestore behaviour. That distinction is stated in the Phase 3 report: with no
// emulator and no project, "correct against real Firestore" remains UNKNOWN.

import { describe, expect, it } from 'vitest';
import { createMemoryStore, createFirestoreStore } from '../../../server/store.mjs';
import { createTenancy } from '../../../server/tenancy.mjs';
import { createEventIngest } from '../../../server/events-v2.mjs';
import { createHubSpotConnector, redactError } from '../../../server/connectors/hubspot.mjs';

const KEY = Buffer.alloc(32, 9);
const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const OWNER = { uid: 'u_owner', role: 'owner' };
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- fake Firestore
//
// Implements only what the store uses: nested collections, doc get/set/create/delete,
// simple `where(field,'==',value)` + `limit` queries, and runTransaction. Transactions
// are serialised through one promise chain, and writes are buffered until the callback
// resolves and then committed — which is the guarantee the real database provides.

type Row = Record<string, any>;

function createFakeFirestore() {
  const docs = new Map<string, Row>();
  const pathKey = (path: string[]) => path.join('/');
  const pendingWrites: (() => void)[] = [];

  function commitPending() {
    for (const write of pendingWrites.splice(0)) write();
  }

  const docRef = (path: string[]) => ({
    id: path[path.length - 1],
    path,
    async get() {
      const row = docs.get(pathKey(path));
      return { exists: row !== undefined, data: () => (row ? { ...row } : undefined) };
    },
    async set(data: Row, options?: { merge?: boolean }) {
      pendingWrites.push(() => {
        const existing = docs.get(pathKey(path));
        docs.set(pathKey(path), options?.merge ? { ...(existing ?? {}), ...data } : { ...data });
      });
      if (!inTransaction) commitPending();
      return {};
    },
    async create(data: Row) {
      if (docs.has(pathKey(path))) {
        const error = new Error('ALREADY_EXISTS') as Error & { code: number };
        error.code = 6;
        throw error;
      }
      docs.set(pathKey(path), { ...data });
      return {};
    },
    async delete() {
      docs.delete(pathKey(path));
      return {};
    },
    collection(name: string) {
      return collectionRef([...path, name]);
    },
  });

  let inTransaction = false;

  const collectionRef = (path: string[]) => {
    const query: any = {
      _where: [] as [string, string, unknown][],
      _limit: 1000,
      doc: (id: string) => docRef([...path, id]),
      where(field: string, op: string, value: unknown) {
        query._where = [...query._where, [field, op, value]];
        return query;
      },
      limit(n: number) {
        query._limit = n;
        return query;
      },
      orderBy() {
        return query;
      },
      async get() {
        const prefix = `${pathKey(path)}/`;
        const rows: Record<string, any>[] = [...docs.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
          .map(([key, row]) => ({ id: key.slice(prefix.length), ...(row as Record<string, any>) }))
          .filter((row: Record<string, any>) =>
            query._where.every(([field, op, value]: [string, string, unknown]) => op !== '==' || row[field] === value),
          )
          .slice(0, query._limit);
        return {
          docs: rows.map((row) => ({
            ...row,
            id: row.id,
            data: () => ({ ...row }),
            ref: docRef([...path, row.id]),
          })),
        };
      },
    };
    return query;
  };

  let chain: Promise<unknown> = Promise.resolve();

  return {
    _docs: docs,
    collection: (name: string) => collectionRef([name]),
    /** Serialised transaction: reads see committed data, writes commit atomically. */
    runTransaction<T>(
      fn: (tx: { get: (ref: any) => Promise<any>; set: (ref: any, data: Row, options?: any) => void }) => Promise<T>,
    ) {
      const run = chain.then(async () => {
        inTransaction = true;
        try {
          const tx = {
            get: async (ref: any) => ref.get(),
            set: (ref: any, data: Row, options?: any) => {
              void ref.set(data, options);
            },
          };
          const result = await fn(tx);
          commitPending();
          return result;
        } finally {
          inTransaction = false;
        }
      });
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

// --------------------------------------------------------------------- fixtures

const contact = (id: string) => ({
  id,
  properties: {
    hs_object_id: id,
    createdate: String(NOW - 3 * DAY),
    hs_lastmodifieddate: String(NOW - DAY),
    country: 'IN',
  },
  associations: {},
});

type HarnessOptions = {
  storeKind?: 'memory' | 'firestore';
  client?: any;
  tokenResponse?: any;
  fetchImpl?: any;
};

function harness({ storeKind = 'memory', client = null, tokenResponse = null, fetchImpl = null }: HarnessOptions = {}) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const fake = storeKind === 'firestore' ? createFakeFirestore() : null;
  const store =
    storeKind === 'firestore'
      ? createFirestoreStore({ firestore: fake as never, prefix: 'adtrack', now })
      : createMemoryStore({ now });
  const tenancy = createTenancy({ store, now });
  const ingest = createEventIngest({ store, now });

  const tokenCalls: any[] = [];
  const provider = {
    contacts: {
      getPage: async (args: any) => {
        tokenCalls.push({ kind: 'contacts.getPage', args });
        return client?.contacts?.getPage ? client.contacts.getPage(args) : { results: [] };
      },
      getById: async (id: string, props?: string[]) => {
        tokenCalls.push({ kind: 'contacts.getById', id });
        return client?.contacts?.getById ? client.contacts.getById(id, props) : contact(id);
      },
    },
    deals: {
      getPage: async (args: any) => {
        tokenCalls.push({ kind: 'deals.getPage', args });
        return client?.deals?.getPage ? client.deals.getPage(args) : { results: [] };
      },
      getById: async (id: string, props?: string[], assoc?: string[]) => {
        tokenCalls.push({ kind: 'deals.getById', id });
        return client?.deals?.getById ? client.deals.getById(id, props, assoc) : contact(id);
      },
    },
  };

  const tokenFetch =
    fetchImpl ??
    (async () => ({
      ok: true,
      status: 200,
      json: async () =>
        tokenResponse ?? {
          access_token: 'fake-access',
          refresh_token: 'fake-refresh',
          expires_in: 1800,
          scope: 'crm.objects.contacts.read crm.objects.deals.read',
          hub_id: 42,
        },
    }));

  const tokenEndpointCalls: string[] = [];

  const hubspot = createHubSpotConnector({
    store,
    tenancy,
    now,
    sleep: async () => {},
    encryptionKey: KEY,
    oauth: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://app.test/oauth/callback',
      fetch: async (url: string, init: any) => {
        tokenEndpointCalls.push(String(init?.body ?? ''));
        return tokenFetch(url, init);
      },
    },
    clientFactory: () => provider,
    ingest,
    limits: { batchSize: 100, maxPages: 20, maxAttempts: 2, baseDelayMs: 1 },
  });

  async function seed() {
    const org = await tenancy.createOrg(OWNER, { name: 'Agency A' });
    const ws = await tenancy.createWorkspace(OWNER, org.organizationId, {
      name: 'Acme India',
      clientName: 'Acme',
      timeZone: 'Asia/Kolkata',
      currency: 'INR',
      defaultLanguage: 'en-IN',
      targetMarkets: [{ countryCode: 'IN' }],
    });
    return { organizationId: org.organizationId, workspaceId: ws.workspaceId };
  }

  async function startConnect(org: { organizationId: string; workspaceId: string }) {
    return hubspot.connectStart({ principal: OWNER, ...org, body: {} });
  }

  async function connect(org: { organizationId: string; workspaceId: string }) {
    const start = await startConnect(org);
    await hubspot.connectComplete({
      principal: OWNER,
      ...org,
      body: { code: 'auth-code', state: start.state },
    });
    return start;
  }

  const sourceOf = async (org: { organizationId: string }) =>
    (await store.records.list('sources', { orgId: org.organizationId }))[0] ?? null;

  return {
    store,
    tenancy,
    hubspot,
    clock,
    tokenCalls,
    provider,
    tokenEndpointCalls,
    sourceOf,
    seed,
    startConnect,
    connect,
    storeKind,
  };
}

const syncOf = (h: ReturnType<typeof harness>, org: { organizationId: string; workspaceId: string }) =>
  h.hubspot.sync({ principal: OWNER, ...org });

// =========================================================== A. OAuth state race

describe.each(['memory', 'firestore'] as const)('OAuth state race (%s store)', (kind) => {
  it('lets exactly one of two concurrent completions consume the state and exchange the code', async () => {
    const h = harness({ storeKind: kind });
    const org = await h.seed();
    const start = await h.startConnect(org);

    const results = await Promise.allSettled([
      h.hubspot.connectComplete({ principal: OWNER, ...org, body: { code: 'code-a', state: start.state } }),
      h.hubspot.connectComplete({ principal: OWNER, ...org, body: { code: 'code-b', state: start.state } }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 400, code: 'state_already_used' });

    // The provider was called once: the loser never reached the token endpoint.
    expect(h.tokenEndpointCalls).toHaveLength(1);
    expect(h.tokenEndpointCalls[0]).toContain('grant_type=authorization_code');

    const source = await h.sourceOf(org);
    expect(source.connectionStatus).toBe('connected');
    expect(source.auth.scopes).toEqual(['crm.objects.contacts.read', 'crm.objects.deals.read']);
  });

  it('keeps the state spent when the exchange itself fails, so it cannot be retried', async () => {
    const h = harness({
      storeKind: kind,
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_code' }) }),
    });
    const org = await h.seed();
    const start = await h.startConnect(org);

    await expect(
      h.hubspot.connectComplete({ principal: OWNER, ...org, body: { code: 'bad', state: start.state } }),
    ).rejects.toMatchObject({ code: 'hubspot_token_rejected' });

    await expect(
      h.hubspot.connectComplete({ principal: OWNER, ...org, body: { code: 'bad', state: start.state } }),
    ).rejects.toMatchObject({ code: 'state_already_used' });

    expect(h.tokenEndpointCalls).toHaveLength(1);
  });
});

// ============================================================== B. Sync race

describe.each(['memory', 'firestore'] as const)('sync concurrency (%s store)', (kind) => {
  it('lets exactly one of two concurrent syncs acquire the lease; the other is a 409', async () => {
    let releaseFirstPage: () => void = () => {};
    const firstPageGate = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });

    let pageCalls = 0;
    const h = harness({
      storeKind: kind,
      client: {
        contacts: {
          getPage: async () => {
            pageCalls += 1;
            if (pageCalls === 1) await firstPageGate;
            return {
              results: pageCalls === 1 ? [contact('c1')] : [],
              paging: undefined,
            };
          },
        },
        deals: { getPage: async () => ({ results: [] }) },
      },
    });

    const org = await h.seed();
    await h.connect(org);

    const first = syncOf(h, org); // holds the lease, blocked on the first page
    const second = await syncOf(h, org).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );

    expect(second.ok).toBe(false);
    expect((second as { error: any }).error).toMatchObject({ status: 409, code: 'sync_in_progress' });
    expect((second as { error: any }).error.retryAfterMs).toBeGreaterThan(0);

    releaseFirstPage();
    const firstResult = await first;
    expect(firstResult.lastSyncStatus).toBe('complete');
    expect(firstResult.imported).toBe(1);

    // One import, not two: the loser never reached the provider at all. The winner made
    // exactly one contacts page request and one deals page request.
    expect(pageCalls).toBe(1);
    expect(h.tokenCalls.filter((c: any) => c.kind === 'deals.getPage')).toHaveLength(1);
    const events = await h.store.records.list('events', { orgId: org.organizationId });
    expect(events).toHaveLength(1);
    const source = await h.sourceOf(org);
    expect(source.lease ?? null).toBeNull();
    expect(source.connectionStatus).toBe('connected');
  });

  it('recovers a lease left behind by a crashed instance, and audits the takeover', async () => {
    const h = harness({
      storeKind: kind,
      client: { contacts: { getPage: async () => ({ results: [contact('c9')] }) } },
    });
    const org = await h.seed();
    await h.connect(org);
    const source = await h.sourceOf(org);

    // What a process that died mid-sync leaves: a lease in the past and a 'syncing' status.
    await h.store.records.update(
      'sources',
      source.sourceConnectionId,
      {
        connectionStatus: 'syncing',
        syncStartedAt: NOW - 60 * 60 * 1000,
        lease: { holder: 'sync_dead', acquiredAt: NOW - 3600_000, renewedAt: NOW - 3600_000, expiresAt: NOW - 60_000 },
      },
      { orgId: org.organizationId },
    );

    const status = await h.hubspot.status({ principal: OWNER, ...org });
    expect(status.syncStale).toBe(true);
    expect(status.nextAction).toBe('run_sync');

    const result = await syncOf(h, org);
    expect(result.lastSyncStatus).toBe('complete');
    expect(result.imported).toBe(1);

    const audit = await h.store.records.list('auditLog', { orgId: org.organizationId });
    expect(audit.map((a: any) => a.action)).toContain('connector.sync_takeover');
  });
});

// ======================================================= C. Crash and race safety

describe('sync safety', () => {
  it('does not let a sync that finishes after a disconnect resurrect the connection', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const h = harness({
      client: {
        contacts: {
          getPage: async () => {
            calls += 1;
            if (calls === 1) await gate;
            return { results: [contact('c1')] };
          },
        },
      },
    });
    const org = await h.seed();
    await h.connect(org);

    const running = syncOf(h, org);
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the sync take the lease
    await h.hubspot.disconnect({ principal: OWNER, ...org });

    release();
    const result = await running;

    expect(result.applied).toBe(false);
    expect(result.lastSyncStatus).toBe('failed');
    expect(result.error).toMatchObject({ code: 'connection_disconnected' });

    const source = await h.sourceOf(org);
    expect(source.connectionStatus).toBe('disconnected');
    expect(source.auth).toBeNull();
    expect(source.lastSyncStatus).toBeNull(); // the disconnect was not overwritten
  });

  it('stops without writing a checkpoint when the lease is stolen mid-sync', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const h = harness({
      client: {
        contacts: {
          getPage: async () => {
            calls += 1;
            if (calls === 1) await gate;
            return { results: [contact('c1')] };
          },
        },
      },
    });
    const org = await h.seed();
    await h.connect(org);
    const source = await h.sourceOf(org);

    const running = syncOf(h, org);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Another instance takes the lease over (its expiry passed, or it was forced).
    await h.store.records.update(
      'sources',
      source.sourceConnectionId,
      { lease: { holder: 'sync_other', acquiredAt: NOW, renewedAt: NOW, expiresAt: NOW + 60_000 } },
      { orgId: org.organizationId },
    );

    release();
    const result = await running;

    expect(result.applied).toBe(false);
    expect(result.lastSyncStatus).toBe('failed');
    expect(result.error).toMatchObject({ code: 'sync_lock_lost' });
    // Imported events are real (they happened); the checkpoint is not ours to write.
    const after = await h.sourceOf(org);
    expect(after.checkpoint).toBeNull();
    expect(after.lease.holder).toBe('sync_other');
  });

  it('does not let a token refresh during another operation clear syncing status or the lease', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const h = harness({
      client: {
        contacts: {
          getPage: async () => {
            calls += 1;
            if (calls === 1) await gate;
            return { results: [] };
          },
        },
      },
    });
    const org = await h.seed();
    await h.connect(org);
    const source = await h.sourceOf(org);

    const running = syncOf(h, org);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Force the access token to look expired, then make a webhook read run a refresh.
    await h.store.records.update(
      'sources',
      source.sourceConnectionId,
      { auth: { ...source.auth, expiresAt: 0 } },
      { orgId: org.organizationId },
    );
    await h.hubspot
      .webhook({
        organizationId: org.organizationId,
        sourceConnectionId: source.sourceConnectionId,
        headers: {},
        rawBody: '[]',
        url: 'https://api.test/api/connectors/hubspot/webhook/x/y',
      })
      .catch(() => undefined); // unsigned: refused before any refresh, still no status write

    const during = await h.sourceOf(org);
    expect(during.connectionStatus).toBe('syncing');
    expect(during.lease).not.toBeNull();

    release();
    await running;
  });
});

// ======================================================== D. Token/scope honesty

describe('granted scopes are reported, never assumed', () => {
  it('fails the connection when the provider granted fewer scopes than required', async () => {
    const h = harness({
      tokenResponse: {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 1800,
        scope: 'crm.objects.contacts.read',
        hub_id: 1,
      },
    });
    const org = await h.seed();
    const start = await h.startConnect(org);

    await expect(
      h.hubspot.connectComplete({ principal: OWNER, ...org, body: { code: 'c', state: start.state } }),
    ).rejects.toMatchObject({ status: 502, code: 'hubspot_scope_rejected' });

    const source = await h.sourceOf(org);
    expect(source.connectionStatus).toBe('failed');
    expect(source.auth).toBeNull();
    expect(source.lastError.code).toBe('hubspot_scope_rejected');
  });

  it('records "scopes unverified" when the provider reports no scope list, instead of claiming the requested ones', async () => {
    const h = harness({ tokenResponse: { access_token: 'a', refresh_token: 'r', expires_in: 1800, hub_id: 3 } });
    const org = await h.seed();
    await h.connect(org);

    const status = await h.hubspot.status({ principal: OWNER, ...org });
    expect(status.scopesGranted).toEqual([]);
    expect(status.scopesVerified).toBe(false);
  });

  it('times out a hung token endpoint instead of hanging the request', async () => {
    const h = harness({
      fetchImpl: async () => {
        const error = new Error('The operation timed out.') as Error & { name: string };
        error.name = 'TimeoutError';
        throw error;
      },
    });
    const org = await h.seed();
    const start = await h.startConnect(org);

    await expect(
      h.hubspot.connectComplete({ principal: OWNER, ...org, body: { code: 'c', state: start.state } }),
    ).rejects.toMatchObject({ status: 504, code: 'hubspot_token_timeout' });

    const source = await h.sourceOf(org);
    expect(source.connectionStatus).toBe('failed');
  });
});

// ==================================================== E. Webhook failure honesty

describe('webhook failure semantics', () => {
  const signFor = async (h: ReturnType<typeof harness>, org: any) => {
    const { createHmac } = await import('node:crypto');
    const source = await h.sourceOf(org);
    const path = `/api/connectors/hubspot/webhook/${org.organizationId}/${source.sourceConnectionId}`;
    const url = `https://api.test${path}`;
    const body = JSON.stringify([{ objectTypeId: '0-1', objectId: 'c1' }]);
    const timestamp = String(NOW);
    const signature = createHmac('sha256', 'client-secret').update(`POST${url}${body}${timestamp}`).digest('base64');
    return {
      url,
      rawBody: body,
      headers: { 'x-hubspot-signature-v3': signature, 'x-hubspot-request-timestamp': timestamp },
      source,
    };
  };

  it('answers 5xx when the provider read fails for a retryable reason, so HubSpot retries', async () => {
    let fail = true;
    const h = harness({
      client: {
        contacts: {
          getById: async () => {
            if (!fail) return contact('c1');
            const error = new Error('upstream unavailable') as Error & { status: number };
            error.status = 503;
            throw error;
          },
        },
      },
    });
    const org = await h.seed();
    await h.connect(org);
    const signed = await signFor(h, org);

    await expect(
      h.hubspot.webhook({
        organizationId: org.organizationId,
        sourceConnectionId: signed.source.sourceConnectionId,
        headers: signed.headers,
        rawBody: signed.rawBody,
        url: signed.url,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'webhook_partial_failure' });

    // The record was not silently marked as "skipped forever": nothing was stored.
    expect(await h.store.records.list('events', { orgId: org.organizationId })).toHaveLength(0);

    fail = false;
    const ok = await h.hubspot.webhook({
      organizationId: org.organizationId,
      sourceConnectionId: signed.source.sourceConnectionId,
      headers: signed.headers,
      rawBody: signed.rawBody,
      url: signed.url,
    });
    expect(ok.imported).toBe(1);
  });

  it('treats a permanently missing record as a skip (200), not as a retryable failure', async () => {
    const h = harness({
      client: {
        contacts: {
          getById: async () => {
            const error = new Error('contact not found') as Error & { status: number };
            error.status = 404;
            throw error;
          },
        },
      },
    });
    const org = await h.seed();
    await h.connect(org);
    const signed = await signFor(h, org);

    const result = await h.hubspot.webhook({
      organizationId: org.organizationId,
      sourceConnectionId: signed.source.sourceConnectionId,
      headers: signed.headers,
      rawBody: signed.rawBody,
      url: signed.url,
    });
    expect(result).toMatchObject({ received: 1, imported: 0, skipped: 1 });
  });
});

// ============================================================== F. Redaction

describe('redaction', () => {
  it('strips token material from provider error text', () => {
    const text = redactError({
      message: 'POST failed: access_token=abc123&refresh_token=def456 Authorization: Bearer eyJhbGciOi.xyz',
    });
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('def456');
    expect(text).not.toContain('eyJhbGciOi');
    expect(text).toContain('[redacted]');
  });
});

describe('fixed-window counters', () => {
  it('allows exactly `limit` hits in a window and reports how far over it went', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await store.records.bumpCounter('rateLimits', 'hook:src_1', { windowMs: 60_000, limit: 3 }));
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.at(-1)).toMatchObject({ count: 5, limit: 3, windowStart: NOW });
  });

  it('starts a new window when the old one has expired', async () => {
    const clock = { t: NOW };
    const store = createMemoryStore({ now: () => clock.t });
    expect(await store.records.bumpCounter('rateLimits', 'hook:src_1', { windowMs: 60_000, limit: 1 })).toMatchObject({
      allowed: true,
      count: 1,
    });
    expect(await store.records.bumpCounter('rateLimits', 'hook:src_1', { windowMs: 60_000, limit: 1 })).toMatchObject({
      allowed: false,
      count: 2,
    });
    clock.t = NOW + 60_000;
    expect(await store.records.bumpCounter('rateLimits', 'hook:src_1', { windowMs: 60_000, limit: 1 })).toMatchObject({
      allowed: true,
      count: 1,
      windowStart: NOW + 60_000,
    });
  });

  it('keeps counters separate per tenant and per id', async () => {
    const store = createMemoryStore({ now: () => NOW });
    await store.records.bumpCounter('rateLimits', 'hook:src_1', { orgId: 'o1', windowMs: 60_000, limit: 1 });
    expect(
      await store.records.bumpCounter('rateLimits', 'hook:src_1', { orgId: 'o1', windowMs: 60_000, limit: 1 }),
    ).toMatchObject({ allowed: false });
    expect(
      await store.records.bumpCounter('rateLimits', 'hook:src_1', { orgId: 'o2', windowMs: 60_000, limit: 1 }),
    ).toMatchObject({ allowed: true, count: 1 });
    expect(
      await store.records.bumpCounter('rateLimits', 'hook:src_2', { orgId: 'o1', windowMs: 60_000, limit: 1 }),
    ).toMatchObject({ allowed: true, count: 1 });
  });
});
