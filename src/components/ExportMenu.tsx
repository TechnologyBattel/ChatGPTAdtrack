import { useEffect, useRef, useState } from 'react';

interface Props {
  query: string;
  mode: 'track' | 'research';
  /** Rendered answer text, used for the text/csv export. */
  snapshot: () => { headline: string; rows: string[][] } | null;
  disabled?: boolean;
}

export default function ExportMenu({ query, mode, snapshot, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const flash = (what: string) => {
    setCopied(what);
    setTimeout(() => setCopied(null), 1600);
  };

  const link = () => {
    const url = `${window.location.origin}${window.location.pathname}?q=${encodeURIComponent(query)}&m=${mode}`;
    navigator.clipboard?.writeText(url);
    flash('Link copied');
  };

  const csv = () => {
    const data = snapshot();
    if (!data) return;
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [esc(data.headline), '', ...data.rows.map((r) => r.map(esc).join(','))];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `adtrack-${query.slice(0, 40).replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'answer'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    flash('CSV downloaded');
  };

  const print = () => {
    setOpen(false);
    window.print();
  };

  return (
    <div className="relative shrink-0 print:hidden" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-muted transition hover:bg-cloud disabled:opacity-40"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Share
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-xl border border-line bg-white shadow-card"
        >
          <button role="menuitem" type="button" onClick={link} className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] hover:bg-cloud">
            <span>Copy link to this answer</span>
            <kbd className="rounded border border-line bg-cloud px-1 font-mono text-[10px] text-muted">URL</kbd>
          </button>
          <button role="menuitem" type="button" onClick={print} className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] hover:bg-cloud">
            <span>Print or save as PDF</span>
            <kbd className="rounded border border-line bg-cloud px-1 font-mono text-[10px] text-muted">⌘P</kbd>
          </button>
          <button role="menuitem" type="button" onClick={csv} className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] hover:bg-cloud">
            <span>Download tables as CSV</span>
            <kbd className="rounded border border-line bg-cloud px-1 font-mono text-[10px] text-muted">CSV</kbd>
          </button>
        </div>
      )}

      {copied && (
        <span
          role="status"
          className="absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded-full bg-ink px-2.5 py-1 text-[11px] text-white"
        >
          {copied}
        </span>
      )}
    </div>
  );
}
