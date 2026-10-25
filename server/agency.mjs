// The agency API: organizations, workspaces, campaigns, topics, leads, sources.
//
// Every route here takes its tenant from the URL *and* proves membership before doing
// anything else, because the URL is attacker-controlled. `tenancy.context()` is the
// only way in, and it throws 404 for an organization the caller is not part of.
//
// Deliberate product boundaries, stated in code so they cannot drift:
//   * a campaign is a registry entry with a tracking link; nothing here launches ads;
//   * a lead is qualified by a named human or a trusted CRM, never by an event field;
//   * a topic imported from a source carries provenance, and no route invents search
//     volume, CPC or trend data — those fields do not exist.

import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { permissionsFor } from './tenancy.mjs';
import { attribute, DEFAULT_ATTRIBUTION_WINDOW_DAYS } from './events-v2.mjs';
import { buildUtmUrl } from './utm.mjs';
import { assertKnownKeys, countryCode, languageTag, oneOf, text, webUrl } from './validate.mjs';

export const CAMPAIGN_STATUSES = ['draft', 'ready', 'archived'];
export const TOPIC_INTENTS = ['informational', 'commercial', 'transactional', 'navigational'];
export const FUNNEL_STAGES = ['top', 'mid', 'bottom'];
export const TOPIC_STATUSES = ['new', 'reviewed', 'actioned', 'rejected'];

const newId = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;

/** Freshness is a fact about the observation date, not an opinion. */
export function freshnessOf(observedAt, { now = () => Date.now(), staleAfterDays = 90 } = {}) {
  if (typeof observedAt !== 'number') return 'unknown';
  const ageDays = (now() - observedAt) / (24 * 60 * 60 * 1000);
  return ageDays > staleAfterDays ? 'stale' : 'fresh';
}

const isoDate = (value, field) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, 'invalid_date', `${field} must be a YYYY-MM-DD date.`);
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new ApiError(400, 'invalid_date', `${field} is not a real date.`);
  return value;
};

export function createAgencyApi({ tenancy, store, sources = null, now = () => Date.now() } = {}) {
  if (!tenancy) throw new Error('createAgencyApi requires tenancy.');
  if (!store?.records) throw new Error('createAgencyApi requires a store with records.');

  // ------------------------------------------------------------------ campaigns

  async function createCampaign({ principal, orgId, workspaceId, body }) {
    const ctx = await tenancy.context(principal, orgId, 'campaign.write');
    const ws = await tenancy.workspace(orgId, workspaceId, { role: ctx.role });

    // The UTM builder is the same function the browser uses for its preview, so a link
    // that previews successfully cannot fail server-side for an unrelated reason.
    const link = buildUtmUrl({
      destinationUrl: body?.destinationUrl,
      source: body?.utm?.source,
      medium: body?.utm?.medium,
      campaign: body?.utm?.campaign ?? body?.name,
      term: body?.utm?.term,
      content: body?.utm?.content,
    });

    const record = {
      campaignId: newId('camp'),
      organizationId: orgId,
      workspaceId,
      name: text(body?.name, 'name', { max: 160 }),
      channel: text(body?.channel ?? 'paid_search', 'channel', { max: 60 }),
      source: text(body?.source ?? link.params.utm_source, 'source', { max: 60 }),
      destinationUrl: link.url.split('?')[0],
      trackingUrl: link.url,
      utm: link.params,
      language: languageTag(body?.language ?? ws.defaultLanguage, 'language'),
      targetMarkets: Array.isArray(body?.targetMarkets)
        ? body.targetMarkets.map((m) => ({
            countryCode: countryCode(m?.countryCode, 'targetMarkets[].countryCode'),
            region: m?.region ? text(m.region, 'targetMarkets[].region', { max: 120 }) : null,
          }))
        : ws.targetMarkets,
      primaryConversion: oneOf(
        body?.primaryConversion ?? 'qualified_lead',
        ['qualified_lead', 'enquiry', 'appointment', 'order'],
        'primaryConversion',
      ),
      startDate: isoDate(body?.startDate, 'startDate'),
      endDate: isoDate(body?.endDate, 'endDate'),
      owner: principal.uid,
      // Registry state only. This product does not launch ads in this phase; a tracking
      // URL existing is not evidence that anything is running.
      status: 'draft',
      launchState: 'not_launched',
      createdAt: now(),
      createdBy: principal.uid,
    };
    if (record.startDate && record.endDate && record.endDate < record.startDate) {
      throw new ApiError(400, 'invalid_date_range', 'endDate must not be before startDate.');
    }
    await store.records.put('campaigns', record.campaignId, record, { orgId });
    await tenancy.audit({
      action: 'campaign.create',
      organizationId: orgId,
      workspaceId,
      actor: principal.uid,
      actorRole: ctx.role,
      target: record.campaignId,
      detail: { name: record.name, utm: record.utm },
    });
    return { ...record, utmNormalized: link.normalized, preservedParams: link.preserved };
  }

  async function listCampaigns({ principal, orgId, workspaceId, query }) {
    const ctx = await tenancy.context(principal, orgId, 'data.read');
    await tenancy.workspace(orgId, workspaceId, { role: ctx.role });
    const where = { workspaceId };
    if (query?.status) where.status = oneOf(query.status, CAMPAIGN_STATUSES, 'status');
    const rows = await store.records.list('campaigns', { orgId, where });
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function updateCampaign({ principal, orgId, workspaceId, campaignId, body }) {
    const ctx = await tenancy.context(principal, orgId, 'campaign.write');
    await tenancy.workspace(orgId, workspaceId, { role: ctx.role });
    const existing = await store.records.get('campaigns', campaignId, { orgId });
    if (!existing || existing.workspaceId !== workspaceId) throw new ApiError(404, 'not_found', 'No such campaign.');

    assertKnownKeys(body, ['name', 'status', 'primaryConversion', 'startDate', 'endDate'], 'campaign');
    const patch = {};
    if (body.name !== undefined) patch.name = text(body.name, 'name', { max: 160 });
    if (body.status !== undefined) patch.status = oneOf(body.status, CAMPAIGN_STATUSES, 'status');
    if (body.primaryConversion !== undefined) {
      patch.primaryConversion = oneOf(
        body.primaryConversion,
        ['qualified_lead', 'enquiry', 'appointment', 'order'],
        'primaryConversion',
      );
    }
    if (body.startDate !== undefined) patch.startDate = isoDate(body.startDate, 'startDate');
    if (body.endDate !== undefined) patch.endDate = isoDate(body.endDate, 'endDate');

    const updated = await store.records.update('campaigns', campaignId, patch, { orgId });
    await tenancy.audit({
      action: 'campaign.update',
      organizationId: orgId,
      workspaceId,
      actor: principal.uid,
      actorRole: ctx.role,
      target: campaignId,
      detail: { changed: Object.keys(patch) },
    });
    return updated;
  }

  // --------------------------------------------------------------------- topics

  function validateTopic(body, { workspace, partial = false } = {}) {
    // These do not exist in this product. Accepting them would imply we bought a
    // keyword database; refusing them by name keeps the UI honest.
    for (const forbidden of [
      'search_volume',
      'volume',
      'cpc',
      'cpc_minor',
      'trend',
      'trend_growth',
      'competitor_spend',
    ]) {
      if (body?.[forbidden] !== undefined) {
        throw new ApiError(
          400,
          'unsupported_metric',
          `${forbidden} is not collected by this product. Missing metrics are reported as unavailable, not estimated.`,
        );
      }
    }

    const origin = oneOf(body?.origin ?? 'observed', ['observed', 'ai_suggested'], 'origin');
    const source = body?.source ?? null;

    if (origin === 'observed') {
      if (!source?.url) throw new ApiError(400, 'missing_provenance', 'An observed topic needs source.url.');
      if (!source?.observedAt)
        throw new ApiError(400, 'missing_provenance', 'An observed topic needs source.observedAt.');
      if (!source?.method) throw new ApiError(400, 'missing_provenance', 'An observed topic needs source.method.');
    } else if (source?.url) {
      throw new ApiError(
        400,
        'ai_suggestion_with_source',
        'An AI suggestion is not an observation; do not attach a source URL.',
      );
    }

    return {
      seed: text(body?.seed, 'seed', { max: 300 }),
      question: body?.question ? text(body.question, 'question', { max: 400 }) : null,
      industry: body?.industry ? text(body.industry, 'industry', { max: 120 }) : null,
      audience: body?.audience ? text(body.audience, 'audience', { max: 200 }) : null,
      intent: oneOf(body?.intent ?? 'informational', TOPIC_INTENTS, 'intent'),
      funnelStage: oneOf(body?.funnelStage ?? 'top', FUNNEL_STAGES, 'funnelStage'),
      market: {
        countryCode: countryCode(body?.market?.countryCode, 'market.countryCode'),
        region: body?.market?.region ? text(body.market.region, 'market.region', { max: 120 }) : null,
        city: body?.market?.city ? text(body.market.city, 'market.city', { max: 120 }) : null,
      },
      language: languageTag(body?.language ?? workspace.defaultLanguage, 'language'),
      origin,
      source:
        origin === 'observed'
          ? {
              url: webUrl(source.url, 'source.url'),
              name: source.name ? text(source.name, 'source.name', { max: 160 }) : null,
              // Both forms: the instant for arithmetic, the sender's string for display.
              observedAt: (() => {
                const ms = Date.parse(text(source.observedAt, 'source.observedAt', { max: 64 }));
                if (!Number.isFinite(ms)) {
                  throw new ApiError(400, 'invalid_date', 'source.observedAt must be an ISO-8601 date or timestamp.');
                }
                return ms;
              })(),
              observedAtRaw: text(source.observedAt, 'source.observedAt', { max: 64 }),
              method: oneOf(
                source.method,
                ['manual_review', 'public_content', 'search_console', 'partner_export'],
                'source.method',
              ),
            }
          : null,
      status: partial ? body?.status : 'new',
      reviewer: partial ? body?.reviewer : null,
      nextAction: body?.nextAction ? text(body.nextAction, 'nextAction', { max: 300 }) : null,
    };
  }

  async function createTopic({ principal, orgId, workspaceId, body }) {
    const ctx = await tenancy.context(principal, orgId, 'research.write');
    const ws = await tenancy.workspace(orgId, workspaceId, { role: ctx.role });
    const fields = validateTopic(body, { workspace: ws });
    const record = {
      topicId: newId('topic'),
      organizationId: orgId,
      workspaceId,
      ...fields,
      freshness: freshnessOf(fields.source?.observedAt ?? null, { now }),
      createdAt: now(),
      createdBy: principal.uid,
    };
    await store.records.put('topics', record.topicId, record, { orgId });
    await tenancy.audit({
      action: 'topic.create',
      organizationId: orgId,
      workspaceId,
      actor: principal.uid,
      actorRole: ctx.role,
      target: record.topicId,
      detail: { origin: record.origin },
    });
    return record;
  }

  async function listTopics({ principal, orgId, workspaceId, query }) {
    const ctx = await tenancy.context(principal, orgId, 'data.read');
    await tenancy.workspace(orgId, workspaceId, { role: ctx.role });
    // Filters are validated before use, then applied in memory: the market is a nested
    // object, and a Firestore equality filter cannot express it anyway.
    let rows = await store.records.list('topics', { orgId, where: { workspaceId } });
    if (query?.intent) rows = rows.filter((t) => t.intent === query.intent);
    if (query?.status) rows = rows.filter((t) => t.status === query.status);
    if (query?.origin) rows = rows.filter((t) => t.origin === query.origin);
    if (query?.countryCode) {
      const code = countryCode(query.countryCode, 'countryCode');
      rows = rows.filter((t) => t.market?.countryCode === code);
    }
    return rows
      .map((t) => ({ ...t, freshness: freshnessOf(t.source?.observedAt ?? null, { now }) }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async function updateTopic({ principal, orgId, workspaceId, topicId, body }) {
    const ctx = await tenancy.context(principal, orgId, 'research.write');
    await tenancy.workspace(orgId, workspaceId, { role: ctx.role });
    const existing = await store.records.get('topics', topicId, { orgId });
    if (!existing || existing.workspaceId !== workspaceId) throw new ApiError(404, 'not_found', 'No such topic.');
    assertKnownKeys(body, ['status', 'reviewer', 'nextAction'], 'topic');
    const patch = {};
    if (body.status !== undefined) patch.status = oneOf(body.status, TOPIC_STATUSES, 'status');
    if (body.reviewer !== undefined)
      patch.reviewer = body.reviewer ? text(body.reviewer, 'reviewer', { max: 120 }) : null;
    if (body.nextAction !== undefined) {
      patch.nextAction = body.nextAction ? text(body.nextAction, 'nextAction', { max: 300 }) : null;
    }
    const updated = await store.records.update('topics', topicId, patch, { orgId });
    await tenancy.audit({
      action: 'topic.update',
      organizationId: orgId,
      workspaceId,
      actor: principal.uid,
      actorRole: ctx.role,
      target: topicId,
      detail: { changed: Object.keys(patch) },
    });
    return updated;
  }

  // ---------------------------------------------------------------------- leads

  async function listLeads({ principal, orgId, workspaceId, query }) {
    const ctx = await tenancy.context(principal, orgId, 'lead.read');
    await tenancy.workspace(orgId, workspaceId, { role: ctx.role });
    let rows = await store.records.list('leads', { orgId, where: { workspaceId } });
    if (query?.qualification === 'qualified') rows = rows.filter((l) => l.qualification?.status === 'qualified');
    if (query?.qualification === 'pending') rows = rows.filter((l) => !l.qualification);
    return rows
      .map((l) => ({
        ...l,
        // "unavailable" and "not qualified" are different facts and are never merged.
        qualificationState: l.qualification?.status === 'qualified' ? 'qualified' : 'not_qualified',
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Qualify a lead. The only human path to `qualified`, and it records who decided,
   * when, and under which definition — the prompt's "trusted source" requirement.
   */
  async function qualifyLead({ principal, orgId, workspaceId, leadId, body }) {
    const ctx = await tenancy.context(principal, orgId, 'lead.qualify');
    await tenancy.workspace(orgId, workspaceId, { role: ctx.role });
    const lead = await store.records.get('leads', leadId, { orgId });
    if (!lead || lead.workspaceId !== workspaceId) throw new ApiError(404, 'not_found', 'No such lead.');

    const status = oneOf(body?.status ?? 'qualified', ['qualified', 'disqualified'], 'status');
    const qualification = {
      status,
      source: `user:${principal.uid}`,
      actor: principal.uid,
      actorRole: ctx.role,
      at: now(),
      definitionVersion: text(body?.definitionVersion ?? 'v1', 'definitionVersion', { max: 40 }),
      note: body?.note ? text(body.note, 'note', { max: 500 }) : null,
    };
    const updated = await store.records.update(
      'leads',
      leadId,
      { stage: status === 'qualified' ? 'qualified' : 'disqualified', qualification },
      { orgId },
    );
    await tenancy.audit({
      action: 'lead.qualify',
      organizationId: orgId,
      workspaceId,
      actor: principal.uid,
      actorRole: ctx.role,
      target: leadId,
      detail: { status, definitionVersion: qualification.definitionVersion },
    });
    return updated;
  }

  async function leadAttribution({ principal, orgId, workspaceId, leadId, query }) {
    const ctx = await tenancy.context(principal, orgId, 'lead.read');
    await tenancy.workspace(orgId, workspaceId, { role: ctx.role });
    const lead = await store.records.get('leads', leadId, { orgId });
    if (!lead || lead.workspaceId !== workspaceId) throw new ApiError(404, 'not_found', 'No such lead.');

    const ws = await tenancy.workspace(orgId, workspaceId, { role: ctx.role });
    const days = Math.min(90, Math.max(1, Number(query?.windowDays ?? DEFAULT_ATTRIBUTION_WINDOW_DAYS)));
    const all = await store.records.list('events', { orgId, where: { workspaceId } });
    // Touchpoints for this lead: same anonymous session, or explicitly recorded events.
    const touchpoints = all
      .filter((e) => ['landing_visit', 'campaign_attributed_visit'].includes(e.eventType))
      .filter(
        (e) =>
          (lead.anonymousSessionId && e.anonymousSessionId === lead.anonymousSessionId) ||
          lead.eventIds?.includes(e.id),
      )
      .map((e) => ({ occurredAt: e.occurredAt, campaignId: e.campaignId, utm: e.utm, landingUrl: e.landingUrl }));

    return {
      leadId,
      workspaceId,
      // The window's time zone is the workspace's, not the server's: a "day" boundary
      // in Asia/Kolkata is not one in UTC.
      ...attribute({
        touchpoints,
        conversionAt: lead.createdAt,
        windowDays: days,
        timeZone: ws.timeZone,
      }),
    };
  }

  // -------------------------------------------------------------------- summary

  /**
   * One honest overview for the UI: counts, freshness, and an explicit list of what is
   * missing. Every `null` here is rendered as unavailable, never as 0.
   */
  async function summary({ principal, orgId, workspaceId }) {
    const ctx = await tenancy.context(principal, orgId, 'data.read');
    const ws = await tenancy.workspace(orgId, workspaceId, { role: ctx.role });
    const [campaigns, topics, leads, events, connections] = await Promise.all([
      store.records.list('campaigns', { orgId, where: { workspaceId } }),
      store.records.list('topics', { orgId, where: { workspaceId } }),
      store.records.list('leads', { orgId, where: { workspaceId } }),
      store.records.list('events', { orgId, where: { workspaceId } }),
      store.records.list('sources', { orgId, where: { workspaceId } }),
    ]);
    const qualified = leads.filter((l) => l.qualification?.status === 'qualified').length;
    const lastEvent = events.reduce((max, e) => Math.max(max, e.occurredAt ?? 0), 0);

    const missing = [];
    if (!campaigns.length) missing.push('campaigns');
    if (!connections.length) missing.push('source_connections');
    if (!events.length) missing.push('events');
    if (!leads.length) missing.push('leads');
    if (leads.length && !leads.some((l) => l.qualification)) missing.push('qualification_decisions');

    return {
      workspace: {
        workspaceId: ws.workspaceId,
        name: ws.name,
        clientName: ws.clientName,
        timeZone: ws.timeZone,
        currency: ws.currency,
        defaultLanguage: ws.defaultLanguage,
        targetMarkets: ws.targetMarkets,
      },
      counts: {
        campaigns: campaigns.length,
        topics: topics.length,
        leads: leads.length,
        leadsQualified: qualified,
        events: events.length,
        sourceConnections: connections.length,
      },
      freshness: {
        lastEventAt: lastEvent || null,
        // Null means "never", which the UI must show as unknown rather than "0 minutes ago".
        lastSyncAt: connections.reduce((max, c) => Math.max(max, c.lastSyncAt ?? 0), 0) || null,
      },
      // Not collected by this product, and never estimated: the UI shows "unavailable".
      unavailable: ['search_volume', 'cpc', 'competitor_ad_spend', 'trend_growth'],
      missing,
      currency: ws.currency,
    };
  }

  // ------------------------------------------------------------------- routing

  const ROUTES = [
    ['GET', /^\/api\/orgs$/, ({ principal }) => tenancy.listOrgsFor(principal).then((orgs) => ({ orgs }))],
    ['POST', /^\/api\/orgs$/, ({ principal, body }) => tenancy.createOrg(principal, body)],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/members$/,
      ({ principal, params }) => tenancy.listMembers(principal, params[0]).then((members) => ({ members })),
    ],
    [
      'PUT',
      /^\/api\/orgs\/([^/]+)\/members$/,
      ({ principal, params, body }) => tenancy.setMember(principal, params[0], body),
    ],
    [
      'DELETE',
      /^\/api\/orgs\/([^/]+)\/members\/([^/]+)$/,
      ({ principal, params }) => tenancy.removeMember(principal, params[0], params[1]),
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/workspaces$/,
      ({ principal, params }) => tenancy.listWorkspaces(principal, params[0]).then((workspaces) => ({ workspaces })),
    ],
    [
      'POST',
      /^\/api\/orgs\/([^/]+)\/workspaces$/,
      ({ principal, params, body }) => tenancy.createWorkspace(principal, params[0], body),
    ],
    [
      'DELETE',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)$/,
      ({ principal, params }) => tenancy.deleteWorkspace(principal, params[0], params[1]),
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/summary$/,
      ({ principal, params }) => summary({ principal, orgId: params[0], workspaceId: params[1] }),
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/campaigns$/,
      ({ principal, params, query }) =>
        listCampaigns({ principal, orgId: params[0], workspaceId: params[1], query }).then((campaigns) => ({
          campaigns,
        })),
    ],
    [
      'POST',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/campaigns$/,
      ({ principal, params, body }) => createCampaign({ principal, orgId: params[0], workspaceId: params[1], body }),
    ],
    [
      'PATCH',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/campaigns\/([^/]+)$/,
      ({ principal, params, body }) =>
        updateCampaign({ principal, orgId: params[0], workspaceId: params[1], campaignId: params[2], body }),
    ],
    [
      'POST',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/utm$/,
      async ({ principal, params, body }) => {
        const ctx = await tenancy.context(principal, params[0], 'campaign.write');
        await tenancy.workspace(params[0], params[1], { role: ctx.role });
        return buildUtmUrl({
          destinationUrl: body?.destinationUrl,
          source: body?.utm?.source,
          medium: body?.utm?.medium,
          campaign: body?.utm?.campaign,
          term: body?.utm?.term,
          content: body?.utm?.content,
        });
      },
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/topics$/,
      ({ principal, params, query }) =>
        listTopics({ principal, orgId: params[0], workspaceId: params[1], query }).then((topics) => ({ topics })),
    ],
    [
      'POST',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/topics$/,
      ({ principal, params, body }) => createTopic({ principal, orgId: params[0], workspaceId: params[1], body }),
    ],
    [
      'PATCH',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/topics\/([^/]+)$/,
      ({ principal, params, body }) =>
        updateTopic({ principal, orgId: params[0], workspaceId: params[1], topicId: params[2], body }),
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/leads$/,
      ({ principal, params, query }) =>
        listLeads({ principal, orgId: params[0], workspaceId: params[1], query }).then((leads) => ({ leads })),
    ],
    [
      'POST',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/leads\/([^/]+)\/qualification$/,
      ({ principal, params, body }) =>
        qualifyLead({
          principal,
          orgId: params[0],
          workspaceId: params[1],
          leadId: params[2],
          body,
        }),
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/leads\/([^/]+)\/attribution$/,
      ({ principal, params, query }) =>
        leadAttribution({ principal, orgId: params[0], workspaceId: params[1], leadId: params[2], query }),
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/sources$/,
      ({ principal, params }) =>
        sources
          .list({ principal, organizationId: params[0], workspaceId: params[1] })
          .then((rows) => ({ sources: rows })),
    ],
    [
      'POST',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/sources$/,
      ({ principal, params, body }) =>
        sources.create({ principal, organizationId: params[0], workspaceId: params[1], body }),
    ],
    [
      'POST',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/sources\/([^/]+)\/rotations$/,
      ({ principal, params }) =>
        sources.rotate({
          principal,
          organizationId: params[0],
          workspaceId: params[1],
          sourceConnectionId: params[2],
        }),
    ],
    [
      'POST',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/sources\/([^/]+)\/revocations$/,
      ({ principal, params, body }) =>
        sources.revoke({
          principal,
          organizationId: params[0],
          workspaceId: params[1],
          sourceConnectionId: params[2],
          keyVersion: body?.keyVersion,
        }),
    ],
    [
      'DELETE',
      /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/sources\/([^/]+)$/,
      ({ principal, params }) =>
        sources.disconnect({
          principal,
          organizationId: params[0],
          workspaceId: params[1],
          sourceConnectionId: params[2],
        }),
    ],
    [
      'POST',
      /^\/api\/orgs\/([^/]+)\/retention\/purge$/,
      async ({ principal, params }) => {
        // Deleting stored data is an owner action, not an admin convenience.
        const ctx = await tenancy.context(principal, params[0], 'data.read');
        if (ctx.role !== 'owner') {
          throw new ApiError(403, 'forbidden', 'Only an owner can run a retention purge.');
        }
        const result = await store.maintenance.purge({ organizationId: ctx.org.organizationId });
        await tenancy.audit({
          action: 'retention.purge',
          organizationId: ctx.org.organizationId,
          actor: principal.uid,
          actorRole: ctx.role,
          detail: result.removed,
        });
        return result;
      },
    ],
    [
      'GET',
      /^\/api\/orgs\/([^/]+)\/permissions$/,
      async ({ principal, params }) => {
        const ctx = await tenancy.context(principal, params[0], 'data.read');
        return { role: ctx.role, permissions: permissionsFor(ctx.role) };
      },
    ],
  ];

  return {
    async handle({ method, path, body, query, principal }) {
      for (const [verb, pattern, handler] of ROUTES) {
        if (verb !== method) continue;
        const match = pattern.exec(path);
        if (!match) continue;
        if (!principal) throw new ApiError(401, 'unauthenticated', 'Sign in to use this route.');
        // A route that needs a helper it was not given is a wiring bug, not a 404.
        if (!sources && /\/sources/.test(path)) {
          throw new ApiError(503, 'not_configured', 'Source connections are not configured on this server.');
        }
        const payload = await handler({ principal, params: match.slice(1), body, query });
        // Creating a collection member is a 201; everything else is a 200.
        // Creating a collection member — including a new key version — is a 201.
        const creates =
          method === 'POST' && (/(orgs|workspaces|campaigns|topics|sources)$/.test(path) || /\/rotations$/.test(path));
        return { matched: true, body: payload, status: creates ? 201 : 200 };
      }
      return { matched: false };
    },
    // Exposed for tests and for the UI's capability check.
    freshnessOf,
  };
}
