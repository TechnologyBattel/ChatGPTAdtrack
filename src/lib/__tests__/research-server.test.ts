// @vitest-environment node
//
// Guided research: the report builder and the saved-run service.
//
// The point of these tests is honesty, not formatting. They pin the two things the
// product promises: every number in a report traces to a stored record, and "we did not
// measure this" is never rendered as a zero.

import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../server/store.mjs';
import { createTenancy } from '../../../server/tenancy.mjs';
import { createResearch, buildResearchReport, researchPlan } from '../../../server/research.mjs';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const now = () => NOW;

const owner = { uid: 'u_owner', role: 'owner' };
const outsider = { uid: 'u_outsider', role: 'owner' };

const workspace = {
  workspaceId: 'ws_1',
  name: 'Acme India',
  clientName: 'Acme',
  currency: 'INR',
  timeZone: 'Asia/Kolkata',
  targetMarkets: [{ countryCode: 'IN' }],
};

const event = (id: string, type: string, occurredAt: number, extra: Record<string, any> = {}) => ({
  id,
  eventId: id,
  eventType: type,
  occurredAt,
  campaignId: extra.campaignId ?? null,
  consentState: 'granted',
  ...extra,
});

// ---------------------------------------------------------------- pure report

describe('buildResearchReport', () => {
  it('states an empty workspace as unavailable, never as zero performance', () => {
    const report = buildResearchReport({ workspace, now, goal: 'attribution' });
    expect(report.counts.events).toBe(0);
    expect(report.dataStates.attribution).toBe('unavailable');
    expect(report.dataStates.sources).toBe('no_data');
    expect(report.window.dataFreshness).toBe('none');
    expect(report.window.firstEventAt).toBeNull();
    expect(report.findings.map((f) => f.id)).toContain('sources.none');
    expect(report.findings.map((f) => f.id)).toContain('attribution.no_events');
    // The distinction is stated in words, not only in the enum.
    expect(JSON.stringify(report.findings)).toMatch(/unavailable/);
  });

  it('does not pretend to measure keyword volume, CPC, trend or competitor spend', () => {
    const report = buildResearchReport({ workspace, now });
    // Only the measured part: the limitations name these metrics precisely to disown them.
    const text = JSON.stringify({ counts: report.counts, findings: report.findings, window: report.window });
    expect(text).not.toMatch(/searchVolume|search_volume|cpc|competitorSpend|trendPercent/i);
    expect(report.limitations.join(' ')).toMatch(/No keyword volume, CPC, competitor spend or trend/);
  });

  it('never converts currency and says which currency the figures are in', () => {
    const report = buildResearchReport({ workspace, now });
    expect(report.window.currency).toBe('INR');
    expect(report.limitations.join(' ')).toMatch(/INR/);
    const usd = buildResearchReport({ workspace: { ...workspace, currency: 'USD' }, now });
    expect(usd.window.currency).toBe('USD');
    // Same records, same counts: the currency is a label, not a conversion.
    expect(usd.counts).toEqual(report.counts);
  });

  it('counts only stored records, and reports the window they fall in', () => {
    const events = [
      event('e1', 'landing_visit', NOW - 10 * DAY, { campaignId: 'cmp_a' }),
      event('e2', 'lead_created', NOW - 9 * DAY, { campaignId: 'cmp_a' }),
      event('e3', 'landing_visit', NOW - 2 * DAY, { campaignId: 'cmp_b' }),
    ];
    const report = buildResearchReport({
      workspace,
      events,
      campaigns: [
        { campaignId: 'cmp_a', name: 'A' },
        { campaignId: 'cmp_b', name: 'B' },
        { campaignId: 'cmp_c', name: 'C' },
      ],
      leads: [{ leadId: 'l1', firstTouch: { campaignId: 'cmp_a' }, qualification: null, eventIds: ['e2'] }],
      sources: [{ sourceConnectionId: 's1', provider: 'crm', status: 'connected', lastSyncAt: NOW - DAY }],
      topics: [],
      now,
      goal: 'attribution',
    });

    expect(report.counts.events).toBe(3);
    expect(report.counts.touchpointEvents).toBe(2);
    expect(report.counts.campaignsWithTouchpoints).toBe(2);
    expect(report.counts.leadsWithTouchpoints).toBe(1);
    expect(report.counts.qualifiedLeads).toBe(0);
    expect(report.window.firstEventAt).toBe(NOW - 10 * DAY);
    expect(report.window.lastEventAt).toBe(NOW - 2 * DAY);
    expect(report.dataStates.attribution).toBe('observed');
    // Leads exist but none qualified: that is no_data, not unavailable.
    expect(report.dataStates.qualification).toBe('no_data');
  });

  it('ranks the chosen goal first, then by severity', () => {
    const report = buildResearchReport({
      workspace,
      events: [event('e1', 'landing_visit', NOW - DAY, { campaignId: 'cmp_a' })],
      campaigns: [{ campaignId: 'cmp_a', name: 'A' }],
      sources: [{ sourceConnectionId: 's1', provider: 'crm', status: 'connected', lastSyncAt: NOW - DAY }],
      now,
      goal: 'sources',
    });
    expect(report.goalLabel).toBe('Review connected data sources');
    const first = report.findings[0];
    expect(first.topics.includes('sources')).toBe(true);
  });

  it('surfaces stale observations and unprovenanced "observed" topics separately', () => {
    const topics = [
      {
        topicId: 't_old',
        question: 'Old question',
        origin: 'observed',
        source: { url: 'https://example.test/a', observedAt: NOW - 200 * DAY },
      },
      { topicId: 't_bad', question: 'No provenance', origin: 'observed', source: {} },
      { topicId: 't_ai', seed: 'Suggestion', origin: 'ai_suggested' },
    ];
    const report = buildResearchReport({ workspace, topics, now, goal: 'topics' });
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('topics.stale');
    expect(ids).toContain('topics.provenance_gap');
    expect(report.counts.observedTopics).toBe(2);
    expect(report.counts.suggestedTopics).toBe(1);
    // The distinction survives into the report: AI suggestions are never counted as observed.
    const stale = report.findings.find((f) => f.id === 'topics.stale');
    expect(stale?.evidence.some((e) => e.label === 'Old question')).toBe(true);
    expect(stale?.evidence.some((e) => e.label === 'Suggestion')).toBe(false);
  });

  it('flags a CRM that is connected but not trusted to qualify', () => {
    const report = buildResearchReport({
      workspace,
      sources: [
        {
          sourceConnectionId: 's1',
          provider: 'crm',
          label: 'HubSpot',
          connectionStatus: 'connected',
          trustedForQualification: false,
          lastSyncAt: NOW - DAY,
        },
      ],
      now,
      goal: 'lead_data',
    });
    const finding = report.findings.find((f) => f.id === 'sources.crm_not_trusted');
    expect(finding).toBeTruthy();
    expect(finding?.severity).toBe('attention');
    expect(finding?.summary).toMatch(/deliberate setting/);
  });

  it('keeps every finding attributable: unique ids, known severities, evidence present', () => {
    const report = buildResearchReport({
      workspace,
      events: [event('e1', 'landing_visit', NOW - 40 * DAY, { campaignId: 'cmp_a' })],
      campaigns: [{ campaignId: 'cmp_a', name: 'A' }],
      sources: [{ sourceConnectionId: 's1', provider: 'crm', status: 'connected', lastSyncAt: null }],
      leads: [{ leadId: 'l1', qualification: { status: 'qualified' }, missingEnquiryEvent: true }],
      topics: [],
      now,
      goal: 'attribution',
    });
    const ids = report.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const finding of report.findings) {
      expect(['gap', 'attention', 'info']).toContain(finding.severity);
      expect(finding.topics.length).toBeGreaterThan(0);
      expect(Array.isArray(finding.evidence)).toBe(true);
      expect(Array.isArray(finding.limitations)).toBe(true);
      expect(finding.title.length).toBeGreaterThan(0);
    }
    // Stale data is described as such, with the age visible.
    expect(report.window.dataFreshness).toBe('stale');
  });
});

// ------------------------------------------------------------------- service

function harness() {
  // A clock that advances per read, so "newest first" is a real ordering and not a tie.
  const clock = { t: NOW };
  const now = () => (clock.t += 1);
  const store = createMemoryStore({ now });
  const tenancy = createTenancy({ store, now });
  const research = createResearch({ store, tenancy, now });

  async function seed(principal = owner, name = 'Agency A') {
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

  return { store, tenancy, research, seed, clock };
}

describe('createResearch', () => {
  it('exposes a plan whose steps name real requests', async () => {
    const h = harness();
    const org = await h.seed();
    const plan = await h.research.plan({ principal: owner, ...org });
    const planPrompt = researchPlan();
    expect(plan.steps.map((s) => s.id)).toEqual(planPrompt.steps.map((s) => s.id));
    for (const step of plan.steps) expect(step.request).toBeTruthy();
    expect(plan.goals.map((g) => g.id)).toEqual(['attribution', 'lead_data', 'topics', 'sources']);
  });

  it('saves a run computed on the server and ignores client-supplied findings', async () => {
    const h = harness();
    const org = await h.seed();
    const run = await h.research.create({
      principal: owner,
      ...org,
      body: {
        goal: 'lead_data',
        note: 'First look',
        // A caller trying to assert its own report.
        report: { counts: { leads: 999 }, findings: [{ id: 'fake' }] },
        counts: { leads: 999 },
      },
    });
    expect(run.report.counts.leads).toBe(0);
    expect(run.report.findings.map((f) => f.id)).not.toContain('fake');
    expect(run.goal).toBe('lead_data');
    expect(run.note).toBe('First look');
  });

  it('rejects an unknown goal and an oversized note', async () => {
    const h = harness();
    const org = await h.seed();
    await expect(
      h.research.create({ principal: owner, ...org, body: { goal: 'guaranteed_growth' } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.research.create({ principal: owner, ...org, body: { goal: 'sources', note: 'x'.repeat(501) } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('lists, reads and deletes runs, newest first, and audits the lifecycle', async () => {
    const h = harness();
    const org = await h.seed();
    const one = await h.research.create({ principal: owner, ...org, body: { goal: 'sources' } });
    const two = await h.research.create({ principal: owner, ...org, body: { goal: 'topics' } });

    const list = await h.research.list({ principal: owner, ...org });
    expect(list.map((r) => r.runId)).toEqual([two.runId, one.runId]);
    expect(list[0]).toMatchObject({ goal: 'topics', findings: expect.any(Number) });

    const fetched = await h.research.get({ principal: owner, ...org, runId: one.runId });
    expect(fetched.runId).toBe(one.runId);

    await h.research.remove({ principal: owner, ...org, runId: one.runId });
    await expect(h.research.get({ principal: owner, ...org, runId: one.runId })).rejects.toMatchObject({
      status: 404,
    });

    const audit = await h.store.records.list('auditLog', { orgId: org.organizationId });
    const actions = audit.map((a) => a.action);
    expect(actions).toContain('research.run');
    expect(actions).toContain('research.delete');
  });

  it('requires research.write to save or delete and refuses another organization entirely', async () => {
    const h = harness();
    const a = await h.seed(owner, 'Agency A');
    const b = await h.seed(outsider, 'Agency B');
    const run = await h.research.create({ principal: owner, ...a, body: { goal: 'sources' } });

    // A viewer in the same agency may read but not save.
    await h.tenancy.setMember(owner, a.organizationId, { userId: 'u_viewer', role: 'viewer' });
    await expect(
      h.research.create({ principal: { uid: 'u_viewer' }, ...a, body: { goal: 'sources' } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(h.research.list({ principal: { uid: 'u_viewer' }, ...a })).resolves.toHaveLength(1);

    // Another organization cannot see, read or delete the run.
    await expect(
      h.research.get({
        principal: outsider,
        organizationId: b.organizationId,
        workspaceId: run.workspaceId,
        runId: run.runId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(h.research.list({ principal: outsider, ...b })).resolves.toHaveLength(0);
    await expect(
      h.research.remove({
        principal: outsider,
        organizationId: b.organizationId,
        workspaceId: run.workspaceId,
        runId: run.runId,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // A run is not readable through the wrong workspace of the right org either.
    const other = await h.tenancy.createWorkspace(owner, a.organizationId, {
      name: 'Other client',
      clientName: 'Other',
      timeZone: 'Asia/Kolkata',
      currency: 'INR',
      defaultLanguage: 'en-IN',
      targetMarkets: [{ countryCode: 'IN' }],
    });
    await expect(
      h.research.get({
        principal: owner,
        organizationId: a.organizationId,
        workspaceId: other.workspaceId,
        runId: run.runId,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
