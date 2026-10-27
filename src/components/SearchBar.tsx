import { useEffect, useRef, useState } from 'react';

export type Mode = 'track' | 'research';

interface Props {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onSubmit: (q: string, mode: Mode) => void;
  compact: boolean;
  initialQuery?: string;
  suggestions: string[];
}

export default function SearchBar({ mode, onModeChange, onSubmit, compact, initialQuery = '', suggestions }: Props) {
  const [value, setValue] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (compact) inputRef.current?.blur();
  }, [compact]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = (q: string) => {
    const text = q.trim();
    if (!text) return;
    setValue(text);
    onSubmit(text, mode);
  };

  return (
    <div className={compact ? 'w-full' : 'w-full max-w-[640px]'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
        className="flex flex-wrap items-center gap-2 rounded-3xl border border-line bg-white px-4 py-2 sm:flex-nowrap sm:rounded-full shadow-[0_1px_6px_rgba(32,33,36,0.08)] transition hover:shadow-pill focus-within:shadow-pill"
        role="search"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0 text-muted">
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
          <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={mode === 'track' ? 'Ask about your ChatGPT ads…' : 'Paste seed keywords or a topic…'}
          aria-label={mode === 'track' ? 'Ask a question about ad performance' : 'Paste seed keywords'}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] text-ink outline-none placeholder:text-subtle"
          autoComplete="off"
        />
        <div className="hidden h-6 w-px bg-line sm:block" aria-hidden />
        {/*
          The mode group stays in the layout at every width. Hiding it below `sm` made
          research unreachable on a phone — the toggle was not merely off-screen, it was
          absent from the accessibility tree. On a narrow viewport the form wraps instead.
        */}
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Answer mode">
          {(['track', 'research'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              aria-pressed={mode === m}
              className={`rounded-full px-2.5 py-1 text-[12px] transition ${
                mode === m ? 'bg-brandSoft text-brand' : 'text-muted hover:bg-cloud'
              }`}
            >
              {m === 'track' ? 'Track' : 'Research'}
            </button>
          ))}
        </div>
        <button
          type="submit"
          className="rounded-full bg-brand px-3.5 py-1.5 text-[13px] font-medium text-white transition hover:bg-[#1765cc] disabled:opacity-50"
          disabled={!value.trim()}
        >
          Ask
        </button>
      </form>

      {!compact && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {suggestions.map((s) => (
            <button key={s} className="chip" onClick={() => submit(s)} type="button">
              {s}
            </button>
          ))}
        </div>
      )}
      {!compact && (
        <p className="mt-4 text-center text-[12px] text-muted">
          Press <kbd className="rounded border border-line bg-cloud px-1 font-mono text-[11px]">/</kbd> to focus
        </p>
      )}
    </div>
  );
}
