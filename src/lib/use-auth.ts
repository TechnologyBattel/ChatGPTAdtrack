import { useCallback, useEffect, useMemo, useState } from 'react';
import { setTokenReader } from './api';
import { selectProvider, type AuthProvider, type StoredSession } from './auth-provider';

export const AUTH_REQUIRED_EVENT = 'adtrack:auth-required';

export type AuthState = {
  provider: AuthProvider;
  session: StoredSession | null;
  ready: boolean;
  signIn: (credentials?: { email?: string; password?: string }) => Promise<StoredSession>;
  signOut: () => void;
};

/**
 * One auth state for the page. The provider owns storage; the API client only
 * asks for the current token, so a request never captures a stale credential.
 *
 * In dev mode the page tries the local dev session silently on load, so a local
 * checkout is usable without a login step. That route does not exist in
 * production, the attempt fails quietly, and the login screen is what the user
 * sees when something needs a token.
 */
export function useAuth(): AuthState {
  const provider = useMemo(
    () => selectProvider({ VITE_FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined }),
    [],
  );
  const [session, setSession] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setTokenReader(() => provider.currentToken());
    return () => setTokenReader(null);
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const restored = await provider.restore();
        if (restored) {
          if (!cancelled) setSession(restored);
          return;
        }
        if (provider.kind === 'dev') {
          try {
            const dev = await provider.signIn();
            if (!cancelled) setSession(dev);
          } catch {
            /* no dev route here: stay signed out */
          }
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const signIn = useCallback(
    async (credentials?: { email?: string; password?: string }) => {
      const next = await provider.signIn(credentials);
      setSession(next);
      return next;
    },
    [provider],
  );

  const signOut = useCallback(() => {
    provider.signOut();
    setSession(null);
  }, [provider]);

  return { provider, session, ready, signIn, signOut };
}
