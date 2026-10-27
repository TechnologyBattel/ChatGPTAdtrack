// Guided research: a deterministic report assembled from data the workspace already has.
//
// Two rules shape everything here:
//
//   1. A finding is a *statement about stored records*, with the numbers attached. There
//      is no place in this module to invent a search volume, a trend, a competitor spend
//      or a percentage progress.
//   2. "We found nothing" and "we cannot measure this" are different results. Every
//      section therefore reports a state (`observed`, `no_data`, `unavailable`) and the
//      report carries the window it looked at.
//
// The report is computed on the server from the store, not from a client payload, so a
// caller cannot assert its own findings. The client only chooses a goal.

import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { oneOf, text } from './validate.mjs';
import { freshnessOf } from './freshness.mjs';
import { permissionsFor } from './tenancy.mjs';

export const RESEARCH_GOALS = ['attribution', 'lead_data', 'topics', 'sources'];

export const RESEARCH_GOAL_LABELS = {
  attribution: 'Review campaign attribution',
  lead_data: 'Understand the lead data we have',
  topics: 'Examine existing research topics',
  sources: 'Review connected data sources',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The steps the UI walks through. Each step names the real request that satisfies it, so
 * a progress view can only show work that actually happened.
 */
export function researchPlan() {
  return {
    goals: RESEARCH_GOALS.map((id) => ({ id, label: RESEARCH_GOAL_LABELS[id] })),
    steps: [
      {
        id: 'workspace',
        label: 'Workspace context',
        detail: 'Currency, time zone and markets the numbers are expressed in.',
        request: 'workspace',
      },
      {
        id: 'sources',
        label: 'Connected sources',
        detail: 'What is connected, when it last synced, and what it may not do.',
        request: 'sources',
      },
      {
        id: 'campaigns',
        label: 'Campaign registry',
        detail: 'Registered campaigns and whether any recorded touchpoints point at them.',
        request: 'campaigns',
      },
      {
        id: 'topics',
        label: 'Research topics',
        detail: 'Observed evidence versus AI suggestions, with freshness.',
        request: 'topics',
      },
      {
        id: 'leads',
        label: 'Lead funnel',
        detail: 'Leads recorded, how many were qualified, and by whom.',
        request: 'leads',
      },
      {
        id: 'analysis',
        label: 'Assemble findings',
        detail: 'The server recomputes every figure below from the records above.',
        request: 'run',
      },
    ],
  };
}

const has = (list, predicate) => list.some(predicate);

function evidence(label, value, detail = null) {
  return { label, value, detail };
}

/**
 * Pure report builder. Everything it says can be traced to one of its arguments.
 * Exported so the numbers can be tested without a server.
 */
export function buildResearchReport({
  workspace,
  sources = [],
  campaigns = [],
  topics = [],
  leads = [],
  events = [],
  permissions = [],
  goal = 'attribution',
  now = () => Date.now(),
  // Collections whose read hit the store's row cap. Their counts are lower bounds, and
  // saying so is the only honest option: a capped count presented as exact is a
  // fabricated number, even when the cap is high.
  truncated = [],
}) {
  const at = now();
  const eventTimes = events.map((e) => e.occurredAt).filter((t) => typeof t === 'number');
  const firstEventAt = eventTimes.length ? Math.min(...eventTimes) : null;
  const lastEventAt = eventTimes.length ? Math.max(...eventTimes) : null;
  const touchpoints = events.filter((e) => ['landing_visit', 'campaign_attributed_visit'].includes(e.eventType));

  const campaignsWithTouch = campaigns.filter((c) => has(touchpoints, (e) => e.campaignId === c.campaignId));
  const leadsWithTouch = leads.filter(
    (l) => (l.firstTouch !== null && l.firstTouch !== undefined) || has(touchpoints, (e) => l.eventIds?.includes(e.id)),
  );
  const qualified = leads.filter((l) => l.qualification?.status === 'qualified');
  const missingEnquiry = leads.filter((l) => l.missingEnquiryEvent === true);

  const observedTopics = topics.filter((t) => t.origin === 'observed');
  const suggestedTopics = topics.filter((t) => t.origin === 'ai_suggested');
  const staleTopics = topics.filter((t) => freshnessOf(t.source?.observedAt ?? null, { now }) === 'stale');
  // An observed topic with no usable provenance is an integrity failure. It should be
  // impossible (the API rejects it), so the report states the count rather than assuming 0.
  const unprovenanced = observedTopics.filter((t) => !t.source?.observedAt || !t.source?.url);

  const staleSources = sources.filter((s) => (s.lastSyncAt ?? null) === null || at - s.lastSyncAt > 7 * DAY_MS);
  const crmNotTrusted = sources.filter((s) => s.provider === 'crm' && !s.trustedForQualification);

  const ageOfLastEvent = lastEventAt === null ? null : at - lastEventAt;
  const dataFreshness =
    lastEventAt === null
      ? 'none'
      : ageOfLastEvent <= 7 * DAY_MS
        ? 'fresh'
        : ageOfLastEvent <= 30 * DAY_MS
          ? 'aging'
          : 'stale';

  const pct = (numerator, denominator) => (denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null);

  const findings = [];
  const add = (finding) => findings.push(finding);

  // ------------------------------------------------------------------ sources
  if (sources.length === 0) {
    add({
      id: 'sources.none',
      severity: 'gap',
      topics: ['sources', 'attribution', 'lead_data'],
      title: 'No data source is connected',
      summary:
        'Nothing in this workspace has reported an event, so attribution, lead counts and qualification coverage cannot be measured yet.',
      evidence: [evidence('Sources connected', 0)],
      limitations: ['An unconnected workspace is “unavailable”, not a workspace with zero leads.'],
      action: { label: 'Connect a CRM or send signed events', kind: 'connect_source' },
    });
  } else {
    add({
      id: 'sources.connected',
      severity: 'info',
      topics: ['sources'],
      title: `${sources.length} source${sources.length === 1 ? '' : 's'} connected`,
      summary: 'Only sources listed here can contribute events to this workspace.',
      evidence: sources.map((s) =>
        evidence(
          s.label ?? s.provider,
          s.status ?? s.connectionStatus ?? 'unknown',
          s.lastSyncAt ? `last sync ${new Date(s.lastSyncAt).toISOString()}` : 'never synced',
        ),
      ),
      limitations: ['A connected source is not proof that data is still arriving.'],
    });
    if (staleSources.length) {
      add({
        id: 'sources.stale',
        severity: 'attention',
        topics: ['sources'],
        title: `${staleSources.length} source${staleSources.length === 1 ? '' : 's'} have not synced in the last 7 days`,
        summary: 'Reports built on these sources may be out of date, even if nothing is failing.',
        evidence: staleSources.map((s) =>
          evidence(s.label ?? s.provider, s.lastSyncAt ? new Date(s.lastSyncAt).toISOString() : 'never'),
        ),
        limitations: ['A quiet week can be legitimate; this is a freshness signal, not a fault.'],
        action: { label: 'Run a manual sync', kind: 'sync_now' },
      });
    }
    if (crmNotTrusted.length) {
      add({
        id: 'sources.crm_not_trusted',
        severity: 'attention',
        topics: ['lead_data', 'sources'],
        title: 'A CRM is connected but is not trusted to qualify leads',
        summary:
          'Its contact records still create leads, but no qualification will be imported from it. That is a deliberate setting, not an error.',
        evidence: crmNotTrusted.map((s) => evidence(s.label ?? s.provider, 'not trusted for qualification')),
        limitations: ['Changing the trust setting is an administrative decision and is audited.'],
        action: { label: 'Review the source trust setting', kind: 'review_sources' },
      });
    }
  }

  // ------------------------------------------------------------- attribution
  if (events.length === 0) {
    add({
      id: 'attribution.no_events',
      severity: 'gap',
      topics: ['attribution'],
      title: 'No events have been recorded',
      summary: 'There is no activity to attribute. Nothing is reported as zero because nothing was measured.',
      evidence: [evidence('Events stored', 0)],
      limitations: ['A missing event pipeline cannot be distinguished from a quiet period.'],
      action: { label: 'Check the source that should be sending events', kind: 'review_sources' },
    });
  } else {
    add({
      id: 'attribution.window',
      severity: 'info',
      topics: ['attribution'],
      title: `Activity recorded from ${new Date(firstEventAt).toISOString().slice(0, 10)} to ${new Date(lastEventAt).toISOString().slice(0, 10)}`,
      summary: `${events.length} events in the workspace; data freshness is ${dataFreshness}.`,
      evidence: [
        evidence('Events', events.length),
        evidence('Touchpoints', touchpoints.length, 'landing visits and attributed visits only'),
        evidence('Freshness', dataFreshness, `last event ${new Date(lastEventAt).toISOString()}`),
      ],
      limitations: ['Freshness is measured against the server clock, in UTC.'],
    });

    if (touchpoints.length === 0) {
      add({
        id: 'attribution.no_touchpoints',
        severity: 'gap',
        topics: ['attribution'],
        title: 'No landing or attributed visits have been recorded',
        summary:
          'Lead attribution needs a touchpoint (a landing visit or a campaign-attributed visit). Without one, a lead has no observed campaign to point at.',
        evidence: [evidence('Events', events.length), evidence('Touchpoints', 0)],
        limitations: ['Attribution here is observed touchpoints, never proof of causation.'],
        action: { label: 'Send campaign_attributed_visit with a campaign id', kind: 'review_sources' },
      });
    } else if (leads.length > 0) {
      const coverage = pct(leadsWithTouch.length, leads.length);
      add({
        id: 'attribution.coverage',
        severity: coverage >= 60 ? 'info' : 'attention',
        topics: ['attribution', 'lead_data'],
        title: `${coverage}% of leads have an observed touchpoint`,
        summary: `${leadsWithTouch.length} of ${leads.length} leads can be traced to a landing or campaign visit inside the recorded data.`,
        evidence: [
          evidence('Leads with a touchpoint', leadsWithTouch.length),
          evidence('Leads', leads.length),
          evidence('Touchpoint events', touchpoints.length),
        ],
        limitations: [
          'A lead with no touchpoint is unattributed, not organic: absence of evidence is not evidence of absence.',
          'No view-through or incrementality is modelled.',
        ],
      });
    }

    if (campaigns.length > 0) {
      const covered = campaignsWithTouch.length;
      add({
        id: 'campaigns.touchpoints',
        severity: covered === 0 ? 'attention' : 'info',
        topics: ['attribution'],
        title:
          covered === 0
            ? 'No registered campaign has recorded a touchpoint'
            : `${covered} of ${campaigns.length} registered campaigns have recorded touchpoints`,
        summary:
          covered === 0
            ? 'Campaigns are registered, but no event carries one of their ids. A UTM link that is not used produces no attribution.'
            : 'Counts come from events that carry the campaign id, not from the campaign registry.',
        evidence: campaigns.map((c) =>
          evidence(c.name, campaignsWithTouch.includes(c) ? 'has touchpoints' : 'no touchpoints recorded'),
        ),
        limitations: ['Registry state is not delivery: a campaign here is never reported as live.'],
      });
    }
  }

  // -------------------------------------------------------------- lead data
  if (leads.length === 0) {
    add({
      id: 'leads.none',
      severity: 'gap',
      topics: ['lead_data'],
      title: 'No leads recorded',
      summary: 'Lead, qualification and revenue figures are unavailable. This is not a conversion rate of zero.',
      evidence: [evidence('Leads', 0)],
      limitations: ['A workspace that has never received a lead cannot report a funnel.'],
      action: { label: 'Connect a CRM or send lead events', kind: 'connect_source' },
    });
  } else {
    const qualificationCoverage = pct(qualified.length, leads.length);
    add({
      id: 'leads.qualification',
      severity: 'info',
      topics: ['lead_data'],
      title: `${qualified.length} of ${leads.length} leads are qualified (${qualificationCoverage}%)`,
      summary: 'Qualification is a decision by a named user or a CRM record explicitly trusted for it.',
      evidence: [
        evidence('Leads', leads.length),
        evidence('Qualified', qualified.length),
        evidence(
          'Qualification sources',
          [...new Set(qualified.map((l) => l.qualification?.source ?? 'unknown'))].join(', ') || 'none',
        ),
      ],
      limitations: [
        'A lead with no qualification is undecided, not disqualified.',
        'No revenue or lead value is inferred from qualification.',
      ],
    });
    if (missingEnquiry.length) {
      add({
        id: 'leads.missing_enquiry',
        severity: 'attention',
        topics: ['lead_data'],
        title: `${missingEnquiry.length} qualified lead${missingEnquiry.length === 1 ? '' : 's'} arrived without an enquiry event`,
        summary:
          'A qualification can arrive for someone we never saw enquire (a phone call, a referral). The gap is recorded rather than filled in.',
        evidence: [evidence('Qualified without enquiry', missingEnquiry.length)],
        limitations: ['The funnel above these leads is unknown; no stage is invented for them.'],
      });
    }
  }

  // ------------------------------------------------------------------ topics
  if (topics.length === 0) {
    add({
      id: 'topics.none',
      severity: 'info',
      topics: ['topics'],
      title: 'No research topics saved',
      summary: 'There is no saved research evidence for this workspace yet.',
      evidence: [evidence('Topics', 0)],
      limitations: ['Research suggestions are not evidence; nothing is reported as observed.'],
    });
  } else {
    add({
      id: 'topics.provenance',
      severity: 'info',
      topics: ['topics'],
      title: `${observedTopics.length} observed and ${suggestedTopics.length} suggested topic${topics.length === 1 ? '' : 's'}`,
      summary:
        'Observed topics carry a source, a method and an observation date. Suggested topics are labelled as ideas and are not evidence.',
      evidence: [
        evidence('Observed', observedTopics.length),
        evidence('AI suggested', suggestedTopics.length),
        evidence('Stale observations', staleTopics.length, 'older than 90 days'),
        evidence('Observed without provenance', unprovenanced.length),
      ],
      limitations: ['Freshness is derived from the observation date, not from the last edit.'],
    });
    if (staleTopics.length) {
      add({
        id: 'topics.stale',
        severity: 'attention',
        topics: ['topics'],
        title: `${staleTopics.length} observation${staleTopics.length === 1 ? '' : 's'} are older than 90 days`,
        summary: 'Old evidence is still evidence, but it should be re-verified before it drives a decision.',
        evidence: staleTopics
          .slice(0, 5)
          .map((t) =>
            evidence(
              t.question ?? t.seed ?? t.topicId,
              t.source?.observedAt ? new Date(t.source.observedAt).toISOString().slice(0, 10) : 'unknown date',
            ),
          ),
        limitations: ['Staleness does not mean the observation was wrong when it was made.'],
      });
    }
    if (unprovenanced.length) {
      add({
        id: 'topics.provenance_gap',
        severity: 'gap',
        topics: ['topics'],
        title: `${unprovenanced.length} observed topic${unprovenanced.length === 1 ? '' : 's'} lack usable provenance`,
        summary:
          'These records claim to be observed but cannot show where or when. Treat them as unverified until they are corrected.',
        evidence: unprovenanced.slice(0, 5).map((t) => evidence(t.topicId, 'missing source url or observation date')),
        limitations: ['This should be impossible through the API; a non-zero count is a defect, not a normal state.'],
        action: { label: 'Review the topic registry', kind: 'review_topics' },
      });
    }
  }

  if (truncated.length > 0) {
    add({
      id: 'data.truncated',
      severity: 'attention',
      topics: ['attribution', 'lead_data', 'topics', 'sources'],
      title: `Some totals are lower bounds: ${truncated.join(', ')} stopped at the read cap`,
      summary:
        'The report read as many rows as one query allows. Every affected count is a minimum ("at least"), not an exact total.',
      evidence: truncated.map((key) => evidence(`${key} (counted)`, 'at least')),
      limitations: ['Raising the read cap, or counting in the database, is required for an exact total.'],
    });
  }

  const severityRank = { gap: 0, attention: 1, info: 2 };
  findings.sort((a, b) => {
    const relevance = Number(!a.topics.includes(goal)) - Number(!b.topics.includes(goal));
    if (relevance !== 0) return relevance;
    return (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
  });

  const dataStates = {
    workspace: 'observed',
    sources: sources.length ? 'observed' : 'no_data',
    campaigns: campaigns.length ? 'observed' : 'no_data',
    topics: topics.length ? 'observed' : 'no_data',
    leads: leads.length ? 'observed' : 'no_data',
    events: events.length ? 'observed' : 'no_data',
    attribution: touchpoints.length ? 'observed' : 'unavailable',
    qualification: leads.length ? (qualified.length ? 'observed' : 'no_data') : 'unavailable',
  };

  return {
    version: 1,
    goal,
    goalLabel: RESEARCH_GOAL_LABELS[goal],
    generatedAt: at,
    workspace: {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      clientName: workspace.clientName ?? null,
      currency: workspace.currency,
      timeZone: workspace.timeZone,
      targetMarkets: workspace.targetMarkets ?? [],
    },
    window: {
      firstEventAt,
      lastEventAt,
      dataFreshness,
      // Stated once, for the whole report: there is no currency conversion in this product.
      currency: workspace.currency,
      timeZone: workspace.timeZone,
    },
    counts: {
      sources: sources.length,
      campaigns: campaigns.length,
      campaignsWithTouchpoints: campaignsWithTouch.length,
      topics: topics.length,
      observedTopics: observedTopics.length,
      suggestedTopics: suggestedTopics.length,
      leads: leads.length,
      leadsWithTouchpoints: leadsWithTouch.length,
      qualifiedLeads: qualified.length,
      events: events.length,
      touchpointEvents: touchpoints.length,
    },
    dataStates,
    // Which totals are minimums. Empty means every number above is exact for this window.
    countsAreLowerBound: [...truncated],
    permissions,
    findings,
    limitations: [
      'Findings are statements about stored records in this workspace, not market research.',
      'No keyword volume, CPC, competitor spend or trend is measured by this product; those are absent from every number above.',
      `Amounts, where present, are in ${workspace.currency}; currencies are never converted or compared directly.`,
      'Attribution is observed touchpoints within a stated window, not proof of causation.',
      ...(truncated.length
        ? [`Totals for ${truncated.join(', ')} are lower bounds: the read stopped at the store row cap.`]
        : []),
    ],
    nextActions: findings
      .filter((f) => f.action)
      .map((f) => ({ findingId: f.id, label: f.action.label, kind: f.action.kind })),
  };
}

export function createResearch({
  store,
  tenancy,
  now = () => Date.now(),
  // One query may return at most this many rows (`records.list` caps at 1,000 by default).
  // Asking for one more than the cap is what lets the report *know* it was truncated
  // instead of silently reporting a capped number as a total.
  aggregateLimit = 5000,
} = {}) {
  if (!store?.records) throw new Error('createResearch requires a store with records.');

  async function loadScoped({ principal, organizationId, workspaceId, permission }) {
    const ctx = await tenancy.context(principal, organizationId, permission);
    const workspace = await tenancy.workspace(organizationId, workspaceId, { role: ctx.role });
    const read = (collection) =>
      store.records.list(collection, { orgId: organizationId, where: { workspaceId }, limit: aggregateLimit + 1 });
    const [sources, campaigns, topics, leads, events] = await Promise.all([
      read('sources'),
      read('campaigns'),
      read('topics'),
      read('leads'),
      read('events'),
    ]);
    // A collection that came back over the cap is a lower bound; drop the sentinel row so
    // every count is "at least this many", never "this many".
    const truncated = [];
    const cap = (key, rows) => {
      if (rows.length > aggregateLimit) {
        truncated.push(key);
        return rows.slice(0, aggregateLimit);
      }
      return rows;
    };
    const scoped = {
      sources: cap('sources', sources),
      campaigns: cap('campaigns', campaigns),
      topics: cap('topics', topics),
      leads: cap('leads', leads),
      events: cap('events', events),
    };
    return { ctx, workspace, truncated, ...scoped };
  }

  async function plan({ principal, organizationId, workspaceId }) {
    await loadScoped({ principal, organizationId, workspaceId, permission: 'data.read' });
    return researchPlan();
  }

  async function create({ principal, organizationId, workspaceId, body = {} }) {
    // Saving a run is a write to shared research state, so it needs research.write.
    const scoped = await loadScoped({ principal, organizationId, workspaceId, permission: 'research.write' });
    const goal = oneOf(body?.goal ?? 'attribution', RESEARCH_GOALS, 'goal');
    const note = body?.note ? text(body.note, 'note', { max: 500 }) : null;

    const permissions = permissionsFor(scoped.ctx.role);
    const report = buildResearchReport({
      workspace: scoped.workspace,
      sources: scoped.sources,
      campaigns: scoped.campaigns,
      topics: scoped.topics,
      leads: scoped.leads,
      events: scoped.events,
      permissions,
      goal,
      now,
      truncated: scoped.truncated,
    });

    const run = {
      runId: `res_${randomBytes(9).toString('base64url')}`,
      organizationId,
      workspaceId,
      goal,
      note,
      report,
      version: 1,
      createdBy: principal.uid,
      createdAt: now(),
    };
    await store.records.put('researchRuns', run.runId, run, { orgId: organizationId });
    await tenancy.audit({
      action: 'research.run',
      organizationId,
      workspaceId,
      actor: principal.uid,
      actorRole: scoped.ctx.role,
      target: run.runId,
      detail: { goal, findings: report.findings.length, events: report.counts.events, leads: report.counts.leads },
    });
    return run;
  }

  async function list({ principal, organizationId, workspaceId, query = {} }) {
    await loadScoped({ principal, organizationId, workspaceId, permission: 'research.read' });
    const rows = await store.records.list('researchRuns', { orgId: organizationId, where: { workspaceId } });
    const limit = Math.min(50, Math.max(1, Number(query.limit ?? 20)));
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((run) => ({
        runId: run.runId,
        workspaceId: run.workspaceId,
        goal: run.goal,
        note: run.note ?? null,
        createdAt: run.createdAt,
        createdBy: run.createdBy,
        findings: run.report?.findings?.length ?? 0,
        summary: run.report?.findings?.[0]?.title ?? null,
      }));
  }

  async function get({ principal, organizationId, workspaceId, runId }) {
    await loadScoped({ principal, organizationId, workspaceId, permission: 'research.read' });
    const run = await store.records.get('researchRuns', runId, { orgId: organizationId });
    if (!run || run.workspaceId !== workspaceId) throw new ApiError(404, 'not_found', 'No such research run.');
    return run;
  }

  async function remove({ principal, organizationId, workspaceId, runId }) {
    const scoped = await loadScoped({ principal, organizationId, workspaceId, permission: 'research.write' });
    const run = await store.records.get('researchRuns', runId, { orgId: organizationId });
    if (!run || run.workspaceId !== workspaceId) throw new ApiError(404, 'not_found', 'No such research run.');
    await store.records.remove('researchRuns', runId, { orgId: organizationId });
    await tenancy.audit({
      action: 'research.delete',
      organizationId,
      workspaceId,
      actor: principal.uid,
      actorRole: scoped.ctx.role,
      target: runId,
    });
    return { runId, deleted: true };
  }

  return { plan, create, list, get, remove, buildReport: buildResearchReport };
}
