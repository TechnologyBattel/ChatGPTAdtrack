import { useState } from 'react';
import type { AuthProvider, StoredSession } from '../lib/auth-provider';

interface Props {
  provider: AuthProvider;
  onSignedIn: (session: StoredSession) => void;
  /** Where the user was heading, shown so the redirect is not a surprise. */
  reason?: string;
}

export default function LoginScreen({ provider, onSignedIn, reason }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDev, setShowDev] = useState(provider.kind === 'dev');

  const run = async (fn: () => Promise<StoredSession>) => {
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isFirebase = provider.kind === 'firebase';

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <main className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-[380px]">
          <div className="mb-6 text-center">
            <span className="select-none text-[34px] leading-none tracking-tight">
              <span className="font-normal text-ink">Ad</span>
              <span className="font-medium text-brand">Track</span>
            </span>
            <p className="mt-2 text-[13px] leading-5 text-muted">{reason ?? 'Sign in to see your ad account.'}</p>
          </div>

          {isFirebase && provider.configured() && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => provider.signIn({ email, password }));
              }}
              className="space-y-3"
            >
              <label className="block">
                <span className="mb-1 block text-[12px] text-muted">Email</span>
                <input
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-line px-3 py-2 text-[14px] outline-none focus:border-brand"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] text-muted">Password</span>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-line px-3 py-2 text-[14px] outline-none focus:border-brand"
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-full bg-brand px-4 py-2 text-[14px] font-medium text-white transition hover:bg-[#1765cc] disabled:opacity-50"
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}

          {isFirebase && !provider.configured() && (
            <div className="rounded-xl border border-line bg-cloud px-4 py-3 text-[13px] leading-6 text-muted">
              <p className="font-medium text-ink">Firebase sign-in is not configured.</p>
              <p className="mt-1">{provider.unavailableReason}</p>
              <p className="mt-1">
                The server still requires a token for everything except event tracking. Ask an admin for access, or run
                locally with <code className="font-mono text-[12px]">AUTH_MODE=dev</code>.
              </p>
            </div>
          )}

          {!isFirebase && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => run(() => provider.signIn())}
                disabled={busy || !showDev}
                className="w-full rounded-full bg-brand px-4 py-2 text-[14px] font-medium text-white transition hover:bg-[#1765cc] disabled:opacity-50"
              >
                {busy ? 'Signing in…' : 'Continue in dev mode'}
              </button>
              <p className="text-center text-[12px] leading-5 text-muted">
                Dev mode issues a write-capable token from the local API server. It only exists when{' '}
                <code className="font-mono text-[11px]">AUTH_MODE=dev</code>, which production refuses to start with.
              </p>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-[#f6aea9] bg-[#fce8e6] px-3 py-2 text-[12px] leading-5 text-[#a50e0e]"
            >
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center justify-center gap-3 text-[11px] text-muted">
            <span>
              Token held in {provider.kind === 'dev' ? 'sessionStorage' : 'sessionStorage'} · cleared when the tab
              closes
            </span>
          </div>
          {!isFirebase && (
            <button type="button" onClick={() => setShowDev(true)} className="sr-only">
              enable dev sign-in
            </button>
          )}
        </div>
      </main>
      <footer className="border-t border-line bg-cloud px-4 py-2.5 text-center text-[11px] text-muted">
        No keys in the browser · tokens never stored in localStorage · no cookies used for auth
      </footer>
    </div>
  );
}
