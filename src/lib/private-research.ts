// Client for Private Research Mode (slice 1).
//
// The provider API key is a FUNCTION ARGUMENT on its way in, and nothing else. It is never
// put in React state, never written to localStorage/sessionStorage, never appended to a URL
// and never logged. The caller (PrivateResearchPanel) holds it in a ref for the duration of
// the request and clears it afterwards.
//
// This module deliberately exposes no "connect" or "save key" operation: in slice 1 there is
// no stored key to connect with.

import { ApiRequestError, authToken } from './api';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

/** Same shape as the other clients in this folder: one token source, coded errors. */
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

export interface PrivateName {
  id: string;
  name: string;
}

export interface PrivateClusterInput {
  id: string;
  label?: string;
  seeds: string[];
}

export interface PrivateStatus {
  enabled: boolean;
  providers: string[];
}

/**
 * Whether private research is switched on for this deployment, and for this caller.
 *
 * A 404 means the feature is not configured at all. Callers must treat that as "absent",
 * not as an error toast: the UI is supposed to hide the control entirely.
 */
export async function getPrivateStatus(orgId: string): Promise<PrivateStatus | null> {
  try {
    return await call<PrivateStatus>(`/api/orgs/${encodeURIComponent(orgId)}/research/private`);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 403) return null;
    throw error;
  }
}

/**
 * Name existing clusters with the caller's own key.
 *
 * Returns names for exactly the ids it was given, in the order given. A failure throws; the
 * caller keeps the deterministic names it already had, which is the whole safety property of
 * this feature.
 */
export async function runPrivateNaming(input: {
  orgId: string;
  provider: string;
  model: string;
  apiKey: string;
  clusters: PrivateClusterInput[];
}): Promise<PrivateName[]> {
  const { orgId, ...body } = input;
  const result = await call<{ names: PrivateName[] }>(`/api/orgs/${encodeURIComponent(orgId)}/research/private/run`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return result.names;
}
