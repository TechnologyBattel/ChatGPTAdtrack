// Agency-side API client: orgs → workspaces → campaigns / topics / leads / sources.
//
// Everything here is *observed* server state. Nothing in this module estimates a
// number: a field the server could not measure arrives as `null` or is listed in
// `unavailable`, and the panel shows that word rather than a zero.

import { ApiRequestError, authToken } from './api';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  // One token source for the whole app: the auth layer owns it (lib/api.ts).
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

export type Organization = { organizationId: string; name: string; slug: string; role: string };

export type WorkspaceSummaryRow = {
  workspaceId: string;
  name: string;
  clientName: string;
  timeZone: string;
  currency: string;
  targetMarkets: { countryCode: string | null; region: string | null; city: string | null }[];
};

export type Campaign = {
  campaignId: string;
  name: string;
  status: 'draft' | 'ready' | 'archived';
  /** Server-set: a registry entry is never reported as serving. */
  launchState: string;
  primaryConversion: string;
  createdAt: number;
};

export type Topic = {
  topicId: string;
  /** The seed the question was built from. Always present; `question` may not be. */
  seed: string;
  question: string | null;
  intent: string;
  funnelStage: string;
  status: string;
  /** `ai_suggested` is an idea, not evidence: it can never carry a source. */
  origin: 'observed' | 'ai_suggested';
  freshness: 'fresh' | 'stale' | 'unknown';
  source: {
    url: string;
    name: string | null;
    observedAt: number;
    observedAtRaw: string;
    method: 'manual_review' | 'public_content' | 'search_console' | 'partner_export';
  } | null;
};

export type Lead = {
  leadId: string;
  campaignId: string | null;
  createdAt: number;
  qualification: {
    status: string;
    source: string;
    at: number;
    by: string | null;
  } | null;
};

export type SourceConnection = {
  sourceConnectionId: string;
  provider: string;
  label: string;
  capability: 'read' | 'write';
  status: string;
  trustedForQualification: boolean;
  lastSyncAt: number | null;
};

export type Summary = {
  workspace: {
    workspaceId: string;
    name: string;
    clientName: string;
    timeZone: string;
    currency: string;
    targetMarkets: { countryCode: string | null; region: string | null; city: string | null }[];
  };
  /** Facts counted from stored records. A zero here means "we looked and found none". */
  counts: {
    campaigns: number;
    topics: number;
    leads: number;
    leadsQualified: number;
    events: number;
    sourceConnections: number;
  };
  freshness: { lastEventAt: number | null; lastSyncAt: number | null };
  /** Metrics this product does not collect. Rendered as "unavailable", never 0. */
  unavailable: string[];
  /** Areas with no data at all — different from a measured zero. */
  missing: string[];
  currency: string;
};

const orgPath = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}`;
const wsPath = (orgId: string, workspaceId: string) =>
  `${orgPath(orgId)}/workspaces/${encodeURIComponent(workspaceId)}`;

export const listOrganizations = () => call<{ orgs: Organization[] }>('/api/orgs').then((r) => r.orgs);

export const listWorkspaces = (orgId: string) =>
  call<{ workspaces: WorkspaceSummaryRow[] }>(`${orgPath(orgId)}/workspaces`).then((r) => r.workspaces);

export const getPermissions = (orgId: string) =>
  call<{ role: string; permissions: string[] }>(`${orgPath(orgId)}/permissions`);

export const getSummary = (orgId: string, workspaceId: string) =>
  call<Summary>(`${wsPath(orgId, workspaceId)}/summary`);

export const listCampaigns = (orgId: string, workspaceId: string) =>
  call<{ campaigns: Campaign[] }>(`${wsPath(orgId, workspaceId)}/campaigns`).then((r) => r.campaigns);

export const listTopics = (orgId: string, workspaceId: string) =>
  call<{ topics: Topic[] }>(`${wsPath(orgId, workspaceId)}/topics`).then((r) => r.topics);

export const listLeads = (orgId: string, workspaceId: string) =>
  call<{ leads: Lead[] }>(`${wsPath(orgId, workspaceId)}/leads`).then((r) => r.leads);

export const listSources = (orgId: string, workspaceId: string) =>
  call<{ sources: SourceConnection[] }>(`${wsPath(orgId, workspaceId)}/sources`).then((r) => r.sources);

/**
 * Preview a tracking link. The server normalises values and reports every change it
 * made, so the UI can show the difference instead of silently rewriting the URL.
 */
export const previewUtm = (
  orgId: string,
  workspaceId: string,
  input: { destinationUrl: string; source: string; medium: string; campaign: string },
) =>
  call<{ url: string; normalized: { key: string; from: string; to: string }[] }>(`${wsPath(orgId, workspaceId)}/utm`, {
    method: 'POST',
    body: JSON.stringify({ destinationUrl: input.destinationUrl, utm: input }),
  });
