// Client for the two Phase-2 surfaces: guided research and the HubSpot connector.
//
// Everything returned here is the server's own words. This module validates nothing
// about tenancy — it cannot, and it must not pretend to: it sends ids the server already
// showed this user, and the server re-checks membership on every call.

import { ApiRequestError, authToken } from './api';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: { message?: string; code?: string } }).error;
    throw new ApiRequestError(
      res.status,
      err?.code ?? 'request_failed',
      err?.message ?? `Request failed (${res.status})`,
    );
  }
  return body as T;
}

const orgPath = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}`;
const wsPath = (orgId: string, workspaceId: string) =>
  `${orgPath(orgId)}/workspaces/${encodeURIComponent(workspaceId)}`;

// ------------------------------------------------------------------ research

export type ResearchGoalId = 'attribution' | 'lead_data' | 'topics' | 'sources';

export type ResearchStep = { id: string; label: string; detail: string; request: string };

export type ResearchPlan = {
  goals: { id: ResearchGoalId; label: string }[];
  steps: ResearchStep[];
};

/** `observed` = measured from stored records. The other two are answers, not zeros. */
export type DataState = 'observed' | 'no_data' | 'unavailable';

export type Finding = {
  id: string;
  severity: 'gap' | 'attention' | 'info';
  topics: ResearchGoalId[];
  title: string;
  summary: string;
  evidence: { label: string; value: string | number; detail: string | null }[];
  limitations: string[];
  action?: { label: string; kind: string };
};

export type ResearchReport = {
  version: number;
  goal: ResearchGoalId;
  goalLabel: string;
  generatedAt: number;
  workspace: {
    workspaceId: string;
    name: string;
    clientName: string | null;
    currency: string;
    timeZone: string;
    targetMarkets: { countryCode: string | null; region: string | null; city: string | null }[];
  };
  window: {
    firstEventAt: number | null;
    lastEventAt: number | null;
    dataFreshness: 'none' | 'fresh' | 'aging' | 'stale';
    currency: string;
    timeZone: string;
  };
  counts: Record<string, number>;
  /** Collections whose totals are minimums because the read hit the store row cap. */
  countsAreLowerBound: string[];
  dataStates: Record<string, DataState>;
  permissions: string[];
  findings: Finding[];
  limitations: string[];
  nextActions: { findingId: string; label: string; kind: string }[];
};

export type ResearchRun = {
  runId: string;
  organizationId: string;
  workspaceId: string;
  goal: ResearchGoalId;
  note: string | null;
  report: ResearchReport;
  version: number;
  createdBy: string;
  createdAt: number;
};

export type ResearchRunSummary = {
  runId: string;
  workspaceId: string;
  goal: ResearchGoalId;
  note: string | null;
  createdAt: number;
  createdBy: string;
  findings: number;
  summary: string | null;
};

export const getResearchPlan = (orgId: string, workspaceId: string) =>
  call<ResearchPlan>(`${wsPath(orgId, workspaceId)}/research/plan`);

export const createResearchRun = (orgId: string, workspaceId: string, goal: ResearchGoalId) =>
  call<ResearchRun>(`${wsPath(orgId, workspaceId)}/research/runs`, {
    method: 'POST',
    body: JSON.stringify({ goal }),
  }).then(asResearchRun);

export const listResearchRuns = (orgId: string, workspaceId: string) =>
  call<{ runs?: ResearchRunSummary[] }>(`${wsPath(orgId, workspaceId)}/research/runs`).then((r) =>
    // A malformed body is an empty list, not a crash: the caller renders "no saved reports"
    // rather than an exception inside a query.
    Array.isArray(r?.runs) ? r.runs : [],
  );

/**
 * A research run the UI can render, or an explicit failure.
 *
 * The client trusts the server's shape, but a proxy, a wrong base URL or a partial
 * deployment can return 200 with HTML. Rendering `undefined.findings` would blank the
 * page; refusing with a named error shows the failure instead.
 */
function asResearchRun(body: unknown): ResearchRun {
  const run = body as ResearchRun | null;
  if (!run || typeof run !== 'object' || !run.report || !Array.isArray(run.report.findings)) {
    throw new ApiRequestError(502, 'malformed_response', 'The server returned a research run that could not be read.');
  }
  return run;
}

export const getResearchRun = (orgId: string, workspaceId: string, runId: string) =>
  call<ResearchRun>(`${wsPath(orgId, workspaceId)}/research/runs/${encodeURIComponent(runId)}`).then(asResearchRun);

export const deleteResearchRun = (orgId: string, workspaceId: string, runId: string) =>
  call<{ runId: string; deleted: boolean }>(
    `${wsPath(orgId, workspaceId)}/research/runs/${encodeURIComponent(runId)}`,
    { method: 'DELETE' },
  );

// ----------------------------------------------------------------- connector

export type ConnectorStatus = {
  provider: 'hubspot';
  /** False when the *server* has no OAuth client or sealing key: no user can fix that. */
  configured: boolean;
  /** Environment variables that are missing, named so an operator can act on them. */
  missingConfig: string[];
  status: 'not_connected' | 'connecting' | 'connected' | 'syncing' | 'degraded' | 'failed' | 'disconnected';
  connected: boolean;
  sourceConnectionId: string | null;
  trustedForQualification: boolean;
  scopesGranted: string[];
  /**
   * False when HubSpot did not report the granted scopes. The UI must say "not verified"
   * rather than assume the scopes we asked for were the scopes we got.
   */
  scopesVerified?: boolean;
  /** A sync holds a lease right now. */
  syncInProgress?: boolean;
  syncLeaseExpiresAt?: number | null;
  /** A previous sync died holding a lease; the next sync will take it over. */
  syncStale?: boolean;
  portalId: string | null;
  lastSyncAt: number | null;
  lastSyncStatus: 'complete' | 'partial' | 'failed' | null;
  lastSync: { imported?: number; duplicates?: number; skipped?: number } | null;
  checkpoint: Record<string, { after: string | null }> | null;
  lastError: { code: string; message: string; at: number | null } | null;
  qualifiedStages: string[];
  nextAction: 'configure_server' | 'connect' | 'finish_connect' | 'run_sync' | 'reconnect';
};

export type SyncResult = {
  status: ConnectorStatus['status'];
  lastSyncStatus: 'complete' | 'partial' | 'failed' | 'cancelled';
  partial: boolean;
  trigger: 'manual' | 'webhook' | 'schedule';
  startedAt: number;
  finishedAt: number;
  /** Unique events stored by this run; a duplicate was already known. */
  imported: number;
  duplicates: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  pages: number;
  countsSemantics: string;
  error: { code: string; message: string } | null;
  connection: ConnectorStatus;
};

export const getHubSpotStatus = (orgId: string, workspaceId: string) =>
  call<ConnectorStatus>(`${wsPath(orgId, workspaceId)}/connectors/hubspot`);

export const startHubSpotConnect = (
  orgId: string,
  workspaceId: string,
  options: { trustedForQualification?: boolean; qualifiedStages?: string[] } = {},
) =>
  call<{ authorizationUrl: string; state: string; status: string }>(
    `${wsPath(orgId, workspaceId)}/connectors/hubspot/connect`,
    { method: 'POST', body: JSON.stringify(options) },
  );

export const completeHubSpotConnect = (orgId: string, workspaceId: string, body: { code: string; state: string }) =>
  call<{ status: string }>(`${wsPath(orgId, workspaceId)}/connectors/hubspot/connect/complete`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const syncHubSpot = (orgId: string, workspaceId: string) =>
  call<SyncResult>(`${wsPath(orgId, workspaceId)}/connectors/hubspot/sync`, { method: 'POST' });

export const disconnectHubSpot = (orgId: string, workspaceId: string) =>
  call<{ status: string; disconnected: boolean }>(`${wsPath(orgId, workspaceId)}/connectors/hubspot/disconnect`, {
    method: 'POST',
  });
