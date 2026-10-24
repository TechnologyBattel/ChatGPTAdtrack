// Browser-side API client. It talks only to our own server, never to
// api.ads.openai.com or bzr.openai.com — no key exists in the bundle.

import type { Dataset } from './types';

export type Health = {
  ok: boolean;
  mode: 'live' | 'demo' | 'error';
  reason?: string;
  code?: string;
  configuration: { adsKey: boolean; capiKey: boolean; pixelId: boolean; adsKeyHint?: string; live: boolean };
  account?: { id: string; name: string; currency: string; timezone: string; status: string; review: string };
};

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as { error?: { message?: string } }).error?.message ?? `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function getHealth(): Promise<Health> {
  return call<Health>('/api/health');
}

export type DatasetResponse =
  | { mode: 'live'; dataset: Dataset }
  | { mode: 'demo'; reason: string };

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
  consent: boolean;
  oppref?: string;
  obref?: string;
  amountMinor?: number;
  currency?: string;
}) {
  return call<{ accepted: boolean; eventId: string }>('/api/track', { method: 'POST', body: JSON.stringify(payload) });
}
