// Private Research Mode — the UI for slice 1.
//
// This panel does exactly one thing: ask a provider to NAME clusters that the deterministic
// pipeline has already produced. It cannot add, remove, merge or reorder clusters, and it
// holds no persistence of its own.
//
// Two rules are load-bearing here:
//
//   1. The key lives in a ref, not in state. It is never rendered, never stored, never put in
//      a URL; it is cleared as soon as the request resolves. A `type="password"` input backed
//      by a ref means a re-render cannot resurrect it and React DevTools cannot show it.
//   2. The disclosure text is rendered ABOVE the key field, always, in fixed wording. It
//      says the key and seeds pass through our server in memory and that the provider may
//      retain what it receives. It does not promise anonymity we cannot deliver.

import { useCallback, useRef, useState } from 'react';
import {
  runPrivateNaming,
  type PrivateClusterInput,
  type PrivateName,
  type PrivateStatus,
} from '../lib/private-research';

type Props = {
  orgId: string;
  status: PrivateStatus;
  /** The deterministic clusters, already computed in the browser. Read-only to this panel. */
  clusters: PrivateClusterInput[];
  /** Receives id → name for display only. Never merged into the deterministic result. */
  onNamed: (names: PrivateName[]) => void;
  onClear: () => void;
};

const FIXED_MESSAGES: Record<string, string> = {
  provider_key_rejected: 'The provider rejected that key. Nothing was saved.',
  provider_throttled: 'The provider is throttling this key. Try again in a minute.',
  provider_unavailable: 'The provider could not be reached.',
  provider_timeout: 'The provider did not answer in time.',
  invalid_provider_output: 'The provider sent something unusable, so it was discarded.',
  invalid_request: 'That key or input was rejected before anything was sent.',
  invalid_provider: 'That provider is not enabled on this server.',
  invalid_model: 'That model is not enabled on this server.',
  busy: 'A run is already in progress.',
  rate_limited: 'Too many runs. Try again shortly.',
  audit_unavailable: 'The run could not be recorded, so it was discarded.',
  internal_error: 'Something went wrong on our side.',
};

export default function PrivateResearchPanel({ orgId, status, clusters, onNamed, onClear }: Props) {
  const keyRef = useRef<HTMLInputElement | null>(null);
  const [provider, setProvider] = useState(status.providers[0] ?? 'openai');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [named, setNamed] = useState(false);

  const submit = useCallback(async () => {
    const apiKey = keyRef.current?.value ?? '';
    setBusy(true);
    setError(null);
    try {
      const names = await runPrivateNaming({ orgId, provider, model, apiKey, clusters });
      onNamed(names);
      setNamed(true);
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'internal_error';
      // Only our own fixed strings are ever shown: a provider message could quote the request.
      setError(FIXED_MESSAGES[code] ?? FIXED_MESSAGES.internal_error);
    } finally {
      // The key exists no longer than it needs to. This is the whole point of the panel.
      if (keyRef.current) keyRef.current.value = '';
      setBusy(false);
    }
  }, [clusters, model, onNamed, orgId, provider]);

  return (
    <div className="rounded-xl border border-line bg-cloud/40 p-3" data-testid="private-research">
      <h3 className="text-[13px] font-medium text-ink">Private research · your key</h3>

      {/* Disclosure first, above every control. Fixed wording, not composed at runtime. */}
      <ul className="mt-2 space-y-1 text-[11px] leading-5 text-muted">
        <li>Your key and seeds pass through our server process in memory, never persisted, never logged.</li>
        <li>
          The request is sent to {provider}: <span className="text-ink">{provider}</span> may retain it under its own
          policy.
        </li>
        <li>Nothing is saved — not the key, not the seeds, not the generated names.</li>
        <li>The AI only names clusters we already computed. It cannot change, add or remove one.</li>
      </ul>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-[11px] text-muted">
          Provider
          <select
            className="ml-1 rounded-lg border border-line bg-white px-2 py-1 text-[12px]"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel('');
            }}
            disabled={busy}
          >
            {status.providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label className="text-[11px] text-muted">
          Model
          <input
            className="ml-1 w-40 rounded-lg border border-line bg-white px-2 py-1 text-[12px]"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            disabled={busy}
          />
        </label>

        <label className="text-[11px] text-muted">
          API key
          <input
            ref={keyRef}
            type="password"
            autoComplete="off"
            name="private-research-key"
            aria-label="Provider API key"
            placeholder="sk-…"
            className="ml-1 w-56 rounded-lg border border-line bg-white px-2 py-1 text-[12px]"
            disabled={busy}
          />
        </label>

        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || clusters.length === 0}
          className="rounded-full bg-brand px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Naming…' : 'Name clusters'}
        </button>

        {named && (
          <button
            type="button"
            onClick={() => {
              onClear();
              setNamed(false);
            }}
            className="rounded-full border border-line bg-white px-3 py-1.5 text-[12px] text-muted"
          >
            Use deterministic names
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-[11px] text-danger" role="alert">
          {error} Your deterministic clusters and names are unchanged.
        </p>
      )}
    </div>
  );
}
