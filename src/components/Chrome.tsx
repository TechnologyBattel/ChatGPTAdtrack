import type { ReactNode } from 'react';

export function Wordmark({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  return (
    <span className={`select-none tracking-tight ${size === 'lg' ? 'text-[46px] leading-none sm:text-[56px]' : 'text-[19px]'}`}>
      <span className="font-normal text-ink">Ad</span>
      <span className="font-medium text-brand">Track</span>
      <span aria-hidden className="ml-1 inline-block align-baseline text-[0.5em] text-[#f9ab00]">
        ●
      </span>
    </span>
  );
}

export function Header({
  children,
  onHome,
  compact,
}: {
  children?: ReactNode;
  onHome: () => void;
  compact: boolean;
}) {
  return (
    <header
      className={`sticky top-0 z-20 border-b bg-white/95 backdrop-blur ${
        compact ? 'border-line' : 'border-transparent'
      }`}
    >
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-2.5">
        <button onClick={onHome} className="shrink-0" aria-label="AdTrack home">
          <Wordmark size="sm" />
        </button>
        <div className="min-w-0 flex-1">{children}</div>
        <a
          href="https://developers.openai.com/ads"
          target="_blank"
          rel="noreferrer"
          className="hidden shrink-0 text-[12px] text-muted hover:text-ink sm:block"
        >
          Ads docs
        </a>
        <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">demo</span>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line bg-cloud">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[12px] text-muted">
        <span>AdTrack</span>
        <span aria-hidden>·</span>
        <span>Demo data, no ad account connected</span>
        <span aria-hidden>·</span>
        <span>Money in minor units (paise)</span>
        <span aria-hidden>·</span>
        <span>Geography aggregated to city level</span>
        <span className="ml-auto hidden sm:block">Built for ChatGPT Ads, 2026</span>
      </div>
    </footer>
  );
}
