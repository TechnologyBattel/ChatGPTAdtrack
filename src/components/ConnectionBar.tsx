import { useEffect, useState } from 'react';
import type { Health } from '../lib/api';

interface Props {
  health: Health | null;
  loading: boolean;
  onRetry: () => void;
  compact: boolean;
}

function Dot({ tone }: { tone: 'good' | 'warn' | 'muted' }) {
  const color = tone === 'good' ? 'bg-good' : tone === 'warn' ? 'bg-[#f9ab00]' : 'bg-[#9aa0a6]';
  return <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${color}`} />;
}

/**
 * Always visible, never a modal: the user must know whether they are looking at
 * a real ad account or at demo data before trusting any number on the page.
 */
export default function ConnectionBar({ health, loading, onRetry, compact }: Props) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (health?.mode === 'error') setExpanded(true);
  }, [health?.mode]);

  const mode = health?.mode ?? 'demo';
  const live = mode === 'live';
  const config = health?.configuration;

  const label = loading
    ? 'Connecting…'
    : live
      ? `${health?.account?.name ?? 'Ad account'} · ${health?.account?.currency ?? ''}`
      : mode === 'error'
        ? 'Connection failed'
        : 'Demo data';

  return (
    <div className={compact ? '' : 'mx-auto w-full max-w-3xl'}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-lg border border-line bg-white px-3 py-1.5 text-left text-[12px] text-muted transition hover:bg-cloud"
      >
        <Dot tone={live ? 'good' : mode === 'error' ? 'warn' : 'muted'} />
        <span className="font-medium text-ink">{label}</span>
        {live && health?.account && (
          <span className="hidden sm:inline">
            · review {health.account.review} · {health.account.timezone}
          </span>
        )}
        {!live && mode !== 'error' && <span className="hidden sm:inline">· no ad account connected</span>}
        {mode === 'error' && <span className="truncate text-warn">{health?.reason}</span>}
        <span className="ml-auto shrink-0 text-[11px]">{expanded ? 'hide' : 'details'}</span>
      </button>

      {expanded && (
        <div className="mt-1 rounded-lg border border-line bg-cloud px-3 py-2 text-[11px] leading-5 text-muted">
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            <span>
              Advertiser key: <b className="font-medium text-ink">{config?.adsKey ? 'configured' : 'missing'}</b>
              {config?.adsKeyHint ? ` (${config.adsKeyHint})` : ''}
            </span>
            <span>
              Conversions key: <b className="font-medium text-ink">{config?.capiKey ? 'configured' : 'missing'}</b>
            </span>
            <span>
              Pixel ID: <b className="font-medium text-ink">{config?.pixelId ? 'configured' : 'missing'}</b>
            </span>
          </div>
          <p className="mt-1">
            Keys live only in the API server process (<code className="font-mono">.env</code> locally, Cloud Function
            secrets in production). They are never sent to this browser — check the network tab.
          </p>
          {mode === 'error' && health?.reason && <p className="mt-1 text-warn">{health.reason}</p>}
          <div className="mt-1.5 flex items-center gap-3">
            <button type="button" onClick={onRetry} className="text-brand hover:underline">
              Retry connection
            </button>
            <span className="text-[#80868b]">
              Set OPENAI_ADS_API_KEY, OPENAI_CONVERSIONS_API_KEY and OPENAI_PIXEL_ID, then restart the API server.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
