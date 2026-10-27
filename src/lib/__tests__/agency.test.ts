// @vitest-environment node
//
// Campaign registry + UTM builder, topic research with provenance, and retention.
//
// The through-line: nothing here invents a fact. A campaign is not "live", a topic is
// not "observed" without a source, a metric we do not collect is refused rather than
// estimated, and a purge deletes exactly what the policy says and nothing else.

import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../server/app.mjs';
import { createAuth } from '../../../server/auth.mjs';
import { createConsentService } from '../../../server/consent.mjs';
import { createMemoryStore } from '../../../server/store.mjs';
import { createRateLimiter } from '../../../server/limits.mjs';
import { createTenancy } from '../../../server/tenancy.mjs';
import { createSources } from '../../../server/sources.mjs';
import { createEventIngest } from '../../../server/events-v2.mjs';
import { createAgencyApi, freshnessOf } from '../../../server/agency.mjs';
import { buildUtmUrl, inspectUtm, normalizeUtmValue } from '../../../server/utm.mjs';

const SECRET = 'consent-secret-for-agency-tests';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

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
  return { app, store, tenancy, clock, now, call };
}

async function workspace(h: ReturnType<typeof harness>, name = 'Acme India') {
  const org = await h.call('u_owner', 'POST', '/api/orgs', { name: `${name} agency` });
  const orgId = org.body.organizationId;
  const ws = await h.call('u_owner', 'POST', `/api/orgs/${orgId}/workspaces`, {
    name,
    timeZone: 'Asia/Kolkata',
    currency: 'INR',
    defaultLanguage: 'en-IN',
    targetMarkets: [{ countryCode: 'IN' }],
  });
  return { orgId, workspaceId: ws.body.workspaceId as string };
}

// ---------------------------------------------------------------------------

describe('UTM builder', () => {
  it('preserves existing query parameters and encodes values', () => {
    const built = buildUtmUrl({
      destinationUrl: 'https://acme.example/pricing?plan=growth&ref=newsletter#faq',
      source: 'Google Ads',
      medium: 'cpc',
      campaign: 'GST Filing — Q4',
    });
    const url = new URL(built.url);
    expect(url.searchParams.get('plan')).toBe('growth');
    expect(url.searchParams.get('ref')).toBe('newsletter');
    expect(url.searchParams.get('utm_source')).toBe('google-ads');
    expect(url.searchParams.get('utm_campaign')).toBe('gst-filing-q4');
    expect(url.hash).toBe('#faq');
    expect(built.preserved).toEqual(['plan', 'ref']);
    // The normalisation is reported, not silent.
    expect(built.normalized).toEqual(
      expect.arrayContaining([
        { key: 'utm_source', from: 'Google Ads', to: 'google-ads' },
        { key: 'utm_campaign', from: 'GST Filing — Q4', to: 'gst-filing-q4' },
      ]),
    );
  });

  it('refuses to overwrite a UTM parameter that is already on the destination', () => {
    expect(() =>
      buildUtmUrl({
        destinationUrl: 'https://acme.example/x?utm_source=newsletter',
        source: 'google',
        medium: 'cpc',
        campaign: 'c1',
      }),
    ).toThrow(/already carries utm_source/);
  });

  it.each([
    ['a relative path', '/pricing'],
    ['a non-http scheme', 'javascript:alert(1)'],
    ['embedded credentials', 'https://user:pass@acme.example/x'],
    ['nonsense', 'not a url'],
  ])('rejects %s with an actionable message', (_label, destinationUrl) => {
    expect(() => buildUtmUrl({ destinationUrl, source: 'g', medium: 'cpc', campaign: 'c' })).toThrow(/destinationUrl/);
  });

  it('requires source, medium and campaign', () => {
    expect(() => buildUtmUrl({ destinationUrl: 'https://a.example/x', medium: 'cpc', campaign: 'c' })).toThrow(
      /utm_source is required/,
    );
  });

  it('reports conflicts and normalisation helpers independently', () => {
    expect(inspectUtm('https://a.example/?utm_source=x&utm_medium=y')).toEqual({ utm_source: 'x', utm_medium: 'y' });
    expect(normalizeUtmValue('  Café  Öffnungszeiten ')).toBe('cafe-offnungszeiten');
    expect(normalizeUtmValue('---')).toBe('');
  });
});

describe('campaign registry', () => {
  let h: ReturnType<typeof harness>;
  let ids: { orgId: string; workspaceId: string };
  const path = () => `/api/orgs/${ids.orgId}/workspaces/${ids.workspaceId}/campaigns`;

  beforeEach(async () => {
    h = harness();
    ids = await workspace(h);
  });

  it('creates a draft registry entry with a working tracking link — and no claim of being live', async () => {
    const res = await h.call('u_owner', 'POST', path(), {
      name: 'GST filing Q4',
      channel: 'paid_search',
      destinationUrl: 'https://acme.example/gst-filing?plan=pro',
      utm: { source: 'google', medium: 'cpc', campaign: 'gst-q4', term: 'gst filing help' },
      primaryConversion: 'qualified_lead',
      language: 'en-IN',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'draft',
      launchState: 'not_launched',
      primaryConversion: 'qualified_lead',
    });
    // Currency is a workspace property; a campaign does not get its own invented one.
    expect(res.body.currency).toBeUndefined();
    const url = new URL(res.body.trackingUrl);
    expect(url.searchParams.get('plan')).toBe('pro');
    expect(url.searchParams.get('utm_term')).toBe('gst-filing-help');
    // The term was normalised, and the response says so rather than changing it silently.
    expect(res.body.utmNormalized).toEqual([{ key: 'utm_term', from: 'gst filing help', to: 'gst-filing-help' }]);
  });

  it('validates dates and refuses an inverted range', async () => {
    const res = await h.call('u_owner', 'POST', path(), {
      name: 'Bad dates',
      destinationUrl: 'https://acme.example/x',
      utm: { source: 'google', medium: 'cpc', campaign: 'bad' },
      startDate: '2025-11-01',
      endDate: '2025-10-01',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_date_range');
  });

  it('audits creation and modification with the actor', async () => {
    const created = await h.call('u_owner', 'POST', path(), {
      name: 'Audited',
      destinationUrl: 'https://acme.example/x',
      utm: { source: 'google', medium: 'cpc', campaign: 'audited' },
    });
    await h.call('u_owner', 'PATCH', `${path()}/${created.body.campaignId}`, { status: 'ready' });

    const log = await h.store.records.list('auditLog', { orgId: ids.orgId, where: { action: 'campaign.update' } });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: 'u_owner', actorRole: 'owner', target: created.body.campaignId });
    expect(log[0].detail).toEqual({ changed: ['status'] });
  });

  it('keeps campaigns inside their workspace', async () => {
    const other = await h.call('u_owner', 'POST', `/api/orgs/${ids.orgId}/workspaces`, {
      name: 'Acme US',
      timeZone: 'America/New_York',
      currency: 'USD',
      defaultLanguage: 'en',
    });
    await h.call('u_owner', 'POST', path(), {
      name: 'Only in IN',
      destinationUrl: 'https://acme.example/in',
      utm: { source: 'google', medium: 'cpc', campaign: 'in-only' },
    });
    const usList = await h.call(
      'u_owner',
      'GET',
      `/api/orgs/${ids.orgId}/workspaces/${other.body.workspaceId}/campaigns`,
    );
    expect(usList.body.campaigns).toHaveLength(0);
  });

  it('refuses an unsupported status and an unknown field', async () => {
    const created = await h.call('u_owner', 'POST', path(), {
      name: 'C',
      destinationUrl: 'https://acme.example/x',
      utm: { source: 'google', medium: 'cpc', campaign: 'c' },
    });
    const bad = await h.call('u_owner', 'PATCH', `${path()}/${created.body.campaignId}`, { status: 'live' });
    expect(bad.body.error.code).toBe('invalid_value');
    const unknown = await h.call('u_owner', 'PATCH', `${path()}/${created.body.campaignId}`, { budget: 5000 });
    expect(unknown.body.error.code).toBe('unknown_field');
  });

  it('exposes the UTM preview the browser uses, with the same validation', async () => {
    const res = await h.call('u_owner', 'POST', `/api/orgs/${ids.orgId}/workspaces/${ids.workspaceId}/utm`, {
      destinationUrl: 'https://acme.example/x?keep=1',
      utm: { source: 'LinkedIn', medium: 'social', campaign: 'Q4 Launch' },
    });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('keep=1');
    expect(new URL(res.body.url).searchParams.get('utm_campaign')).toBe('q4-launch');
  });
});

describe('topic research with provenance', () => {
  let h: ReturnType<typeof harness>;
  let ids: { orgId: string; workspaceId: string };
  const path = () => `/api/orgs/${ids.orgId}/workspaces/${ids.workspaceId}/topics`;

  beforeEach(async () => {
    h = harness();
    ids = await workspace(h);
  });

  const observed = {
    seed: 'gst filing deadline',
    question: 'when is the gst filing deadline for small businesses',
    industry: 'accounting',
    intent: 'informational',
    funnelStage: 'top',
    market: { countryCode: 'IN', region: 'Maharashtra' },
    source: {
      url: 'https://example.gov.in/gst/deadlines',
      name: 'Official GST calendar',
      observedAt: '2025-09-01',
      method: 'manual_review',
    },
  };

  it('stores an observed topic with its source, observation date and freshness', async () => {
    const res = await h.call('u_owner', 'POST', path(), observed);
    expect(res.status).toBe(201);
    // Observed 2025-09-01, "now" is 2025-10-09: 38 days old, so fresh under the 90-day rule.
    expect(res.body).toMatchObject({ origin: 'observed', freshness: 'fresh' });
    expect(res.body.source).toMatchObject({
      url: 'https://example.gov.in/gst/deadlines',
      method: 'manual_review',
      observedAtRaw: '2025-09-01',
    });
    expect(typeof res.body.source.observedAt).toBe('number');
  });

  it('computes freshness from the observation date, not from the write time', () => {
    expect(freshnessOf(NOW - 10 * DAY, { now: () => NOW })).toBe('fresh');
    expect(freshnessOf(NOW - 120 * DAY, { now: () => NOW })).toBe('stale');
    expect(freshnessOf(null, { now: () => NOW })).toBe('unknown');
  });

  it.each([
    ['no source', { ...observed, source: undefined }],
    ['no observation date', { ...observed, source: { url: 'https://x.example/a', method: 'manual_review' } }],
    ['no collection method', { ...observed, source: { url: 'https://x.example/a', observedAt: '2025-09-01' } }],
  ])('refuses an observed topic with %s', async (_label, body) => {
    const res = await h.call('u_owner', 'POST', path(), body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('missing_provenance');
  });

  it('marks AI suggestions as suggestions, and refuses a fake source on them', async () => {
    const suggestion = await h.call('u_owner', 'POST', path(), {
      seed: 'how do I reconcile gstr-2b',
      origin: 'ai_suggested',
      intent: 'commercial',
    });
    expect(suggestion.status).toBe(201);
    expect(suggestion.body.origin).toBe('ai_suggested');
    expect(suggestion.body.source).toBeNull();

    const withSource = await h.call('u_owner', 'POST', path(), {
      seed: 'x',
      origin: 'ai_suggested',
      source: { url: 'https://x.example', observedAt: '2025-09-01', method: 'manual_review' },
    });
    expect(withSource.status).toBe(400);
    expect(withSource.body.error.code).toBe('ai_suggestion_with_source');
  });

  it('refuses metrics this product does not collect rather than estimating them', async () => {
    for (const field of ['search_volume', 'cpc', 'trend_growth', 'competitor_spend']) {
      const res = await h.call('u_owner', 'POST', path(), { ...observed, [field]: 1200 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('unsupported_metric');
      expect(res.body.error.message).toContain('not collected');
    }
  });

  it('filters by intent, origin and market, and updates review state', async () => {
    await h.call('u_owner', 'POST', path(), observed);
    await h.call('u_owner', 'POST', path(), { seed: 'suggestion one', origin: 'ai_suggested' });

    const onlyAi = await h.call('u_owner', 'GET', path(), undefined, { origin: 'ai_suggested' });
    expect(onlyAi.body.topics).toHaveLength(1);

    const inIndia = await h.call('u_owner', 'GET', path(), undefined, { countryCode: 'IN' });
    expect(inIndia.body.topics).toHaveLength(1);

    const topicId = onlyAi.body.topics[0].topicId;
    const updated = await h.call('u_owner', 'PATCH', `${path()}/${topicId}`, {
      status: 'reviewed',
      reviewer: 'u_owner',
      nextAction: 'write a landing page',
    });
    expect(updated.body).toMatchObject({ status: 'reviewed', nextAction: 'write a landing page' });

    const reviewed = await h.call('u_owner', 'GET', path(), undefined, { status: 'reviewed' });
    expect(reviewed.body.topics).toHaveLength(1);
  });

  it('requires research.write to create a topic', async () => {
    await h.call('u_owner', 'PUT', `/api/orgs/${ids.orgId}/members`, { userId: 'u_viewer', role: 'viewer' });
    const res = await h.call('u_viewer', 'POST', path(), observed);
    expect(res.status).toBe(403);
  });
});

describe('source connections', () => {
  let h: ReturnType<typeof harness>;
  let ids: { orgId: string; workspaceId: string };

  beforeEach(async () => {
    h = harness();
    ids = await workspace(h);
  });

  const path = () => `/api/orgs/${ids.orgId}/workspaces/${ids.workspaceId}/sources`;

  it('issues a key once and never returns it again', async () => {
    const created = await h.call('u_owner', 'POST', path(), { provider: 'generic', label: 'Backend' });
    expect(created.body.key.secret).toHaveLength(43); // 32 bytes base64url
    const listed = await h.call('u_owner', 'GET', path());
    expect(JSON.stringify(listed.body)).not.toContain(created.body.key.secret);
  });

  it('refuses write capability on a provider that is read-only in this product', async () => {
    const res = await h.call('u_owner', 'POST', path(), { provider: 'crm', capability: 'write' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('write_not_supported');
  });

  it('only lets a CRM be trusted for qualification', async () => {
    const res = await h.call('u_owner', 'POST', path(), { provider: 'generic', trustedForQualification: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('trusted_source_must_be_crm');
  });

  it('disconnects by revoking every key', async () => {
    const created = await h.call('u_owner', 'POST', path(), { provider: 'generic' });
    const sourceId = created.body.source.sourceConnectionId;
    const res = await h.call('u_owner', 'DELETE', `${path()}/${sourceId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disconnected');
    expect(res.body.revoked).toContain('v1');

    const keys = await h.store.records.list('ingestKeys', { where: { sourceConnectionId: sourceId } });
    expect(keys.every((k) => k.status === 'revoked')).toBe(true);
  });
});

describe('retention and deletion', () => {
  it('purges records past the policy and keeps the rest, per organization', async () => {
    const h = harness();
    const a = await workspace(h, 'A');
    const b = await h.call('u_other', 'POST', '/api/orgs', { name: 'B agency' });
    const bOrgId = b.body.organizationId;

    // One old event and one recent event per organization.
    const old = h.now() - 400 * DAY; // beyond the 396-day policy
    const recent = h.now() - 10 * DAY;
    for (const [orgId, tag] of [
      [a.orgId, 'a'],
      [bOrgId, 'b'],
    ] as const) {
      const wsId =
        orgId === a.orgId
          ? a.workspaceId
          : (
              await h.call('u_other', 'POST', `/api/orgs/${orgId}/workspaces`, {
                name: `B ${tag}`,
                timeZone: 'UTC',
                currency: 'USD',
                defaultLanguage: 'en',
              })
            ).body.workspaceId;
      await h.store.records.put(
        'events',
        `evt_old_${tag}`,
        { id: `evt_old_${tag}`, organizationId: orgId, workspaceId: wsId, occurredAt: old, eventType: 'lead_created' },
        { orgId },
      );
      await h.store.records.put(
        'events',
        `evt_new_${tag}`,
        {
          id: `evt_new_${tag}`,
          organizationId: orgId,
          workspaceId: wsId,
          occurredAt: recent,
          eventType: 'lead_created',
        },
        { orgId },
      );
    }

    const purge = await h.call('u_owner', 'POST', `/api/orgs/${a.orgId}/retention/purge`);
    expect(purge.status).toBe(200);
    expect(purge.body.removed.events).toBe(1);

    // A's old event is gone, A's recent event survives…
    expect(await h.store.records.get('events', 'evt_old_a', { orgId: a.orgId })).toBeNull();
    expect(await h.store.records.get('events', 'evt_new_a', { orgId: a.orgId })).not.toBeNull();
    // …and B is untouched by A's purge.
    expect(await h.store.records.get('events', 'evt_old_b', { orgId: bOrgId })).not.toBeNull();

    // The purge is audited.
    const log = await h.store.records.list('auditLog', { orgId: a.orgId, where: { action: 'retention.purge' } });
    expect(log).toHaveLength(1);
  });

  it('is owner-only', async () => {
    const h = harness();
    const ids = await workspace(h);
    await h.call('u_owner', 'PUT', `/api/orgs/${ids.orgId}/members`, { userId: 'u_admin', role: 'admin' });
    const res = await h.call('u_admin', 'POST', `/api/orgs/${ids.orgId}/retention/purge`);
    expect(res.status).toBe(403);
  });

  it('sweeps spent OAuth states but never saved research or topics', async () => {
    const h = harness();
    const a = await workspace(h);
    const stale = h.now() - 2 * DAY; // beyond the 1-day OAuth state policy
    const fresh = h.now() - 60_000;

    await h.store.records.put('oauthStates', 'stale_state', { id: 'stale_state', createdAt: stale }, { orgId: null });
    await h.store.records.put('oauthStates', 'fresh_state', { id: 'fresh_state', createdAt: fresh }, { orgId: null });
    // Research is a business record and topics are the evidence it cites: neither is swept
    // however old they are, so a purge must not quietly delete the agency's own history.
    await h.store.records.put(
      'researchRuns',
      'run_old',
      { id: 'run_old', organizationId: a.orgId, workspaceId: a.workspaceId, createdAt: stale, report: {} },
      { orgId: a.orgId },
    );
    await h.store.records.put(
      'topics',
      'topic_old',
      { id: 'topic_old', organizationId: a.orgId, workspaceId: a.workspaceId, createdAt: stale },
      { orgId: a.orgId },
    );

    const result = await h.store.maintenance!.purge();
    expect(result.removed.oauthStates).toBe(1);
    expect(await h.store.records.get('oauthStates', 'stale_state')).toBeNull();
    expect(await h.store.records.get('oauthStates', 'fresh_state')).not.toBeNull();
    expect(await h.store.records.get('researchRuns', 'run_old', { orgId: a.orgId })).not.toBeNull();
    expect(await h.store.records.get('topics', 'topic_old', { orgId: a.orgId })).not.toBeNull();
  });

  it('publishes the policy it applies', async () => {
    const h = harness();
    const maintenance = h.store.maintenance;
    expect(maintenance).not.toBeNull();
    const policy = maintenance!.policy();
    expect(policy.events).toBe(396);
    expect(policy.leads).toBe(760);
    expect(policy.auditLog).toBe(396);
    expect(policy.oauthStates).toBe(1);
  });
});
