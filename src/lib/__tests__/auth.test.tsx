// @vitest-environment jsdom
//
// Token storage (gap 5), the auth providers behind one interface, and the login
// screen (gap 9). The screen is an overlay on the single page, so these tests also
// assert that signing in never changes the URL.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTokenStore } from '../token-store';
import { createDevProvider, createFirebaseRestProvider } from '../auth-provider';
import LoginScreen from '../../components/LoginScreen';
import App from '../../App';
import { productionHeaders, contentSecurityPolicy } from '../../../server/csp.mjs';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('token storage (gap 5)', () => {
  it('uses sessionStorage when it works, never localStorage', () => {
    const session = memoryStorage();
    const local = memoryStorage();
    const localSpy = vi.spyOn(window, 'localStorage', 'get').mockReturnValue(local);

    const store = createTokenStore({ storage: session });
    store.set('tok');
    expect(store.kind).toBe('sessionStorage');
    expect(session.getItem('adtrack.session.v1')).toBe('tok');
    expect(local.getItem('adtrack.session.v1')).toBeNull();
    expect(localSpy).toBeDefined();

    store.clear();
    expect(session.getItem('adtrack.session.v1')).toBeNull();
  });

  it('falls back to memory when storage is blocked and still works for the page', () => {
    const blocked = {
      get length() {
        return 0;
      },
      clear: () => {},
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    } as unknown as Storage;

    const store = createTokenStore({ storage: blocked });
    expect(store.kind).toBe('memory');
    store.set('tok');
    expect(store.get()).toBe('tok');
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('keeps a memory copy even when a later write fails', () => {
    const flaky = memoryStorage();
    let fail = false;
    flaky.setItem = (k: string, v: string) => {
      if (fail) throw new Error('quota');
      memoryStorage().setItem(k, v);
    };
    const store = createTokenStore({ storage: flaky });
    store.set('first');
    fail = true;
    store.set('second');
    expect(store.get()).toBe('second'); // memory copy survives a storage failure
  });
});

describe('dev provider', () => {
  it('exchanges POST /api/dev/session for a token and stores the session', async () => {
    const store = createTokenStore({ storage: memoryStorage() });
    const fetchImpl = vi.fn(async () => jsonResponse({ token: 'dev-abc', role: 'owner' }));
    const provider = createDevProvider({ fetchImpl: fetchImpl as unknown as typeof fetch, store });

    const session = await provider.signIn();
    expect(session).toMatchObject({ kind: 'dev', token: 'dev-abc', role: 'owner' });
    expect(provider.currentToken()).toBe('dev-abc');
    expect(await provider.restore()).toMatchObject({ token: 'dev-abc' });

    provider.signOut();
    expect(provider.currentToken()).toBeNull();
    expect(await provider.restore()).toBeNull();
  });

  it('surfaces the server refusal verbatim instead of pretending to sign in', async () => {
    const provider = createDevProvider({
      fetchImpl: (async () =>
        jsonResponse(
          { error: { code: 'not_found', message: 'No route for POST /api/dev/session' } },
          404,
        )) as unknown as typeof fetch,
      store: createTokenStore({ storage: memoryStorage() }),
    });
    await expect(provider.signIn()).rejects.toThrow('No route for POST /api/dev/session');
  });
});

describe('firebase provider', () => {
  const store = () => createTokenStore({ storage: memoryStorage() });

  it('reports itself unconfigured without an API key, and refuses to sign in', async () => {
    const provider = createFirebaseRestProvider({ store: store() });
    expect(provider.configured()).toBe(false);
    expect(provider.unavailableReason).toMatch(/VITE_FIREBASE_API_KEY/);
    await expect(provider.signIn({ email: 'a@b.c', password: 'x' })).rejects.toThrow(/not configured/);
  });

  it('exchanges email and password for an id token', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ idToken: 'id-1', localId: 'uid-1', refreshToken: 'r-1', expiresIn: '3600' }),
    );
    const provider = createFirebaseRestProvider({
      apiKey: 'public-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      store: store(),
    });

    const session = await provider.signIn({ email: 'ops@example.test', password: 'pw' });
    expect(session).toMatchObject({ kind: 'firebase', token: 'id-1', uid: 'uid-1', email: 'ops@example.test' });
    expect(session.expiresAt).toBeGreaterThan(Date.now());

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/accounts:signInWithPassword');
    expect(url).toContain('key=public-key');
    expect(JSON.parse(String(init.body))).toMatchObject({ email: 'ops@example.test', returnSecureToken: true });
  });

  it('reports a rejected password in words a person can act on', async () => {
    const provider = createFirebaseRestProvider({
      apiKey: 'k',
      fetchImpl: (async () =>
        jsonResponse({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }, 400)) as unknown as typeof fetch,
      store: store(),
    });
    await expect(provider.signIn({ email: 'a@b.c', password: 'nope' })).rejects.toThrow(
      'Email or password is incorrect.',
    );
  });

  it('refreshes an expired token with the refresh token', async () => {
    const s = store();
    s.set(
      JSON.stringify({
        kind: 'firebase',
        token: 'old',
        refreshToken: 'r-1',
        expiresAt: Date.now() - 1000,
        email: 'ops@example.test',
      }),
    );
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id_token: 'new', user_id: 'uid-1', refresh_token: 'r-2', expires_in: '3600' }),
    );
    const provider = createFirebaseRestProvider({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      store: s,
    });

    const restored = await provider.restore();
    expect(restored?.token).toBe('new');
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain('/token?key=k');
  });

  it('drops a session it cannot refresh rather than sending a dead token', async () => {
    const s = store();
    s.set(JSON.stringify({ kind: 'firebase', token: 'old', expiresAt: Date.now() - 1000 }));
    const provider = createFirebaseRestProvider({ apiKey: 'k', store: s });
    expect(await provider.restore()).toBeNull();
    expect(provider.currentToken()).toBeNull();
  });

  it('clears corrupt storage instead of throwing', async () => {
    const s = store();
    s.set('{not json');
    const provider = createFirebaseRestProvider({ apiKey: 'k', store: s });
    expect(await provider.restore()).toBeNull();
    expect(s.get()).toBeNull();
  });
});

describe('login screen (gap 9)', () => {
  const firebase = (fetchImpl: unknown) =>
    createFirebaseRestProvider({
      apiKey: 'k',
      fetchImpl: fetchImpl as typeof fetch,
      store: createTokenStore({ storage: memoryStorage() }),
    });

  it('signs in and hands the session back without changing the URL', async () => {
    const provider = firebase(async () =>
      jsonResponse({ idToken: 'id-1', localId: 'u', refreshToken: 'r', expiresIn: '3600' }),
    );
    const onSignedIn = vi.fn();
    render(<LoginScreen provider={provider} onSignedIn={onSignedIn} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ops@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(onSignedIn.mock.calls[0][0]).toMatchObject({ token: 'id-1' });
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
  });

  it('shows the failure inline, verbatim, and stays on the same screen', async () => {
    const provider = firebase(async () => jsonResponse({ error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER' } }, 429));
    render(<LoginScreen provider={provider} onSignedIn={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ops@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Too many attempts');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('explains an unconfigured build instead of showing a dead form', () => {
    render(<LoginScreen provider={createFirebaseRestProvider({})} onSignedIn={vi.fn()} />);
    expect(screen.getByText(/Firebase sign-in is not configured/i)).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.getByText(/VITE_FIREBASE_API_KEY/)).toBeTruthy();
  });

  it('offers the dev button only when the provider is the dev one', async () => {
    const onSignedIn = vi.fn();
    render(
      <LoginScreen
        provider={createDevProvider({
          fetchImpl: (async () => jsonResponse({ token: 'dev-abc', role: 'owner' })) as unknown as typeof fetch,
          store: createTokenStore({ storage: memoryStorage() }),
        })}
        onSignedIn={onSignedIn}
      />,
    );
    expect(screen.queryByText(/Continue in dev mode/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue in dev mode' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });
});

describe('login gate stays on one page (gap 9)', () => {
  it('offers the overlay after a 401 on an action, without changing the URL', async () => {
    // A signed-out build: every API call answers 401. The health probe alone must not
    // replace the page (demo data has to stay usable); an action's 401 opens the gate.
    window.history.replaceState(null, '', '/?q=How%20much%20did%20I%20spend%3F&m=track');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { error: { code: 'unauthenticated', message: 'Authorization: Bearer <token> is required.' } },
          401,
        ),
      ),
    );

    render(<App />);
    expect(screen.getByRole('searchbox')).toBeTruthy();

    // A real API call, exactly as a component would make it.
    const { getDataset } = await import('../api');
    await expect(getDataset(30)).rejects.toThrow(/Bearer/);

    expect(await screen.findByText(/Continue in dev mode/)).toBeTruthy();
    // An overlay, not a route: the question is still in the address.
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toContain('q=How');
    vi.unstubAllGlobals();
  });

  it('opens the same overlay from the header control', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'unauthenticated', message: 'no' } }, 401)),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Continue in dev mode/)).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe('content security policy (gap 5)', () => {
  it('forbids inline script in production', () => {
    const scriptSrc = productionHeaders['Content-Security-Policy']
      .split(';')
      .find((part) => part.trim().startsWith('script-src'));
    expect(scriptSrc).toBe(" script-src 'self'");
    expect(productionHeaders['Content-Security-Policy']).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(productionHeaders['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(productionHeaders['X-Content-Type-Options']).toBe('nosniff');
  });

  it('permits the Firebase auth hosts in connect-src, and nothing else external', () => {
    const policy = productionHeaders['Content-Security-Policy'];
    const connect = policy.split(';').find((part) => part.trim().startsWith('connect-src')) ?? '';
    expect(connect).toContain('identitytoolkit.googleapis.com');
    expect(connect).toContain('securetoken.googleapis.com');
    expect(connect).not.toContain('*');
  });

  it('relaxes only in dev, and only for the inline preamble and HMR', () => {
    const dev = contentSecurityPolicy({ dev: true })['Content-Security-Policy'];
    expect(dev).toContain("script-src 'self' 'unsafe-inline'");
    expect(dev).toContain('ws:');
  });

  it('ships an HTML shell with no inline script to violate the policy', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    // jsdom has no file: URL base, so resolve from the repo root instead.
    const html = await fs.readFile(path.resolve(process.cwd(), 'index.html'), 'utf8');
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
    expect(inlineScripts).toHaveLength(0);
    expect(html).toContain('type="module" src="/src/main.tsx"');
  });
});
