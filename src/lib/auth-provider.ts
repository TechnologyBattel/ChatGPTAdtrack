// Auth providers behind one interface, so the login screen does not care whether
// the token came from the dev stub or from Firebase.
//
// Firebase Auth is called over its public REST API rather than through the
// `firebase` JS SDK. Reasons: the SDK adds ~150 KB to the bundle for one screen,
// it is awkward to test without a network, and the two calls we need
// (signInWithPassword, token refresh) are documented and stable. The API key used
// here is the public Web API key, which is designed to ship in a browser — it is
// not a secret, and it grants nothing without a password.

import { createTokenStore, type TokenStore } from './token-store';

export type AuthKind = 'dev' | 'firebase';

export interface AuthUser {
  kind: AuthKind;
  uid?: string;
  email?: string;
  role?: string;
}

export interface StoredSession extends AuthUser {
  token: string;
  /** Epoch ms. Firebase id tokens last an hour; dev tokens do not expire. */
  expiresAt?: number;
  refreshToken?: string;
}

export interface AuthProvider {
  kind: AuthKind;
  label: string;
  /** False when the provider cannot work here (no API key, route missing). */
  configured: () => boolean;
  /** Human-facing explanation of why it is not configured. */
  unavailableReason?: string;
  signIn: (credentials?: { email?: string; password?: string }) => Promise<StoredSession>;
  restore: () => Promise<StoredSession | null>;
  signOut: () => void;
  currentToken: () => string | null;
}

const DEV_ENDPOINT = '/api/dev/session';
const IDENTITY_BASE = 'https://identitytoolkit.googleapis.com/v1';
const TOKEN_BASE = 'https://securetoken.googleapis.com/v1';

function decodeJwtExpiry(token: string): number | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Firebase returns e.g. INVALID_LOGIN_CREDENTIALS; keep the code, soften the text. */
function friendlyFirebaseError(code: string): string {
  const map: Record<string, string> = {
    INVALID_LOGIN_CREDENTIALS: 'Email or password is incorrect.',
    EMAIL_NOT_FOUND: 'Email or password is incorrect.',
    INVALID_PASSWORD: 'Email or password is incorrect.',
    USER_DISABLED: 'This account is disabled.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again in a few minutes.',
    OPERATION_NOT_ALLOWED: 'Email/password sign-in is not enabled for this Firebase project.',
  };
  return map[code] ?? `Sign-in failed (${code}).`;
}

export function createDevProvider({
  fetchImpl,
  store = createTokenStore(),
}: { fetchImpl?: typeof fetch; store?: TokenStore } = {}): AuthProvider {
  const doFetch = fetchImpl ?? fetch;

  return {
    kind: 'dev',
    label: 'Continue in dev mode',
    configured: () => true,
    async signIn() {
      const res = await doFetch(DEV_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = body?.error?.message ?? `Dev sign-in is not available on this server (${res.status}).`;
        throw new Error(message);
      }
      const session: StoredSession = { kind: 'dev', token: body.token, role: body.role, uid: 'dev-user' };
      store.set(JSON.stringify(session));
      return session;
    },
    async restore() {
      const raw = store.get();
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as StoredSession;
        return parsed.kind === 'dev' ? parsed : null;
      } catch {
        store.clear();
        return null;
      }
    },
    signOut() {
      store.clear();
    },
    currentToken() {
      const raw = store.get();
      if (!raw) return null;
      try {
        return (JSON.parse(raw) as StoredSession).token ?? null;
      } catch {
        return null;
      }
    },
  };
}

export function createFirebaseRestProvider({
  apiKey,
  fetchImpl,
  store = createTokenStore(),
  identityBase = IDENTITY_BASE,
  tokenBase = TOKEN_BASE,
}: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  store?: TokenStore;
  identityBase?: string;
  tokenBase?: string;
}): AuthProvider {
  const doFetch = fetchImpl ?? fetch;

  async function exchange(endpoint: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = json?.error?.message ?? `HTTP_${res.status}`;
      throw new Error(friendlyFirebaseError(String(code).split(' : ')[0]));
    }
    return json as Record<string, unknown>;
  }

  function persist(json: Record<string, unknown>, email?: string): StoredSession {
    const token = String(json.idToken ?? json.id_token);
    const expiresIn = Number(json.expiresIn ?? json.expires_in ?? 3600);
    const session: StoredSession = {
      kind: 'firebase',
      token,
      uid: String(json.localId ?? json.user_id ?? ''),
      email: email ?? (json.email ? String(json.email) : undefined),
      refreshToken: String(json.refreshToken ?? json.refresh_token ?? ''),
      expiresAt: Date.now() + expiresIn * 1000 - 30_000,
    };
    store.set(JSON.stringify(session));
    return session;
  }

  const provider: AuthProvider = {
    kind: 'firebase',
    label: 'Sign in with email',
    configured: () => Boolean(apiKey),
    unavailableReason: 'Set VITE_FIREBASE_API_KEY to enable Firebase sign-in.',
    async signIn(credentials) {
      const email = credentials?.email?.trim();
      const password = credentials?.password;
      if (!apiKey) throw new Error('Firebase is not configured on this build.');
      if (!email || !password) throw new Error('Email and password are required.');
      const json = await exchange(`${identityBase}/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
        email,
        password,
        returnSecureToken: true,
      });
      return persist(json, email);
    },
    async restore() {
      const raw = store.get();
      if (!raw) return null;
      let parsed: StoredSession;
      try {
        parsed = JSON.parse(raw) as StoredSession;
      } catch {
        store.clear();
        return null;
      }
      if (parsed.kind !== 'firebase') return null;
      if (!parsed.expiresAt || parsed.expiresAt > Date.now()) return parsed;
      if (!parsed.refreshToken || !apiKey) {
        store.clear();
        return null;
      }
      try {
        const json = await exchange(`${tokenBase}/token?key=${encodeURIComponent(apiKey)}`, {
          grant_type: 'refresh_token',
          refresh_token: parsed.refreshToken,
        });
        return persist(json, parsed.email);
      } catch {
        store.clear();
        return null;
      }
    },
    signOut() {
      store.clear();
    },
    currentToken() {
      const raw = store.get();
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as StoredSession;
        if (parsed.expiresAt && parsed.expiresAt <= Date.now()) return null;
        return parsed.token ?? null;
      } catch {
        return null;
      }
    },
  };

  // Keep the decoded expiry honest if the server did not send expiresIn.
  const originalSignIn = provider.signIn;
  provider.signIn = async (credentials) => {
    const session = await originalSignIn(credentials);
    if (!session.expiresAt) session.expiresAt = decodeJwtExpiry(session.token);
    return session;
  };

  return provider;
}

/** The provider the app should use, given what this build was configured with. */
export function selectProvider(env: { VITE_FIREBASE_API_KEY?: string } = {}): AuthProvider {
  const apiKey = env.VITE_FIREBASE_API_KEY;
  if (apiKey) return createFirebaseRestProvider({ apiKey });
  return createDevProvider();
}

export { decodeJwtExpiry };
