import { useEffect, useMemo, useState } from 'react';
import { answerFor, SUGGESTIONS } from './lib/answer';
import { DEFAULT_SETTINGS, formatMoney, formatRatio } from './lib/metrics';
import { buildDataset } from './lib/demo';
import SearchBar, { type Mode } from './components/SearchBar';
import Answer from './components/Answer';
import Research from './components/Research';
import { Footer, Header, Wordmark } from './components/Chrome';

type Asked = { q: string; mode: Mode } | null;

export default function App() {
  const [dataset] = useState(() => buildDataset(90));
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [asked, setAsked] = useState<Asked>(null);
  const [mode, setMode] = useState<Mode>('track');

  // Google-style shareability: the question lives in the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const m = params.get('m');
    if (q) {
      setAsked({ q, mode: m === 'research' ? 'research' : 'track' });
      setMode(m === 'research' ? 'research' : 'track');
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (asked) {
      params.set('q', asked.q);
      params.set('m', asked.mode);
    }
    const next = params.toString();
    window.history.replaceState(null, '', next ? `?${next}` : window.location.pathname);
  }, [asked]);

  const spec = useMemo(
    () => (asked && asked.mode === 'track' ? answerFor(asked.q, dataset, settings) : null),
    [asked, dataset, settings],
  );

  const ask = (q: string, m: Mode) => {
    setAsked({ q, mode: m });
    setMode(m);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const home = () => {
    setAsked(null);
    window.scrollTo({ top: 0 });
  };

  const windowChips = [7, 14, 30] as const;

  if (!asked) {
    return (
      <div className="flex min-h-screen flex-col">
        <Header onHome={home} compact={false} />
        <main className="flex flex-1 flex-col items-center justify-center px-4 pb-24">
          <div className="w-full max-w-[680px]">
            <div className="mb-7 text-center">
              <Wordmark />
              <p className="mt-2 text-[14px] text-muted">
                Ask your ChatGPT ads one question. Get one answer: spend → leads → customers → revenue → where.
              </p>
            </div>
            <SearchBar mode={mode} onModeChange={setMode} onSubmit={ask} compact={false} suggestions={SUGGESTIONS.slice(0, 4)} />
            <div className="mx-auto mt-10 grid max-w-[620px] grid-cols-1 gap-2 sm:grid-cols-3">
              {[
                { k: formatMoney(dataset.rows.reduce((s, r) => s + r.spendMinor, 0) / 3, 'INR', true), l: 'spend in the window' },
                { k: formatRatio(dataset.rows.reduce((s, r) => s + r.salesMinor, 0) / dataset.rows.reduce((s, r) => s + r.spendMinor, 1)), l: 'blended ROAS' },
                { k: `${dataset.adGroups.length}`, l: 'ad groups with hint sets' },
              ].map((s) => (
                <div key={s.l} className="rounded-xl border border-line px-3 py-2.5 text-center">
                  <div className="num text-[18px] text-ink">{s.k}</div>
                  <div className="text-[11px] text-muted">{s.l}</div>
                </div>
              ))}
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header onHome={home} compact>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <SearchBar
              mode={asked.mode}
              onModeChange={(m) => ask(asked.q, m)}
              onSubmit={ask}
              compact
              initialQuery={asked.q}
              suggestions={[]}
            />
          </div>
          {asked.mode === 'track' && (
            <div className="hidden items-center gap-1 md:flex" role="group" aria-label="Date range">
              {windowChips.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setSettings({ ...settings, windowDays: d })}
                  aria-pressed={settings.windowDays === d}
                  className={`rounded-full px-2.5 py-1 text-[12px] transition ${
                    settings.windowDays === d ? 'bg-brandSoft text-brand' : 'text-muted hover:bg-cloud'
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          )}
        </div>
      </Header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <p className="mb-3 text-[12px] text-muted">
            <span className="rounded-full bg-cloud px-2 py-0.5">{asked.mode === 'research' ? 'research' : spec?.intent}</span>
          </p>
          {asked.mode === 'research' || !spec ? (
            <Research
              initialSeeds={asked.q}
              compactDataset={dataset}
              onFollowUp={(q, m) => ask(q, m)}
            />
          ) : (
            <Answer spec={spec} dataset={dataset} settings={settings} onFollowUp={ask} />
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
