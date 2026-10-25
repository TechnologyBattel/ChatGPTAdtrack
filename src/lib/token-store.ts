// Where the auth token lives.
//
// Choice: sessionStorage, with an in-memory fallback.
//
//   * Not localStorage: an XSS payload can read localStorage and exfiltrate a
//     long-lived credential, and it survives the tab. A token that dies with the
//     tab is worth far less to an attacker.
//   * Not cookies: an httpOnly cookie would be stronger against XSS but it brings
//     CSRF back with it, and this app has no CSRF token machinery. Adding cookies
//     without that is a net security loss, so we do not use cookies at all.
//   * Memory alone would sign the user out on every reload, which is a usability
//     tax that pushes people towards worse workarounds.
//
// So: sessionStorage where available (cleared when the tab closes), memory when
// storage is blocked (private mode, embedded webviews). Never localStorage.

export type StorageKind = 'sessionStorage' | 'memory';

export interface TokenStore {
  kind: StorageKind;
  get(): string | null;
  set(value: string): void;
  clear(): void;
}

export function createTokenStore({
  key = 'adtrack.session.v1',
  storage,
}: { key?: string; storage?: Storage | null } = {}): TokenStore {
  let memory: string | null = null;

  /** Safari in private mode, and some embedded webviews, expose storage but throw on write. */
  function usable(candidate: Storage | null | undefined): candidate is Storage {
    if (!candidate) return false;
    try {
      const probe = `${key}.probe`;
      candidate.setItem(probe, '1');
      candidate.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  function resolveStorage(): Storage | null {
    const candidate = storage !== undefined ? storage : typeof window !== 'undefined' ? window.sessionStorage : null;
    return usable(candidate) ? candidate : null;
  }

  const backing = resolveStorage();

  return {
    kind: backing ? 'sessionStorage' : 'memory',
    get() {
      if (!backing) return memory;
      try {
        // Storage is the durable copy; the memory copy covers a write that storage
        // refused, so fall back to it rather than returning null.
        return backing.getItem(key) ?? memory;
      } catch {
        return memory;
      }
    },
    set(value) {
      memory = value;
      if (!backing) return;
      try {
        backing.setItem(key, value);
      } catch {
        /* blocked: the memory copy still works for this page */
      }
    },
    clear() {
      memory = null;
      if (!backing) return;
      try {
        backing.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}
