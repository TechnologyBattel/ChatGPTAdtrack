// Browser-side API client. It talks only to our own server, never to
// api.ads.openai.com or bzr.openai.com — no key exists in the bundle.
//
// Every route except POST /api/track and GET /api/health requires an
// Authorization: Bearer token. In development the token comes from
// POST /api/dev/session (which 404s in production); when auth is enforced and no
// token is available, requests fail with 401 and the UI says so.

import type { Dataset } from './types';

export type HealthDetails = {
  ok: boolean;
  mode: 'live' | 'demo' | 'error';
  reason?: string;
  code?: string;
  configuration: { adsKey: boolean; capiKey: boolean; pixelId: boolean; adsKeyHint?: string; live: boolean };
  account?: { id: string; name: string; currency: string; timezone: string; status: string; review: string };
};

/** Unauthenticated /api/health returns only these two fields. */
export type PublicHealth = { ok: boolean; mode: 'live' | 'demo' | 'error' };

export type Health = PublicHealth & { details?: HealthDetails; authenticated: boolean };

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

let token: string | null = null;

export function authToken(): string | null {
  return token;
}

export function setAuthToken(next: string | null) {
  token = next;
}

export class ApiRequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
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

/**
 * Fetch health, then try to upgrade to details. An unauthenticated server
 * answers with {ok, mode} only; that is not an error, just a lower view.
 */
export async function getHealth(): Promise<Health> {
  const pub = await call<PublicHealth>('/api/health');
  try {
    const details = await call<HealthDetails>('/api/health');
    return { ...pub, details, authenticated: true };
  } catch {
    return { ...pub, authenticated: false };
  }
}

/** Development only: mints a token and returns null when the route is absent. */
export async function bootstrapDevSession(): Promise<{ token: string; role: string } | null> {
  try {
    const session = await call<{ token: string; role: string }>('/api/dev/session', { method: 'POST', body: '{}' });
    token = session.token;
    return session;
  } catch {
    return null;
  }
}

export type ConsentGrant = { consentId: string; scopes: string[]; expiresAt: string };

/** Record consent once, and use the returned id for every event afterwards. */
export function recordConsent(scopes: string[] = ['measurement'], subjectHash?: string): Promise<ConsentGrant> {
  return call<ConsentGrant>('/api/consent', {
    method: 'POST',
    body: JSON.stringify({ granted: true, scopes, subjectHash }),
  });
}

export type DatasetResponse = { mode: 'live'; dataset: Dataset } | { mode: 'demo'; reason: string };

export function getDataset(days = 90): Promise<DatasetResponse> {
  return call<DatasetResponse>(`/api/dataset?days=${days}`);
}

export function pushHints(adGroupId: string, hints: string[], signal?: AbortSignal) {
  return call<{ adGroupId: string; previousHints: string[]; pushedHints: string[]; versionedAt: string }>(
    `/api/adgroups/${encodeURIComponent(adGroupId)}/hints`,
    { method: 'POST', body: JSON.stringify({ hints }), signal },
  );
}

export function sendEvent(payload: {
  eventName: string;
  eventId: string;
  sourceUrl: string;
  /** Server-issued consent id. A boolean is rejected by the server. */
  consentId: string;
  oppref?: string;
  obref?: string;
  amountMinor?: number;
  currency?: string;
}) {
  return call<{ accepted: boolean; eventId: string }>('/api/track', { method: 'POST', body: JSON.stringify(payload) });
}
