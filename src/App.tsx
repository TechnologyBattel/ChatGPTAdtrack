import { useCallback, useEffect, useMemo, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { answerFor, SUGGESTIONS } from './lib/answer';
import { DEFAULT_SETTINGS, formatMoney, formatRatio, metricsOf } from './lib/metrics';
import { buildDataset } from './lib/demo';
import { getDataset, getHealth, type Health } from './lib/api';
import { AUTH_REQUIRED_EVENT, useAuth } from './lib/use-auth';
import { createQueryClient } from './lib/query-client';
import LoginScreen from './components/LoginScreen';
import type { Dataset } from './lib/types';
import SearchBar, { type Mode } from './components/SearchBar';
import Answer from './components/Answer';
import Research from './components/Research';
import GuidedResearch from './components/GuidedResearch';
import ConnectionBar from './components/ConnectionBar';
import ExportMenu from './components/ExportMenu';
import WorkspacePanel from './components/WorkspacePanel';
import { Footer, Header, Wordmark } from './components/Chrome';

type Asked = { q: string; mode: Mode } | null;

export default function App() {
  // The query cache lives with the component tree (not in main.tsx) so tests and any
  // embed of <App /> get the same behaviour as the app shell.
  const [queryClient] = useState(() => createQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}

function AppShell() {
  // Demo data is the floor: the page must never be blank because a key is missing.
  const [demo] = useState(() => buildDataset(90));
  const [dataset, setDataset] = useState<Dataset>(demo);
  const [source, setSource] = useState<'demo' | 'live'>('demo');
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [asked, setAsked] = useState<Asked>(null);
  const [mode, setMode] = useState<Mode>('track');
  const auth = useAuth();
  // The login screen is an overlay on this page, never a route: the URL still
  // carries only the question.
  const [loginOpen, setLoginOpen] = useState(false);
  // The workspace view is an overlay like the login screen, not a route: the URL
  // keeps carrying only the question.
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  const connect = useCallback(async () => {
    setLoading(true);
    try {
      // The auth layer (lib/use-auth.ts) has already restored or minted a token.
      const h = await getHealth();
      setHealth(h);
      if (h.mode === 'live' && h.authenticated) {
        const res = await getDataset(90);
        if (res.mode === 'live' && res.dataset?.rows?.length) {
          setDataset({ ...res.dataset, firstPartyAvailable: res.dataset.firstPartyAvailable ?? false });
          setSource('live');
          if (res.dataset.timezone) setSettings((s) => ({ ...s, timezone: res.dataset.timezone ?? s.timezone }));
        } else {
          setSource('demo');
        }
      } else {
        setSource('demo');
      }
    } catch {
      setHealth({ ok: false, mode: 'demo', authenticated: false });
      setSource('demo');
    } finally {
      setLoading(false);
    }
  }, []);

  // Reconnect when the credential actually changes. The first health probe can run
  // before the dev session (or the stored Firebase token) has been restored, and
  // without this the page stays stuck on demo data after a successful sign-in.
  useEffect(() => {
    if (!auth.ready) return;
    void connect();
  }, [connect, auth.ready, auth.session?.token]);

  // A 401 anywhere means we need a credential: offer the overlay rather than a
  // dead panel. Dev mode usually signs in silently first, so this is rare there.
  useEffect(() => {
    const open = () => setLoginOpen(true);
    window.addEventListener(AUTH_REQUIRED_EVENT, open);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, open);
  }, []);

  const authSlot = auth.session ? (
    <button
      type="button"
      onClick={() => {
        auth.signOut();
        setLoginOpen(false);
        setSource('demo');
        void connect();
      }}
      className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] text-muted transition hover:bg-cloud"
    >
      Sign out
    </button>
  ) : (
    <button
      type="button"
      onClick={() => setLoginOpen(true)}
      className="shrink-0 rounded-full bg-brand px-3 py-1 text-[11px] font-medium text-white transition hover:bg-[#1765cc]"
    >
      Sign in
    </button>
  );

  // Workspace is an explicit, labelled control rather than a nav tab: the product is
  // still one page with one question.
  const headerActions = (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => setWorkspaceOpen(true)}
        className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] text-muted transition hover:bg-cloud"
      >
        Workspace
      </button>
      {authSlot}
    </div>
  );

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

  const snapshot = () => {
    if (!spec) return null;
    const rows: string[][] = [];
    for (const section of spec.sections) {
      if (section.kind === 'table') {
        rows.push([section.title], section.columns, ...section.rows, []);
      }
    }
    return { headline: spec.headline, rows };
  };

  const windowChips = [7, 14, 30] as const;
  const totals = useMemo(() => metricsOf(dataset.rows), [dataset]);

  if (workspaceOpen) {
    return <WorkspacePanel onClose={() => setWorkspaceOpen(false)} />;
  }

  if (loginOpen && !auth.session) {
    return (
      <div className="fixed inset-0 z-50 overflow-y-auto bg-white">
        <LoginScreen
          provider={auth.provider}
          reason="Sign in to load your ad account. Demo data needs no account."
          onSignedIn={() => {
            setLoginOpen(false);
            void connect();
          }}
        />
      </div>
    );
  }

  if (!asked) {
    return (
      <div className="flex min-h-screen flex-col">
        <Header onHome={home} compact={false} source={source} authSlot={headerActions} />
        <main className="flex flex-1 flex-col items-center justify-center px-4 pb-20">
          <div className="w-full max-w-[680px]">
            <div className="mb-6 text-center">
              <Wordmark />
              <p className="mt-2 text-[14px] text-muted">
                Ask plain-language questions about your ChatGPT ads and get clear answers. Research conversation-shaped
                hints that map to revenue.
              </p>
            </div>
            <SearchBar
              mode={mode}
              onModeChange={setMode}
              onSubmit={ask}
              compact={false}
              suggestions={SUGGESTIONS.slice(0, 4)}
            />
            <div className="mt-8">
              <ConnectionBar health={health} loading={loading} onRetry={connect} compact />
            </div>
            <div className="mx-auto mt-8 grid max-w-[620px] grid-cols-1 gap-2 sm:grid-cols-3">
              {[
                {
                  k: formatMoney(totals.spendMinor, 'INR', true),
                  l: `spend · ${source === 'live' ? 'your account' : 'demo'}`,
                },
                { k: formatRatio(totals.roas), l: source === 'live' ? 'ROAS (needs first-party)' : 'blended ROAS' },
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
      <Header onHome={home} compact source={source} authSlot={headerActions}>
        <div className="flex items-center gap-2">
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
          <ExportMenu query={asked.q} mode={asked.mode} snapshot={snapshot} disabled={asked.mode === 'research'} />
        </div>
      </Header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-4 print:hidden">
            <ConnectionBar health={health} loading={loading} onRetry={connect} compact />
          </div>
          <p className="mb-3 text-[12px] text-muted print:hidden">
            <span className="rounded-full bg-cloud px-2 py-0.5">
              {asked.mode === 'research' ? 'research' : spec?.intent}
            </span>
            {source === 'live' && <span className="ml-2 text-subtle">live account data · cached 5 min</span>}
          </p>
          {asked.mode === 'research' || !spec ? (
            <div className="mb-5">
              <GuidedResearch onNeedSignIn={() => setLoginOpen(true)} />
            </div>
          ) : null}
          {asked.mode === 'research' || !spec ? (
            <Research
              initialSeeds={asked.q}
              compactDataset={dataset}
              onFollowUp={(q, m) => ask(q, m)}
              live={source === 'live' && health?.mode === 'live' && health?.authenticated === true}
              canWrite={health?.details?.auth?.canWrite === true}
              adGroups={dataset.adGroups.map((g) => ({ id: g.id, name: g.name, hints: g.hints }))}
            />
          ) : (
            <Answer
              spec={spec}
              dataset={dataset}
              settings={settings}
              onFollowUp={ask}
              live={source === 'live' && health?.mode === 'live' && health?.authenticated === true}
            />
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
