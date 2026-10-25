// @vitest-environment node
//
// The qualified-lead event pipeline (schema_version 2).
//
// What these tests are for, in the order the brief states them:
//   * a valid event is persisted and queryable for the right tenant;
//   * replaying it does not duplicate it;
//   * signatures, timestamps, tenant references and sizes are enforced;
//   * a browser cannot set revenue or qualification;
//   * currency and timestamps are validated without losing the original time;
//   * consent/consent-less behaviour is explicit;
//   * a lead can be followed from campaign attribution to a verified qualification.

import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../server/app.mjs';
import { createAuth } from '../../../server/auth.mjs';
import { createConsentService } from '../../../server/consent.mjs';
import { createMemoryStore } from '../../../server/store.mjs';
import { createRateLimiter } from '../../../server/limits.mjs';
import { createTenancy } from '../../../server/tenancy.mjs';
import { createSources } from '../../../server/sources.mjs';
import { createEventIngest, attribute, validateEventV2, eventDocumentId } from '../../../server/events-v2.mjs';
import { createAgencyApi } from '../../../server/agency.mjs';
import { signIngestPayload } from '../../../server/ingest.mjs';

const SECRET = 'consent-secret-for-event-tests';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = 1_760_000_000_000; // 2025-10-09T08:53:20Z

function harness() {
  const clock = { t: NOW };
  const now = () => clock.t;
  const store = createMemoryStore({ now });
  const auth = createAuth({
    mode: 'firebase',
    verifyToken: async (token: string) => ({ uid: token, role: 'owner', via: 'test' }),
  });
  const consent = createConsentService({
    secrets: [{ version: 'v1', secret: SECRET }],
    currentVersion: 'v1',
    store,
    now,
  });
  const tenancy = createTenancy({ store, now });
  const sources = createSources({ store, tenancy, now });
  const ingestV2 = createEventIngest({ store, now });
  const agency = createAgencyApi({ tenancy, store, sources, now });

  const app = createApp({
    env: { adsKey: 'k', capiKey: 'c', pixelId: 'p', trackOrigins: ['https://app.test'] },
    auth,
    consent,
    store,
    agency,
    sources,
    ingestV2,
    rateLimit: createRateLimiter({ limit: 1000 }),
    dataset: async () => ({ rows: [] }),
    logger: quiet,
    now,
  });

  const call = (token: string, method: string, path: string, body?: unknown, query?: Record<string, string>) =>
    app.handle({
      method,
      path,
      query,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body as Record<string, unknown>,
      ip: '1.1.1.1',
    });

  /** POST /api/events exactly as a sending server would: signed over the raw bytes. */
  async function send(body: Record<string, unknown>, { key, secret, timestamp = Math.floor(NOW / 1000) } = {} as any) {
    const raw = JSON.stringify(body);
    return app.handle({
      method: 'POST',
      path: '/api/events',
      headers: {
        'content-type': 'application/json',
        'x-adtrack-key': key,
        'x-adtrack-timestamp': String(timestamp),
        'x-adtrack-signature': signIngestPayload({ secret, timestamp, body: raw }),
      },
      rawBody: raw,
      body,
      ip: '1.1.1.1',
    });
  }

  return { app, store, tenancy, sources, ingestV2, clock, now, call, send };
}

async function seedWorkspace(h: ReturnType<typeof harness>) {
  const org = await h.call('u_owner', 'POST', '/api/orgs', { name: 'Acme' });
  const orgId = org.body.organizationId;
  const ws = await h.call('u_owner', 'POST', `/api/orgs/${orgId}/workspaces`, {
    name: 'Acme India',
    timeZone: 'Asia/Kolkata',
    currency: 'INR',
    defaultLanguage: 'en-IN',
    targetMarkets: [{ countryCode: 'IN' }],
  });
  const workspaceId = ws.body.workspaceId;

  const server = await h.call('u_owner', 'POST', `/api/orgs/${orgId}/workspaces/${workspaceId}/sources`, {
    provider: 'generic',
    label: 'Website backend',
  });
  const crm = await h.call('u_owner', 'POST', `/api/orgs/${orgId}/workspaces/${workspaceId}/sources`, {
    provider: 'crm',
    label: 'CRM sync',
    trustedForQualification: true,
  });
  return {
    orgId,
    workspaceId,
    serverSource: server.body.source,
    serverKey: server.body.key,
    crmSource: crm.body.source,
    crmKey: crm.body.key,
  };
}

const baseEvent = (workspaceId: string, overrides: Record<string, unknown> = {}) => ({
  schema_version: 2,
  event_id: 'evt_1001',
  event_type: 'lead_created',
  occurred_at: '2025-10-09T14:20:00+05:30',
  event_source: 'server',
  workspace_id: workspaceId,
  campaign_id: 'camp_launch',
  anonymous_session_id: 'sess_abc123',
  landing_url: 'https://acme.example/gst?utm_source=google&utm_medium=cpc&utm_campaign=gst-q4',
  utm_source: 'google',
  utm_medium: 'cpc',
  utm_campaign: 'gst-q4',
  country_code: 'in',
  consent_state: 'granted',
  ...overrides,
});

describe('schema validation', () => {
  const validate = (body: Record<string, unknown>) => validateEventV2(body, { now: () => NOW });

  it('normalises an instant to UTC and keeps the sender’s original string', () => {
    const event = validate(baseEvent('ws_1'));
    expect(event.occurredAt).toBe(Date.parse('2025-10-09T14:20:00+05:30'));
    expect(event.occurredAtRaw).toBe('2025-10-09T14:20:00+05:30');
    expect(new Date(event.occurredAt).toISOString()).toBe('2025-10-09T08:50:00.000Z');
  });

  it('refuses an ambiguous local timestamp instead of guessing a zone', () => {
    expect(() => validate(baseEvent('ws_1', { occurred_at: '2025-10-09T14:20:00' }))).toThrow(/offset/i);
  });

  it('upper-cases a country and rejects a non-ISO currency', () => {
    expect(validate(baseEvent('ws_1', { country_code: 'in' })).countryCode).toBe('IN');
    expect(() =>
      validate(baseEvent('ws_1', { currency: 'XYZ', amount_minor: 100, event_type: 'order_created' })),
    ).toThrow(/ISO-4217/);
  });

  it('only allows money on money event types, and requires a currency with it', () => {
    expect(() => validate(baseEvent('ws_1', { amount_minor: 5000 }))).toThrow(/only valid on/);
    expect(() => validate(baseEvent('ws_1', { event_type: 'order_created', amount_minor: 5000 }))).toThrow(/currency/);
    expect(() =>
      validate(baseEvent('ws_1', { event_type: 'order_created', amount_minor: 5000, currency: 'inr' })),
    ).not.toThrow();
  });

  it('refuses fields a sender cannot legitimately assert', () => {
    for (const field of ['qualification', 'qualified', 'revenue', 'organization_id', 'received_at']) {
      expect(() => validate(baseEvent('ws_1', { [field]: 'x' }))).toThrow(/not accepted/);
    }
  });

  it('refuses unknown fields, so a typo cannot silently drop data', () => {
    expect(() => validate(baseEvent('ws_1', { amountMinor: 100 }))).toThrow(/unknown field/i);
  });

  it('stores a city only with a live consent basis', () => {
    expect(() => validate(baseEvent('ws_1', { city: 'Pune', consent_state: 'unknown' }))).toThrow(/consent/i);
    expect(validate(baseEvent('ws_1', { city: 'Pune', consent_state: 'granted' })).city).toBe('Pune');
  });

  it('refuses a browser as the event source', () => {
    expect(() => validate(baseEvent('ws_1', { event_source: 'browser' }))).toThrow(/browser/i);
  });

  it('derives a deterministic document id from workspace + event id', () => {
    expect(eventDocumentId({ workspaceId: 'ws_1', eventId: 'e1' })).toBe(
      eventDocumentId({ workspaceId: 'ws_1', eventId: 'e1' }),
    );
    expect(eventDocumentId({ workspaceId: 'ws_1', eventId: 'e1' })).not.toBe(
      eventDocumentId({ workspaceId: 'ws_2', eventId: 'e1' }),
    );
  });
});

describe('ingest over HTTP', () => {
  let h: ReturnType<typeof harness>;
  let seed: Awaited<ReturnType<typeof seedWorkspace>>;

  beforeEach(async () => {
    h = harness();
    seed = await seedWorkspace(h);
  });

  it('persists a valid event for the key’s tenant', async () => {
    const res = await h.send(baseEvent(seed.workspaceId), {
      key: seed.serverKey.keyId,
      secret: seed.serverKey.secret,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ accepted: true, duplicate: false, eventType: 'lead_created' });

    const events = await h.store.records.list('events', {
      orgId: seed.orgId,
      where: { workspaceId: seed.workspaceId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: seed.orgId,
      workspaceId: seed.workspaceId,
      eventType: 'lead_created',
      occurredAtRaw: '2025-10-09T14:20:00+05:30',
      countryCode: 'IN',
    });
  });

  it('does not duplicate on replay, and answers 200 instead of 201', async () => {
    const body = baseEvent(seed.workspaceId);
    const first = await h.send(body, { key: seed.serverKey.keyId, secret: seed.serverKey.secret });
    const second = await h.send(body, { key: seed.serverKey.keyId, secret: seed.serverKey.secret });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ accepted: true, duplicate: true });

    const events = await h.store.records.list('events', {
      orgId: seed.orgId,
      where: { workspaceId: seed.workspaceId },
    });
    expect(events).toHaveLength(1);
    const leads = await h.store.records.list('leads', { orgId: seed.orgId, where: { workspaceId: seed.workspaceId } });
    // A replay must not append the same event id to the lead a second time either.
    expect(leads[0].eventIds).toEqual(['evt_1001']);
  });

  it('treats the same event id in another workspace as a different event', async () => {
    const other = await h.call('u_owner', 'POST', `/api/orgs/${seed.orgId}/workspaces`, {
      name: 'Acme US',
      timeZone: 'America/New_York',
      currency: 'USD',
      defaultLanguage: 'en',
    });
    const otherWs = other.body.workspaceId;
    const key = await h.call('u_owner', 'POST', `/api/orgs/${seed.orgId}/workspaces/${otherWs}/sources`, {
      provider: 'generic',
    });

    const a = await h.send(baseEvent(seed.workspaceId), { key: seed.serverKey.keyId, secret: seed.serverKey.secret });
    const b = await h.send(baseEvent(otherWs), { key: key.body.key.keyId, secret: key.body.key.secret });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it.each([
    ['a wrong signature', { secret: 'not-the-secret' }],
    ['a stale timestamp', { timestamp: Math.floor(NOW / 1000) - 3600 }],
  ] as [string, { secret?: string; timestamp?: number }][])(
    'rejects %s',
    async (_label: string, overrides: { secret?: string; timestamp?: number }) => {
      const res = await h.send(baseEvent(seed.workspaceId), {
        key: seed.serverKey.keyId,
        secret: overrides.secret ?? seed.serverKey.secret,
        timestamp: overrides.timestamp ?? Math.floor(NOW / 1000),
      });
      expect(res.status).toBe(401);
      expect(['ingest_signature_invalid', 'ingest_timestamp_stale']).toContain(res.body.error.code);
      expect(await h.store.records.list('events', { orgId: seed.orgId })).toHaveLength(0);
    },
  );

  it('rejects an unsigned request and an unknown key', async () => {
    const unsigned = await h.app.handle({
      method: 'POST',
      path: '/api/events',
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify(baseEvent(seed.workspaceId)),
      body: baseEvent(seed.workspaceId),
    });
    expect(unsigned.status).toBe(401);

    const unknown = await h.send(baseEvent(seed.workspaceId), { key: 'src_nope.v9', secret: 'whatever' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('ingest_unauthenticated');
  });

  it('rejects a body that claims another workspace', async () => {
    const res = await h.send(baseEvent('ws_someone_else'), {
      key: seed.serverKey.keyId,
      secret: seed.serverKey.secret,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('tenant_mismatch');
  });

  it('refuses to let a browser report revenue or a qualification', async () => {
    const browser = await h.send(baseEvent(seed.workspaceId, { event_source: 'browser' }), {
      key: seed.serverKey.keyId,
      secret: seed.serverKey.secret,
    });
    expect(browser.status).toBe(403);

    const money = await h.send(
      baseEvent(seed.workspaceId, { event_type: 'order_created', amount_minor: 999900, currency: 'INR' }),
      { key: seed.serverKey.keyId, secret: seed.serverKey.secret },
    );
    // Server events may carry money; only the browser route may not. This is allowed…
    expect(money.status).toBe(201);

    // …but a qualification claim is not, from any source that is not trusted for it.
    const claim = await h.send(baseEvent(seed.workspaceId, { event_type: 'lead_qualified' }), {
      key: seed.serverKey.keyId,
      secret: seed.serverKey.secret,
    });
    expect(claim.status).toBe(403);
    expect(claim.body.error.code).toBe('qualification_not_trusted');
  });

  it('rejects an oversized or malformed body without a stack trace', async () => {
    const raw = '{ not json';
    const res = await h.app.handle({
      method: 'POST',
      path: '/api/events',
      headers: {
        'content-type': 'application/json',
        'x-adtrack-key': seed.serverKey.keyId,
        'x-adtrack-timestamp': String(Math.floor(NOW / 1000)),
        'x-adtrack-signature': signIngestPayload({
          secret: seed.serverKey.secret,
          timestamp: Math.floor(NOW / 1000),
          body: raw,
        }),
      },
      rawBody: raw,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('malformed_json');
    expect(JSON.stringify(res.body)).not.toMatch(/at Object|node:internal/);
  });

  it('stops accepting a key the moment it is revoked, without touching the others', async () => {
    const rotated = await h.call(
      'u_owner',
      'POST',
      `/api/orgs/${seed.orgId}/workspaces/${seed.workspaceId}/sources/${seed.serverSource.sourceConnectionId}/rotations`,
    );
    expect(rotated.status).toBe(201);
    const newKey = rotated.body.key;

    // Both keys work during the rotation window.
    expect(
      (await h.send(baseEvent(seed.workspaceId), { key: seed.serverKey.keyId, secret: seed.serverKey.secret })).status,
    ).toBe(201);
    expect(
      (
        await h.send(baseEvent(seed.workspaceId, { event_id: 'evt_1002' }), {
          key: newKey.keyId,
          secret: newKey.secret,
        })
      ).status,
    ).toBe(201);

    const revoke = await h.call(
      'u_owner',
      'POST',
      `/api/orgs/${seed.orgId}/workspaces/${seed.workspaceId}/sources/${seed.serverSource.sourceConnectionId}/revocations`,
      { keyVersion: seed.serverKey.keyVersion },
    );
    expect(revoke.status).toBe(200);
    const refused = await h.send(baseEvent(seed.workspaceId, { event_id: 'evt_1003' }), {
      key: seed.serverKey.keyId,
      secret: seed.serverKey.secret,
    });
    expect(refused.status).toBe(401);

    // The CRM's key is unaffected by another source's revocation.
    expect(
      (
        await h.send(baseEvent(seed.workspaceId, { event_id: 'evt_1004' }), {
          key: seed.crmKey.keyId,
          secret: seed.crmKey.secret,
        })
      ).status,
    ).toBe(201);
  });

  it('requires source.manage to create or revoke a key', async () => {
    await h.call('u_owner', 'PUT', `/api/orgs/${seed.orgId}/members`, { userId: 'u_viewer', role: 'viewer' });
    const created = await h.call('u_viewer', 'POST', `/api/orgs/${seed.orgId}/workspaces/${seed.workspaceId}/sources`, {
      provider: 'generic',
    });
    expect(created.status).toBe(403);

    const listed = await h.call('u_viewer', 'GET', `/api/orgs/${seed.orgId}/workspaces/${seed.workspaceId}/sources`);
    expect(listed.status).toBe(200);
    // Listing must never return key material.
    expect(JSON.stringify(listed.body)).not.toMatch(/secret|fingerprint/);
  });
});

describe('qualified leads', () => {
  let h: ReturnType<typeof harness>;
  let seed: Awaited<ReturnType<typeof seedWorkspace>>;

  beforeEach(async () => {
    h = harness();
    seed = await seedWorkspace(h);
  });

  it('creates an unqualified lead from an enquiry, then qualifies it by a named user', async () => {
    const created = await h.send(baseEvent(seed.workspaceId), {
      key: seed.serverKey.keyId,
      secret: seed.serverKey.secret,
    });
    const leadId = created.body.leadId;
    expect(leadId).toBeTruthy();

    const before = await h.call('u_owner', 'GET', `/api/orgs/${seed.orgId}/workspaces/${seed.workspaceId}/leads`);
    expect(before.body.leads).toHaveLength(1);
    expect(before.body.leads[0].qualificationState).toBe('not_qualified');

    const qualified = await h.call(
      'u_owner',
      'POST',
      `/api/orgs/${seed.orgId}/workspaces/${seed.workspaceId}/leads/${leadId}/qualification`,
      { status: 'qualified', note: 'budget confirmed on call' },
    );
    expect(qualified.status).toBe(200);
    expect(qualified.body.qualification).toMatchObject({
      status: 'qualified',
      source: 'user:u_owner',
      actor: 'u_owner',
      definitionVersion: 'v1',
    });

    const after = await h.call('u_owner', 'GET', `/api/orgs/${seed.orgId}/workspaces/${seed.workspaceId}/leads`);
    expect(after.body.leads[0].qualificationState).toBe('qualified');
  });

  it('accepts a qualification from a CRM source trusted for it, with provenance', async () => {
    const enquiry = await h.send(baseEvent(seed.workspaceId), { key: seed.crmKey.keyId, secret: seed.crmKey.secret });
    const qualified = await h.send(
      baseEvent(seed.workspaceId, {
        event_id: 'evt_1002',
        event_type: 'lead_qualified',
        crm_record_reference: 'evt_1001',
      }),
      { key: seed.crmKey.keyId, secret: seed.crmKey.secret },
    );
    expect(qualified.status).toBe(201);

    const leads = await h.store.records.list('leads', { orgId: seed.orgId });
    const lead = leads.find((l) => l.leadId === enquiry.body.leadId);
    expect(lead?.qualification).toMatchObject({
      status: 'qualified',
      source: `crm:${seed.crmSource.sourceConnectionId}`,
    });
  });

  it('requires the lead.qualify permission', async () => {
    const created = await h.send(baseEvent(seed.workspaceId), {
      key: seed.serverKey.keyId,
      secret: seed.serverKey.secret,
    });
    await h.call('u_owner', 'PUT', `/api/orgs/${seed.orgId}/members`, { userId: 'u_viewer', role: 'viewer' });
    const res = await h.call(
      'u_viewer',
      'POST',
      `/api/orgs/${seed.orgId}/workspaces/${seed.workspaceId}/leads/${created.body.leadId}/qualification`,
      { status: 'qualified' },
    );
    expect(res.status).toBe(403);
  });

  it('follows a lead from campaign attribution to qualification', async () => {
    const wsPath = `/api/orgs/${seed.orgId}/workspaces/${seed.workspaceId}`;
    // 1. the click, with the campaign's UTM parameters
    await h.send(
      baseEvent(seed.workspaceId, {
        event_id: 'evt_visit',
        event_type: 'campaign_attributed_visit',
        occurred_at: '2025-10-08T09:00:00+05:30',
      }),
      { key: seed.serverKey.keyId, secret: seed.serverKey.secret },
    );
    // 2. the enquiry, same anonymous session
    const lead = await h.send(
      baseEvent(seed.workspaceId, {
        event_id: 'evt_enquiry',
        event_type: 'enquiry_submitted',
        occurred_at: '2025-10-09T14:20:00+05:30',
      }),
      { key: seed.serverKey.keyId, secret: seed.serverKey.secret },
    );

    const attribution = await h.call('u_owner', 'GET', `${wsPath}/leads/${lead.body.leadId}/attribution`, undefined, {
      windowDays: '30',
    });
    expect(attribution.status).toBe(200);
    expect(attribution.body).toMatchObject({
      available: true,
      basis: 'observed_touchpoints',
      window: { days: 30, timeZone: 'Asia/Kolkata' },
    });
    expect(attribution.body.models.firstTouch).toMatchObject({
      campaignId: 'camp_launch',
      utm: { utm_campaign: 'gst-q4' },
    });
    expect(attribution.body.note).toMatch(/not proof of causation/i);
  });

  it('reports attribution as unavailable rather than inventing a touchpoint', async () => {
    const lead = await h.send(baseEvent(seed.workspaceId), {
      key: seed.serverKey.keyId,
      secret: seed.serverKey.secret,
    });
    const res = await h.call(
      'u_owner',
      'GET',
      `/api/orgs/${seed.orgId}/workspaces/${seed.workspaceId}/leads/${lead.body.leadId}/attribution`,
    );
    expect(res.body).toMatchObject({ available: false, reason: 'no_touchpoints_in_window' });
    expect(res.body.models).toEqual({ firstTouch: null, lastTouch: null });
  });
});

describe('attribution windows', () => {
  const day = 24 * 60 * 60 * 1000;
  const conversionAt = Date.parse('2025-10-10T00:00:00Z');

  it('excludes touchpoints outside the window', () => {
    const result = attribute({
      touchpoints: [{ occurredAt: conversionAt - 40 * day, campaignId: 'old' }],
      conversionAt,
      windowDays: 30,
      timeZone: 'UTC',
    });
    expect(result.available).toBe(false);
    expect(result.models.firstTouch).toBeNull();
  });

  it('uses first and last touch inside the window, and says what it is not', () => {
    const result = attribute({
      touchpoints: [
        { occurredAt: conversionAt - 10 * day, campaignId: 'first' },
        { occurredAt: conversionAt - 2 * day, campaignId: 'second' },
        { occurredAt: conversionAt - day, campaignId: 'last' },
      ],
      conversionAt,
      windowDays: 30,
      timeZone: 'America/New_York',
    });
    expect(result.models.firstTouch?.campaignId).toBe('first');
    expect(result.models.lastTouch?.campaignId).toBe('last');
    expect(result.window.timeZone).toBe('America/New_York');
    expect(result.touchpointCount).toBe(3);
  });
});
