// Guided research: the client-friendly path through data the workspace already has.
//
// Three promises this screen keeps, in code:
//
//   1. It never shows a progress percentage. The only sign of work is the elapsed time
//      of a request that is actually in flight, and the server's own list of what that
//      request reads.
//   2. "No data" and "we cannot measure this" are rendered as those words, never as 0.
//   3. Every figure comes back from the server's report. Nothing here computes a metric,
//      and the cached data is keyed by organization *and* workspace.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '../lib/api';
import { getPermissions, listOrganizations, listWorkspaces, type WorkspaceSummaryRow } from '../lib/agency';
import {
  completeHubSpotConnect,
  createResearchRun,
  deleteResearchRun,
  disconnectHubSpot,
  getHubSpotStatus,
  getResearchPlan,
  getResearchRun,
  listResearchRuns,
  startHubSpotConnect,
  syncHubSpot,
  type ConnectorStatus,
  type DataState,
  type Finding,
  type ResearchGoalId,
  type ResearchReport,
  type ResearchRun,
  type ResearchRunSummary,
  type SyncResult,
} from '../lib/connectors';

const when = (ms: number | null | undefined) =>
  typeof ms === 'number' ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never';

const day = (ms: number | null | undefined) =>
  typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 10) : 'unknown date';

/** The one place a data state becomes words. */
function stateLabel(state: DataState | undefined) {
  if (state === 'unavailable') return 'not measurable yet';
  if (state === 'no_data') return 'none found';
  return null;
}

function messageOf(error: unknown) {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return 'Sign in to load this workspace.';
    if (error.status === 403) return `Your role cannot do that: ${error.message}`;
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'The request failed.';
}

function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' | 'bad' | 'ok' }) {
  const tones: Record<string, string> = {
    muted: 'bg-cloud text-muted',
    warn: 'bg-[#fef7e0] text-[#8a6d00]',
    bad: 'bg-[#fce8e6] text-[#b3261e]',
    ok: 'bg-brandSoft text-brand',
  };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] ${tones[tone]}`}>{children}</span>;
}

function Section({
  title,
  hint,
  children,
  testId,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="rounded-xl border border-line px-3 py-3">
      <h3 className="text-[12px] font-medium text-ink">{title}</h3>
      {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

// --------------------------------------------------------------------- report

function FindingCard({ finding }: { finding: Finding }) {
  const tone = finding.severity === 'gap' ? 'bad' : finding.severity === 'attention' ? 'warn' : 'muted';
  return (
    <li data-testid="finding" className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-[12.5px] font-medium text-ink">{finding.title}</h4>
        <Badge tone={tone}>{finding.severity}</Badge>
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{finding.summary}</p>
      {finding.evidence.length > 0 && (
        <dl className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
          {finding.evidence.map((e, i) => (
            <div
              key={`${finding.id}-${i}`}
              className="flex items-baseline justify-between gap-2 rounded bg-[#fafbfc] px-2 py-1"
            >
              <dt className="text-[11px] text-muted">{e.label}</dt>
              <dd className="num text-[11px] text-ink">
                {String(e.value)}
                {e.detail ? <span className="ml-1 text-muted">· {e.detail}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {finding.limitations.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {finding.limitations.map((l, i) => (
            <li key={`${finding.id}-lim-${i}`} className="text-[10.5px] leading-relaxed text-[#80868b]">
              — {l}
            </li>
          ))}
        </ul>
      )}
      {finding.action && (
        <p className="mt-1.5 text-[11px] text-muted">
          Suggested next step: <span className="text-ink">{finding.action.label}</span>
        </p>
      )}
    </li>
  );
}

function ReportView({ report, runId }: { report: ResearchReport; runId: string | null }) {
  const countRows = useMemo(
    () =>
      Object.entries(report.counts ?? {}).map(([key, value]) => ({
        key,
        value,
        state: report.dataStates?.[key],
        // A capped read is a lower bound; showing "12" there would be a made-up total.
        lowerBound: (report.countsAreLowerBound ?? []).includes(key),
      })),
    [report],
  );

  return (
    <div data-testid="research-report" className="space-y-3">
      <Section
        title={`${report.goalLabel} · ${report.workspace.name}`}
        hint={`Generated ${when(report.generatedAt)} from stored records in ${report.window.timeZone}. Amounts, where present, are in ${report.window.currency} and are never converted.`}
      >
        <div className="flex flex-wrap gap-1.5">
          <Badge>
            events{' '}
            {report.window.firstEventAt
              ? `${day(report.window.firstEventAt)} → ${day(report.window.lastEventAt)}`
              : 'none'}
          </Badge>
          <Badge tone={report.window.dataFreshness === 'stale' ? 'warn' : 'muted'}>
            data freshness: {report.window.dataFreshness}
          </Badge>
          <Badge>{report.window.currency}</Badge>
          {runId && <Badge tone="ok">saved as {runId}</Badge>}
        </div>
      </Section>

      <Section
        title="What the server counted"
        hint="A number here means the records exist. A value shown as ≥ N is a minimum, because the read stopped at the store row cap. Where a figure could not be measured it says so instead."
      >
        <dl className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {countRows.map((row) => (
            <div key={row.key} className="flex items-baseline justify-between gap-2 rounded bg-[#fafbfc] px-2 py-1">
              <dt className="text-[11px] text-muted">{row.key.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt>
              <dd className="num text-[11px] text-ink">
                {stateLabel(row.state) ?? (row.lowerBound ? `≥ ${row.value}` : row.value)}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section
        title={`Findings (${report.findings.length})`}
        hint="Ordered by relevance to what you asked, then by severity."
      >
        {report.findings.length === 0 ? (
          <p className="text-[11px] text-muted">No findings were produced for this workspace.</p>
        ) : (
          <ul className="space-y-2">
            {(report.findings ?? []).map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="What this report does not know"
        hint="Stated once so no figure above can be read as more than it is."
      >
        <ul className="space-y-1">
          {(report.limitations ?? []).map((l, i) => (
            <li key={`lim-${i}`} className="text-[11px] leading-relaxed text-muted">
              — {l}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------ connector

function ConnectorCard({
  status,
  canManage,
  onConnect,
  onSync,
  onDisconnect,
  busy,
  lastSync,
  error,
}: {
  status: ConnectorStatus;
  canManage: boolean;
  onConnect: () => void;
  onSync: () => void;
  onDisconnect: () => void;
  busy: boolean;
  lastSync: SyncResult | null;
  error: string | null;
}) {
  const tone =
    status.status === 'connected'
      ? 'ok'
      : status.status === 'failed'
        ? 'bad'
        : status.status === 'degraded'
          ? 'warn'
          : 'muted';

  return (
    <Section
      title="CRM connection (HubSpot)"
      hint="Read-only: contacts and deals are read to create leads. Nothing is written back to your CRM."
      testId="connector-card"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={tone}>{status.status.replace('_', ' ')}</Badge>
        {status.portalId && <Badge>portal {status.portalId}</Badge>}
        <Badge>{status.scopesGranted.length ? status.scopesGranted.join(', ') : 'no scopes granted'}</Badge>
        {status.scopesVerified === false && <Badge tone="warn">scopes not reported by HubSpot</Badge>}
        {status.syncInProgress && <Badge tone="warn">a sync is running</Badge>}
        {status.syncStale && <Badge tone="warn">last sync did not finish</Badge>}
        {status.trustedForQualification ? (
          <Badge tone="ok">may qualify leads</Badge>
        ) : (
          <Badge>cannot qualify leads</Badge>
        )}
      </div>

      {!status.configured ? (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
          This server has no HubSpot app configured, so nobody can connect one yet. An operator needs to set:{' '}
          <span className="num text-ink">{status.missingConfig.join(', ') || 'HUBSPOT_CLIENT_ID'}</span>.
        </p>
      ) : (
        <>
          <p className="mt-2 text-[11.5px] text-muted">
            Last successful sync: <span className="text-ink">{when(status.lastSyncAt)}</span>
            {status.lastSyncStatus && status.lastSyncStatus !== 'complete' && (
              <span className="ml-1 text-[#8a6d00]">· last attempt: {status.lastSyncStatus}</span>
            )}
          </p>

          {status.syncStale && (
            <p className="mt-1 text-[11px] leading-relaxed text-[#8a6d00]">
              The previous sync did not finish, so a sync now will take over from it. Counts may be incomplete until it
              completes.
            </p>
          )}
          {status.lastError && (
            <p className="mt-1 rounded bg-[#fce8e6] px-2 py-1 text-[11px] text-[#b3261e]">
              {status.lastError.code}: {status.lastError.message}
            </p>
          )}
          {lastSync && (
            <p data-testid="sync-result" className="mt-1 text-[11px] text-muted">
              Sync {lastSync.lastSyncStatus}: {lastSync.imported} new, {lastSync.duplicates} already known,{' '}
              {lastSync.skipped} skipped · {lastSync.pages} page(s). {lastSync.countsSemantics}.
            </p>
          )}
          {error && <p className="mt-1 text-[11px] text-[#b3261e]">{error}</p>}

          <div className="mt-2 flex flex-wrap gap-1.5">
            {(status.status === 'not_connected' || status.status === 'disconnected' || status.status === 'failed') && (
              <button
                type="button"
                onClick={onConnect}
                disabled={!canManage || busy}
                className="rounded-full bg-brand px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-[#1765cc] disabled:opacity-50"
              >
                {status.status === 'failed' ? 'Reconnect HubSpot' : 'Connect HubSpot'}
              </button>
            )}
            {status.connected && (
              <button
                type="button"
                onClick={onSync}
                disabled={!canManage || busy}
                className="rounded-full border border-line px-2.5 py-1 text-[11px] text-ink transition hover:bg-cloud disabled:opacity-50"
              >
                {busy ? 'Syncing…' : 'Sync now'}
              </button>
            )}
            {status.connected && (
              <button
                type="button"
                onClick={onDisconnect}
                disabled={!canManage || busy}
                className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted transition hover:bg-cloud disabled:opacity-50"
              >
                Disconnect
              </button>
            )}
          </div>
          {!canManage && (
            <p className="mt-1 text-[10.5px] text-muted">
              Your role can read this connection but cannot change it (needs <span className="num">source.manage</span>
              ).
            </p>
          )}
        </>
      )}
    </Section>
  );
}

// -------------------------------------------------------------------- journey

type Scope = { organizationId: string; workspaceId: string };

export default function GuidedResearch({ onNeedSignIn }: { onNeedSignIn?: () => void }) {
  const queryClient = useQueryClient();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [goal, setGoal] = useState<ResearchGoalId>('attribution');
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [connectorError, setConnectorError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);

  const orgs = useQuery({ queryKey: ['orgs'], queryFn: listOrganizations });
  const workspaces = useQuery({
    queryKey: ['workspaces', orgId],
    queryFn: () => listWorkspaces(orgId as string),
    enabled: Boolean(orgId),
  });
  const permissions = useQuery({
    queryKey: ['permissions', orgId],
    queryFn: () => getPermissions(orgId as string),
    enabled: Boolean(orgId),
  });

  // Default to the first organization / workspace the server shows this user. The
  // server derived that list from membership; the ids are not trusted here either.
  useEffect(() => {
    if (!orgId && orgs.data?.length) setOrgId(orgs.data[0].organizationId);
  }, [orgId, orgs.data]);
  useEffect(() => {
    if (!workspaceId && workspaces.data?.length) setWorkspaceId(workspaces.data[0].workspaceId);
  }, [workspaceId, workspaces.data]);

  // Memoised so the effects below depend on the identity of a scope, not on a fresh
  // object literal every render.
  const scope: Scope | null = useMemo(
    () => (orgId && workspaceId ? { organizationId: orgId, workspaceId } : null),
    [orgId, workspaceId],
  );

  const plan = useQuery({
    queryKey: ['research-plan', orgId, workspaceId],
    queryFn: () => getResearchPlan(orgId as string, workspaceId as string),
    enabled: Boolean(scope),
  });

  const runs = useQuery({
    queryKey: ['research-runs', orgId, workspaceId],
    queryFn: () => listResearchRuns(orgId as string, workspaceId as string),
    enabled: Boolean(scope),
  });

  const connector = useQuery({
    queryKey: ['connector', 'hubspot', orgId, workspaceId],
    queryFn: () => getHubSpotStatus(orgId as string, workspaceId as string),
    enabled: Boolean(scope),
  });

  const canManageSources = permissions.data?.permissions?.includes('source.manage') ?? false;
  const canSaveResearch = permissions.data?.permissions?.includes('research.write') ?? false;

  const runMutation = useMutation({
    mutationFn: (input: Scope & { goal: ResearchGoalId }) =>
      createResearchRun(input.organizationId, input.workspaceId, input.goal),
    onMutate: () => {
      startedAt.current = Date.now();
      setElapsed(0);
    },
    onSuccess: (created) => {
      setRun(created);
      setOpenRunId(null);
      void queryClient.invalidateQueries({ queryKey: ['research-runs', orgId, workspaceId] });
    },
    onSettled: () => {
      startedAt.current = null;
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 401) onNeedSignIn?.();
    },
  });

  // The elapsed counter is a fact about the request, not a fabricated progress bar.
  useEffect(() => {
    if (!runMutation.isPending) return;
    const timer = setInterval(() => {
      if (startedAt.current) setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [runMutation.isPending]);

  const syncMutation = useMutation({
    mutationFn: (input: Scope) => syncHubSpot(input.organizationId, input.workspaceId),
    onSuccess: (result) => {
      setLastSync(result);
      setConnectorError(null);
      void queryClient.invalidateQueries({ queryKey: ['connector', 'hubspot', orgId, workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['research-runs', orgId, workspaceId] });
    },
    onError: (error) => setConnectorError(messageOf(error)),
  });

  const connectMutation = useMutation({
    mutationFn: (input: Scope) => startHubSpotConnect(input.organizationId, input.workspaceId),
    onSuccess: (result) => {
      // A full navigation to HubSpot's own consent screen; the redirect URI returns the
      // code to connect/complete. No token ever reaches this page.
      window.location.assign(result.authorizationUrl);
    },
    onError: (error) => setConnectorError(messageOf(error)),
  });

  const disconnectMutation = useMutation({
    mutationFn: (input: Scope) => disconnectHubSpot(input.organizationId, input.workspaceId),
    onSuccess: () => {
      setLastSync(null);
      void queryClient.invalidateQueries({ queryKey: ['connector', 'hubspot', orgId, workspaceId] });
    },
    onError: (error) => setConnectorError(messageOf(error)),
  });

  const openRun = useMutation({
    mutationFn: (input: Scope & { runId: string }) =>
      getResearchRun(input.organizationId, input.workspaceId, input.runId),
    onSuccess: (saved) => {
      setRun(saved);
      setOpenRunId(saved.runId);
    },
  });

  const deleteRun = useMutation({
    mutationFn: (input: Scope & { runId: string }) =>
      deleteResearchRun(input.organizationId, input.workspaceId, input.runId),
    onSuccess: (_result, input) => {
      if (run?.runId === input.runId) {
        setRun(null);
        setOpenRunId(null);
      }
      void queryClient.invalidateQueries({ queryKey: ['research-runs', orgId, workspaceId] });
    },
  });

  // The OAuth callback lands back on this page with ?code&state; finish it once.
  const [callbackState] = useState(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return null;
    window.history.replaceState(null, '', window.location.pathname);
    return { code, state };
  });
  const finishConnect = useMutation({
    mutationFn: (input: Scope & { code: string; state: string }) =>
      completeHubSpotConnect(input.organizationId, input.workspaceId, { code: input.code, state: input.state }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connector', 'hubspot', orgId, workspaceId] });
    },
    onError: (error) => setConnectorError(messageOf(error)),
  });
  const finishStarted = useRef(false);
  useEffect(() => {
    if (!callbackState || !scope || finishStarted.current) return;
    finishStarted.current = true;
    finishConnect.mutate({ ...scope, ...callbackState });
  }, [callbackState, scope, finishConnect]);

  const start = useCallback(() => {
    if (!scope) return;
    setRun(null);
    runMutation.mutate({ ...scope, goal });
  }, [goal, runMutation, scope]);

  const loadingOrgs = orgs.isLoading;
  const orgError = orgs.error ? messageOf(orgs.error) : null;

  return (
    <div className="space-y-3">
      <Section
        title="Guided research"
        hint="Pick one question. The server reads this workspace's own records and reports what it found — including what it could not measure."
        testId="guided-research"
      >
        {loadingOrgs && <p className="text-[11px] text-muted">Loading the agencies you belong to…</p>}
        {orgError && <p className="text-[11px] text-[#b3261e]">{orgError}</p>}

        {!loadingOrgs && !orgError && (orgs.data?.length ?? 0) === 0 && (
          <p className="text-[11.5px] leading-relaxed text-muted">
            You are not a member of any agency yet, so there is no workspace to research. Guided research becomes
            available once an agency exists and you have been added to it.
          </p>
        )}

        {(orgs.data?.length ?? 0) > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <label className="text-[11px] text-muted">
                Agency
                <select
                  aria-label="Agency"
                  className="mt-0.5 block rounded border border-line px-2 py-1 text-[11px] text-ink"
                  value={orgId ?? ''}
                  onChange={(e) => {
                    setOrgId(e.target.value);
                    setWorkspaceId(null);
                    setRun(null);
                    setOpenRunId(null);
                  }}
                >
                  {orgs.data?.map((o) => (
                    <option key={o.organizationId} value={o.organizationId}>
                      {o.name} ({o.role})
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-muted">
                Client workspace
                <select
                  aria-label="Client workspace"
                  className="mt-0.5 block rounded border border-line px-2 py-1 text-[11px] text-ink"
                  value={workspaceId ?? ''}
                  onChange={(e) => {
                    setWorkspaceId(e.target.value);
                    setRun(null);
                    setOpenRunId(null);
                    setLastSync(null);
                  }}
                >
                  {(workspaces.data ?? []).map((w: WorkspaceSummaryRow) => (
                    <option key={w.workspaceId} value={w.workspaceId}>
                      {w.clientName} — {w.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {(workspaces.data?.length ?? 0) === 0 && workspaces.isSuccess && (
              <p className="text-[11px] text-muted">
                This agency has no client workspace yet, so there is nothing to research.
              </p>
            )}

            {plan.isError && <p className="text-[11px] text-[#b3261e]">{messageOf(plan.error)}</p>}

            {plan.data && (
              <>
                <fieldset className="mt-1">
                  <legend className="text-[11px] text-muted">What do you want to look at?</legend>
                  <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {plan.data.goals.map((g) => (
                      <label
                        key={g.id}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-[11.5px] ${
                          goal === g.id ? 'border-brand bg-brandSoft text-brand' : 'border-line text-ink'
                        }`}
                      >
                        <input
                          type="radio"
                          name="research-goal"
                          value={g.id}
                          checked={goal === g.id}
                          onChange={() => setGoal(g.id)}
                        />
                        {g.label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={start}
                    disabled={!scope || runMutation.isPending || !canSaveResearch}
                    className="rounded-full bg-brand px-3 py-1 text-[11.5px] font-medium text-white transition hover:bg-[#1765cc] disabled:opacity-50"
                  >
                    {runMutation.isPending ? 'Reading records…' : 'Run research'}
                  </button>
                  {!canSaveResearch && permissions.isSuccess && (
                    <span className="text-[10.5px] text-muted">
                      Saving a research run needs <span className="num">research.write</span>; your role is read-only.
                    </span>
                  )}
                  {runMutation.isPending && (
                    <span className="text-[10.5px] text-muted">
                      {elapsed}s — one request is open. It reads:{' '}
                      {plan.data.steps.map((s) => s.label.toLowerCase()).join(' → ')}.
                    </span>
                  )}
                </div>

                {runMutation.isError && (
                  <p className="rounded bg-[#fce8e6] px-2 py-1 text-[11px] text-[#b3261e]">
                    {messageOf(runMutation.error)}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </Section>

      {scope && (
        <ConnectorCard
          status={
            connector.data ?? {
              provider: 'hubspot',
              configured: false,
              missingConfig: [],
              status: 'not_connected',
              connected: false,
              sourceConnectionId: null,
              trustedForQualification: false,
              scopesGranted: [],
              portalId: null,
              lastSyncAt: null,
              lastSyncStatus: null,
              lastSync: null,
              checkpoint: null,
              lastError: null,
              qualifiedStages: [],
              nextAction: 'configure_server',
              scopesVerified: false,
            }
          }
          canManage={canManageSources}
          busy={syncMutation.isPending || connectMutation.isPending || disconnectMutation.isPending}
          lastSync={lastSync}
          error={connectorError}
          onConnect={() => scope && connectMutation.mutate(scope)}
          onSync={() => scope && syncMutation.mutate(scope)}
          onDisconnect={() => scope && disconnectMutation.mutate(scope)}
        />
      )}

      {run && <ReportView report={run.report} runId={openRunId ?? run.runId} />}

      {scope && (runs.data?.length ?? 0) > 0 && (
        <Section
          title="Saved reports"
          hint="Each saved run keeps the report exactly as it was computed, so a later review cannot be rewritten by new data."
        >
          <ul className="space-y-1">
            {runs.data?.map((r: ResearchRunSummary) => (
              <li
                key={r.runId}
                className="flex flex-wrap items-center justify-between gap-2 rounded bg-[#fafbfc] px-2 py-1"
              >
                <button
                  type="button"
                  onClick={() => scope && openRun.mutate({ ...scope, runId: r.runId })}
                  className="text-left text-[11.5px] text-ink underline decoration-line hover:decoration-brand"
                >
                  {day(r.createdAt)} · {r.goal.replace('_', ' ')} · {r.findings} finding{r.findings === 1 ? '' : 's'}
                  {r.summary ? <span className="ml-1 text-muted">— {r.summary}</span> : null}
                </button>
                <button
                  type="button"
                  onClick={() => scope && deleteRun.mutate({ ...scope, runId: r.runId })}
                  disabled={!canSaveResearch || deleteRun.isPending}
                  className="text-[10.5px] text-muted underline decoration-line hover:text-[#b3261e] disabled:opacity-50"
                >
                  delete
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
