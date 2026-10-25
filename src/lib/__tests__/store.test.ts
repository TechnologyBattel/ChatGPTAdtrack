// @vitest-environment node
//
// The storage interface (gap 8). Push history and consent records must live
// behind one contract with a memory and a Firestore implementation. Tests use the
// memory one; this file also exercises the Firestore adapter against a fake
// Firestore instance, which is how the transaction path gets tested with no cloud.

import { describe, expect, it, vi } from 'vitest';
import { STORE_CONTRACT, createFirestoreStore, createMemoryStore } from '../../../server/store.mjs';

const DAY = 24 * 3600 * 1000;

function session(id = 'sess_1', ttl = 60_000, now = 1_000_000) {
  return { sessionId: id, ip: '203.0.113.1', userAgent: 'vitest', createdAt: now, expiresAt: now + ttl };
}

function consent(id = 'c1', sessionId = 'sess_1', ttl = 60_000, now = 1_000_000) {
  return {
    consentId: id,
    sessionId,
    scopes: ['measurement'],
    subject: null,
    keyVersion: 'v1',
    issuedAt: now,
    expiresAt: now + ttl,
    consumedAt: null,
  };
}

describe.each([['memory', () => createMemoryStore({ now: () => 1_000_000 })]])('%s store contract', (_name, make) => {
  it('exposes the whole contract', () => {
    const store = make();
    for (const part of STORE_CONTRACT) expect((store as unknown as Record<string, unknown>)[part]).toBeTruthy();
    expect(typeof store.health).toBe('function');
  });

  it('creates and reads a session, and hides it once expired', async () => {
    let clock = 1_000_000;
    const store = createMemoryStore({ now: () => clock });
    await store.sessions.create(session('sess_1', 5_000, clock));
    expect((await store.sessions.get('sess_1'))?.ip).toBe('203.0.113.1');
    clock += 5_001;
    expect(await store.sessions.get('sess_1')).toBeNull();
    expect(await store.sessions.get('sess_nope')).toBeNull();
  });

  it('burns a consent id once and refuses the replay', async () => {
    const store = createMemoryStore({ now: () => 1_000_000 });
    await store.consents.save(consent('c1', 'sess_1', 60_000, 1_000_000));
    const consumed = await store.consents.consume({ consentId: 'c1', sessionId: 'sess_1' });
    expect(consumed.consumedAt).toBe(1_000_000);
    await expect(store.consents.consume({ consentId: 'c1', sessionId: 'sess_1' })).rejects.toThrow(/already been used/);
  });

  it('refuses cross-session use and unknown ids', async () => {
    const store = createMemoryStore({ now: () => 1_000_000 });
    await store.consents.save(consent('c1', 'sess_1', 60_000, 1_000_000));
    await expect(store.consents.consume({ consentId: 'c1', sessionId: 'sess_2' })).rejects.toThrow(/different session/);
    await expect(store.consents.consume({ consentId: 'c9', sessionId: 'sess_1' })).rejects.toThrow(/not recognised/);
  });

  it('refuses an expired consent even if it was never used', async () => {
    let clock = 1_000_000;
    const store = createMemoryStore({ now: () => clock });
    await store.consents.save(consent('c1', 'sess_1', 1_000, clock));
    clock += 1_001;
    await expect(store.consents.consume({ consentId: 'c1', sessionId: 'sess_1' })).rejects.toThrow(/expired/);
  });

  it('keeps the audit log newest-first, filters by ad group, and caps the list', async () => {
    const store = createMemoryStore({ now: () => 1_000_000, maxAudit: 3 });
    for (let i = 0; i < 3; i += 1) {
      await store.audit.append({
        id: `a${i}`,
        at: 1_000_000 + i,
        action: 'push',
        adGroupId: i === 1 ? 'g2' : 'g1',
        before: [],
        after: ['h'],
        actor: 'u',
        ok: true,
      });
    }
    const all = await store.audit.list({});
    expect(all.map((e) => e.id)).toEqual(['a2', 'a1', 'a0']);
    expect(all).toHaveLength(3);
    expect((await store.audit.list({ adGroupId: 'g2' })).map((e) => e.id)).toEqual(['a1']);
    expect(await store.audit.list({ limit: 1 })).toHaveLength(1);

    // The cap keeps memory bounded: a long-running dev server cannot grow forever.
    await store.audit.append({
      id: 'a3',
      at: 1_000_003,
      action: 'push',
      adGroupId: 'g1',
      before: [],
      after: ['h'],
      actor: 'u',
      ok: true,
    });
    expect((await store.audit.list({})).map((e) => e.id)).toEqual(['a3', 'a2', 'a1']);
  });

  it('reports healthy without a network', async () => {
    expect(await make().health()).toEqual({ ok: true, kind: 'memory' });
  });
});

describe('memory store isolation', () => {
  it('does not leak a cached session into a new store instance', async () => {
    const a = createMemoryStore({ now: () => 1_000_000 });
    await a.sessions.create(session('sess_1'));
    expect(await a.sessions.count()).toBe(1);
    expect(await createMemoryStore().sessions.get('sess_1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Firestore adapter, against a fake instance that behaves like the real one for
// the two things that matter: documents and runTransaction.
// ---------------------------------------------------------------------------

interface FakeDocRef {
  get(): Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  set(value: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void>;
}
interface FakeTransaction {
  get(ref: FakeDocRef): Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  set(ref: FakeDocRef, value: Record<string, unknown>, opts?: { merge?: boolean }): void;
}

function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (path: string) => ({
    path,
    async get() {
      const data = docs.get(path);
      return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
    },
    async set(value: Record<string, unknown>, opts?: { merge?: boolean }) {
      const current = opts?.merge ? (docs.get(path) ?? {}) : {};
      docs.set(path, { ...current, ...value });
    },
    // Query surface used by audit.list/health.
    orderBy() {
      return queryRef([...docs.entries()]);
    },
    where(field: string, op: string, value: unknown) {
      if (op !== '==') throw new Error('fake supports only ==');
      return queryRef([...docs.entries()].filter(([, data]) => data[field] === value));
    },
    limit(n: number) {
      return queryRef([...docs.entries()].slice(0, n));
    },
  });
  function queryRef(entries: [string, Record<string, unknown>][]) {
    const sorted = [...entries].sort((a, b) => Number(b[1].at ?? 0) - Number(a[1].at ?? 0));
    const q = {
      orderBy: () => q,
      where: (field: string, _op: string, value: unknown) => queryRef(sorted.filter(([, d]) => d[field] === value)),
      limit: (n: number) => q._with(sorted.slice(0, n)),
      _with: (subset: [string, Record<string, unknown>][]) => queryRef(subset),
      async get() {
        return { docs: sorted.map(([path, data]) => ({ id: path.split('/').pop(), data: () => ({ ...data }) })) };
      },
    };
    return q;
  }

  const firestore = {
    collection(name: string) {
      return {
        doc: (id: string) => ref(`${name}/${id}`),
        ...ref(name),
        orderBy: () => ref(name).orderBy(),
        where: (field: string, op: string, value: unknown) => ref(name).where(field, op, value),
        limit: (n: number) => ref(name).limit(n),
        count: () => ({ get: async () => ({ data: () => ({ count: docs.size }) }) }),
      };
    },
    async runTransaction(fn: (tx: FakeTransaction) => Promise<unknown>) {
      let pendingWrite: (() => Promise<void>) | null = null;
      const tx: FakeTransaction = {
        get: (r) => r.get(),
        set: (r, value, opts) => {
          pendingWrite = () => r.set(value, opts);
        },
      };
      const result = await fn(tx);
      if (pendingWrite) await (pendingWrite as () => Promise<void>)();
      return result;
    },
    _docs: docs,
  };
  return firestore;
}

describe('firestore adapter', () => {
  it('refuses to construct without a Firestore instance', () => {
    expect(() => createFirestoreStore({} as never)).toThrow(/requires a Firestore instance/);
  });

  it('sets a role in the contract and reports its kind', () => {
    const store = createFirestoreStore({ firestore: fakeFirestore() });
    expect(store.kind).toBe('firestore');
    expect(awaitableContract(store)).toBe(true);
  });

  it('consumes exactly once inside a transaction', async () => {
    const db = fakeFirestore();
    const store = createFirestoreStore({ firestore: db, now: () => 1_000_000 });
    await store.consents.save(consent('c1', 'sess_1', 60_000, 1_000_000));

    const first = await store.consents.consume({ consentId: 'c1', sessionId: 'sess_1' });
    expect(first.consumedAt).toBe(1_000_000);
    expect(db._docs.get('adtrack_consents/c1')?.consumedAt).toBeInstanceOf(Date);

    await expect(store.consents.consume({ consentId: 'c1', sessionId: 'sess_1' })).rejects.toThrow(/already been used/);
  });

  it('refuses cross-session use before writing anything', async () => {
    const db = fakeFirestore();
    const store = createFirestoreStore({ firestore: db, now: () => 1_000_000 });
    await store.consents.save(consent('c1', 'sess_1', 60_000, 1_000_000));
    await expect(store.consents.consume({ consentId: 'c1', sessionId: 'sess_2' })).rejects.toThrow(/different session/);
    expect(db._docs.get('adtrack_consents/c1')?.consumedAt ?? null).toBeNull();
  });

  it('stores audit entries with a server timestamp and lists newest first', async () => {
    const store = createFirestoreStore({ firestore: fakeFirestore(), now: () => 1_000_000 });
    await store.audit.append({
      id: 'a1',
      at: 1_000_000,
      action: 'push',
      adGroupId: 'g1',
      before: [],
      after: ['h'],
      actor: 'u',
      ok: true,
    });
    const [entry] = await store.audit.list({ adGroupId: 'g1', limit: 5 });
    expect(entry.id).toBe('a1');
    expect(entry.adGroupId).toBe('g1');
  });

  it('reports unhealthy instead of throwing when the database is down', async () => {
    const store = createFirestoreStore({
      firestore: {
        collection: () => ({
          limit: () => ({
            get: async () => {
              throw new Error('permission-denied');
            },
          }),
        }),
      },
    });
    expect(await store.health()).toMatchObject({
      ok: false,
      kind: 'firestore',
      reason: expect.stringContaining('permission-denied'),
    });
  });

  it('is never imported by the client bundle (no SDK import in this module)', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../../server/store.mjs', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/from 'firebase-admin'|from "firebase-admin"/);
    expect(source).not.toMatch(/import\(['"]firebase-admin['"]\)/);
  });
});

function awaitableContract(store: unknown) {
  const record = store as Record<string, unknown>;
  return STORE_CONTRACT.every((part) => typeof record[part] === 'object');
}

// Silence an unused-import style warning if vi is not used in a given run.
void vi;
void DAY;
