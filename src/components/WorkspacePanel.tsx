// Minimal read-only surface for the Phase-1 hierarchy: organization → workspace →
// campaigns / topics / leads / sources, plus the server's own summary.
//
// Deliberately read-only. Creating records is an authenticated API action with an
// audit trail; wiring a write button into this panel would add a second, untested
// path to the same writes. The panel's job is to show what the server reports —
// including, in plain words, what it does not know.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  getPermissions,
  getSummary,
  listCampaigns,
  listLeads,
  listOrganizations,
  listSources,
  listTopics,
  listWorkspaces,
  type Campaign,
  type Lead,
  type Organization,
  type SourceConnection,
  type Summary,
  type Topic,
  type WorkspaceSummaryRow,
} from '../lib/agency';

type Loaded = {
  orgs: Organization[];
  orgId: string | null;
  workspaces: WorkspaceSummaryRow[];
  workspaceId: string | null;
  permissions: { role: string; permissions: string[] } | null;
  summary: Summary | null;
  campaigns: Campaign[];
  topics: Topic[];
  leads: Lead[];
  sources: SourceConnection[];
};

const EMPTY: Loaded = {
  orgs: [],
  orgId: null,
  workspaces: [],
  workspaceId: null,
  permissions: null,
  summary: null,
  campaigns: [],
  topics: [],
  leads: [],
  sources: [],
};

const when = (ms: number | null) => (typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 10) : 'never');

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line px-3 py-2.5">
      <h3 className="mb-1.5 flex items-baseline justify-between text-[12px] font-medium text-ink">
        {title}
        <span className="num text-[11px] font-normal text-muted">{count}</span>
      </h3>
      {children}
    </section>
  );
}

const Empty = ({ text }: { text: string }) => <p className="text-[11px] text-muted">{text}</p>;

export default function WorkspacePanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<Loaded>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // This panel covers the page, so it has to behave like a dialog: announce itself, take
  // focus, and close on Escape. Without that a keyboard or screen-reader user is stuck in
  // a full-screen region with no announced boundary.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const loadWorkspace = useCallback(async (orgId: string, workspaceId: string) => {
    const [permissions, summary, campaigns, topics, leads, sources] = await Promise.all([
      getPermissions(orgId),
      getSummary(orgId, workspaceId),
      listCampaigns(orgId, workspaceId),
      listTopics(orgId, workspaceId),
      listLeads(orgId, workspaceId),
      listSources(orgId, workspaceId),
    ]);
    setState((s) => ({
      ...s,
      orgId,
      workspaceId,
      permissions,
      summary,
      campaigns,
      topics,
      leads,
      sources,
    }));
  }, []);

  const loadOrg = useCallback(
    async (orgId: string) => {
      const workspaces = await listWorkspaces(orgId);
      setState((s) => ({
        ...s,
        orgId,
        workspaces,
        workspaceId: null,
        permissions: null,
        summary: null,
        campaigns: [],
        topics: [],
        leads: [],
        sources: [],
      }));
      if (workspaces[0]) await loadWorkspace(orgId, workspaces[0].workspaceId);
    },
    [loadWorkspace],
  );

  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const orgs = await listOrganizations();
        if (!live) return;
        setState({ ...EMPTY, orgs });
        if (orgs[0]) await loadOrg(orgs[0].organizationId);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : 'Could not load your workspace.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [loadOrg]);

  const workspace = state.workspaces.find((w) => w.workspaceId === state.workspaceId) ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-panel-title"
      className="fixed inset-0 z-50 overflow-y-auto bg-white"
    >
      <div className="mx-auto w-full max-w-4xl px-4 py-5">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h1 id="workspace-panel-title" className="text-[18px] font-medium text-ink">
              Workspace
            </h1>
            <p className="text-[12px] text-muted">
              What the server holds for your organization. Read-only; writes are audited API actions.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full border border-line px-3 py-1 text-[12px] text-muted transition hover:bg-cloud"
          >
            Close
          </button>
        </header>

        {loading && <p className="text-[12px] text-muted">Loading…</p>}

        {!loading && error && (
          <div className="rounded-xl border border-line px-3 py-3">
            <p className="text-[12px] text-ink">{error}</p>
            <p className="mt-1 text-[11px] text-muted">
              Workspace data needs a signed-in account. Demo data and research work without one.
            </p>
          </div>
        )}

        {!loading && !error && state.orgs.length === 0 && (
          <div className="rounded-xl border border-line px-3 py-3">
            <p className="text-[12px] text-ink">No organizations yet.</p>
            <p className="mt-1 text-[11px] text-muted">
              Create one with <code>POST /api/orgs</code>. Until then there is nothing to report — which is different
              from reporting zeros.
            </p>
          </div>
        )}

        {!loading && !error && state.orgs.length > 0 && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[11px] text-muted" htmlFor="org-select">
                Organization
              </label>
              <select
                id="org-select"
                value={state.orgId ?? ''}
                onChange={(e) => void loadOrg(e.target.value)}
                className="rounded-lg border border-line px-2 py-1 text-[12px]"
              >
                {state.orgs.map((o) => (
                  <option key={o.organizationId} value={o.organizationId}>
                    {o.name} · {o.role}
                  </option>
                ))}
              </select>
              {state.workspaces.length > 0 && (
                <>
                  <label className="ml-2 text-[11px] text-muted" htmlFor="ws-select">
                    Workspace
                  </label>
                  <select
                    id="ws-select"
                    value={state.workspaceId ?? ''}
                    onChange={(e) => state.orgId && void loadWorkspace(state.orgId, e.target.value)}
                    className="rounded-lg border border-line px-2 py-1 text-[12px]"
                  >
                    {state.workspaces.map((w) => (
                      <option key={w.workspaceId} value={w.workspaceId}>
                        {w.clientName} — {w.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>

            {state.workspaces.length === 0 && (
              <Empty text="This organization has no workspace yet. Add one with POST /api/orgs/:org/workspaces." />
            )}

            {workspace && (
              <p className="text-[11px] text-muted">
                {workspace.currency} · {workspace.timeZone} ·{' '}
                {workspace.targetMarkets.length
                  ? workspace.targetMarkets.map((m) => m.countryCode ?? 'market not set').join(', ')
                  : 'no target market set'}
              </p>
            )}

            {state.permissions && (
              <p className="text-[11px] text-muted">
                Your role: <span className="text-ink">{state.permissions.role}</span> · permissions:{' '}
                {state.permissions.permissions.join(', ')}
              </p>
            )}

            {state.summary && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  { k: state.summary.counts.events, l: 'events recorded' },
                  { k: state.summary.counts.leads, l: 'leads' },
                  {
                    // No leads means there is nothing to qualify; that is "unavailable",
                    // not a 0% qualification rate.
                    k: state.summary.counts.leads === 0 ? 'unavailable' : state.summary.counts.leadsQualified,
                    l: 'qualified leads',
                  },
                  {
                    k: state.summary.freshness.lastEventAt ? when(state.summary.freshness.lastEventAt) : 'none yet',
                    l: 'last event',
                  },
                ].map((tile) => (
                  <div key={tile.l} className="rounded-xl border border-line px-3 py-2 text-center">
                    <div className="num text-[15px] text-ink">{tile.k}</div>
                    <div className="text-[11px] text-muted">{tile.l}</div>
                  </div>
                ))}
                <div className="col-span-2 rounded-xl border border-line px-3 py-2 text-[11px] text-muted sm:col-span-4">
                  Not collected by this product, so not shown as zero:{' '}
                  <span className="text-ink">{state.summary.unavailable.join(', ') || 'none'}</span>
                  {state.summary.missing.length > 0 && (
                    <>
                      {' · '}no data yet: <span className="text-ink">{state.summary.missing.join(', ')}</span>
                    </>
                  )}
                </div>
              </div>
            )}

            <Section title="Campaigns" count={state.campaigns.length}>
              {state.campaigns.length === 0 ? (
                <Empty text="No campaigns registered." />
              ) : (
                <ul className="space-y-1">
                  {state.campaigns.map((c) => (
                    <li key={c.campaignId} className="flex items-baseline justify-between gap-2 text-[12px]">
                      <span className="truncate text-ink">{c.name}</span>
                      <span className="shrink-0 text-[11px] text-muted">
                        {c.status} · {c.launchState} · {c.primaryConversion}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Topics" count={state.topics.length}>
              {state.topics.length === 0 ? (
                <Empty text="No research topics recorded." />
              ) : (
                <ul className="space-y-1">
                  {state.topics.map((t) => (
                    <li key={t.topicId} className="text-[12px]">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-ink">{t.question ?? t.seed}</span>
                        <span className="shrink-0 text-[11px] text-muted">
                          {t.intent} · {t.status} · {t.freshness}
                        </span>
                      </div>
                      <span className="text-[11px] text-muted">
                        {t.origin === 'observed' && t.source
                          ? `observed via ${t.source.method} on ${when(t.source.observedAt)}`
                          : 'AI suggestion — not observed evidence'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Leads" count={state.leads.length}>
              {state.leads.length === 0 ? (
                <Empty text="No leads recorded. A missing lead pipeline is not a zero conversion rate." />
              ) : (
                <ul className="space-y-1">
                  {state.leads.map((l) => (
                    <li key={l.leadId} className="flex items-baseline justify-between gap-2 text-[12px]">
                      <span className="truncate text-ink">{l.leadId}</span>
                      <span className="shrink-0 text-[11px] text-muted">
                        {l.qualification
                          ? `${l.qualification.status} · ${l.qualification.source}`
                          : 'not qualified by any user or CRM'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Sources" count={state.sources.length}>
              {state.sources.length === 0 ? (
                <Empty text="No source connected, so no event can be attributed yet." />
              ) : (
                <ul className="space-y-1">
                  {state.sources.map((s) => (
                    <li key={s.sourceConnectionId} className="flex items-baseline justify-between gap-2 text-[12px]">
                      <span className="truncate text-ink">
                        {s.label} <span className="text-[11px] text-muted">({s.provider})</span>
                      </span>
                      <span className="shrink-0 text-[11px] text-muted">
                        {s.capability} · {s.status} ·{' '}
                        {s.trustedForQualification ? 'may qualify leads' : 'measurement only'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
