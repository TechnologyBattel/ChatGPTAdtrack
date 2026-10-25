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

// The token is *not* held here as the source of truth: the auth provider owns
// storage (sessionStorage or memory, see lib/token-store.ts) and this module only
// reads it at request time. `setTokenReader` lets the app install that reader
// without the API client depending on the auth layer.
let readToken: () => string | null = () => null;

export function setTokenReader(reader: (() => string | null) | null) {
  readToken = reader ?? (() => null);
}

export function authToken(): string | null {
  return readToken();
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
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/api/health')) {
    // A 401 on an action means the page is missing a usable credential: the app
    // listens and offers the login overlay instead of a silent failure. The health
    // probe is excluded on purpose — it is how the app learns it is signed out, and
    // demo data must stay usable without an account.
    window.dispatchEvent(new CustomEvent('adtrack:auth-required'));
  }
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
    return await call<{ token: string; role: string }>('/api/dev/session', { method: 'POST', body: '{}' });
  } catch {
    return null;
  }
}

export type SessionGrant = { sessionId: string; expiresAt: string };

/**
 * Consent is a two-step handshake and both steps are server-issued:
 *
 *   1. POST /api/session  -> a short-lived session bound to this client
 *   2. POST /api/consent  -> a single-use consent id bound to that session
 *
 * The id is single use: every event needs its own session + consent pair. A
 * boolean `consent: true` in the event body is rejected by the server.
 */
export function startSession(): Promise<SessionGrant> {
  return call<SessionGrant>('/api/session', { method: 'POST', body: '{}' });
}

export type ConsentGrant = { consentId: string; sessionId: string; scopes: string[]; expiresAt: string };

export function grantConsent(
  sessionId: string,
  scopes: string[] = ['measurement'],
  subjectHash?: string,
): Promise<ConsentGrant> {
  return call<ConsentGrant>('/api/consent', {
    method: 'POST',
    body: JSON.stringify({ granted: true, sessionId, scopes, subjectHash }),
  });
}

/** Convenience for callers that do not need to reuse the session id. */
export async function recordConsent(scopes: string[] = ['measurement'], subjectHash?: string): Promise<ConsentGrant> {
  const session = await startSession();
  return grantConsent(session.sessionId, scopes, subjectHash);
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
  /** Both come from the server: /api/session then /api/consent. */
  sessionId: string;
  consentId: string;
  oppref?: string;
  obref?: string;
  amountMinor?: number;
  currency?: string;
}) {
  return call<{ accepted: boolean; eventId: string }>('/api/track', { method: 'POST', body: JSON.stringify(payload) });
}

export type AuditEntry = {
  id: string;
  at: number;
  action: string;
  adGroupId: string;
  before: string[];
  after: string[];
  actor: string;
  actorRole?: string;
  ok: boolean;
};

/**
 * Push history from the server store. This is the authoritative undo source; the
 * browser copy in lib/hints.ts is only a cache for the signed-out demo.
 */
export function getAuditLog(params: { adGroupId?: string; limit?: number } = {}) {
  const search = new URLSearchParams();
  if (params.adGroupId) search.set('adGroupId', params.adGroupId);
  search.set('limit', String(params.limit ?? 50));
  return call<{ entries: AuditEntry[]; actor: string }>(`/api/audit?${search.toString()}`);
}
