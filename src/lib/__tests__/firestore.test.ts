// @vitest-environment node
//
// Firestore deployment artefacts: the rules, the indexes the store's queries need,
// and (when an emulator is actually available) the adapter against real Firestore.
//
// The index list is not documentation — it is a contract. Each assertion below names
// the query in server/store.mjs that fails with FAILED_PRECONDITION without it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (name: string) => readFileSync(`${root}/${name}`, 'utf8');

type Index = {
  collectionGroup: string;
  queryScope: string;
  fields: { fieldPath: string; order?: string }[];
};

function indexes(): Index[] {
  return JSON.parse(read('firestore.indexes.json')).indexes;
}

/** True when some declared index covers exactly these fields, in this order. */
function hasIndex(collectionGroup: string, fields: { fieldPath: string; order?: string }[]) {
  return indexes().some(
    (index) =>
      index.collectionGroup === collectionGroup &&
      index.fields.length === fields.length &&
      index.fields.every(
        (field, i) =>
          field.fieldPath === fields[i].fieldPath && (field.order ?? 'ASCENDING') === (fields[i].order ?? 'ASCENDING'),
      ),
  );
}

describe('firestore.rules', () => {
  it('denies every client read and write', () => {
    const rules = read('firestore.rules');
    expect(rules).toContain("rules_version = '2'");
    expect(rules).toMatch(/match \/\{document=\*\*\}/);
    expect(rules).toMatch(/allow read, write: if false;/);
    // Nothing may be allowed anywhere: one stray `if true` would expose the store.
    expect(rules).not.toMatch(/allow [a-z, ]+: if true/);
  });
});

describe('firestore.indexes.json', () => {
  it('is valid JSON naming only adtrack collections', () => {
    const parsed = JSON.parse(read('firestore.indexes.json'));
    expect(Array.isArray(parsed.indexes)).toBe(true);
    for (const index of parsed.indexes as Index[]) {
      expect(index.collectionGroup.startsWith('adtrack_')).toBe(true);
      expect(index.queryScope).toBe('COLLECTION');
    }
  });

  it('covers audit: where adGroupId == + orderBy at desc', () => {
    expect(
      hasIndex('adtrack_audit', [
        { fieldPath: 'adGroupId', order: 'ASCENDING' },
        { fieldPath: 'at', order: 'DESCENDING' },
      ]),
    ).toBe(true);
  });

  it('covers audit: where ok == + orderBy at desc (the ?ok=false filter)', () => {
    expect(
      hasIndex('adtrack_audit', [
        { fieldPath: 'ok', order: 'ASCENDING' },
        { fieldPath: 'at', order: 'DESCENDING' },
      ]),
    ).toBe(true);
  });

  it('covers outbox.due(): status == pending + nextAttemptAt <= now', () => {
    expect(
      hasIndex('adtrack_outbox', [
        { fieldPath: 'status', order: 'ASCENDING' },
        { fieldPath: 'nextAttemptAt', order: 'ASCENDING' },
      ]),
    ).toBe(true);
  });

  it('covers outbox.list({ status }): status == + orderBy createdAt desc', () => {
    expect(
      hasIndex('adtrack_outbox', [
        { fieldPath: 'status', order: 'ASCENDING' },
        { fieldPath: 'createdAt', order: 'DESCENDING' },
      ]),
    ).toBe(true);
  });

  it('declares no index the store does not query', () => {
    // Three queries in server/store.mjs need a composite index; a fourth entry would
    // be an index nobody uses, paid for on every write.
    expect(indexes()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Emulator. Runs only where one is actually reachable: `firebase emulators:exec`
// sets FIRESTORE_EMULATOR_HOST, and firebase-admin must be installed (it is an
// optional dependency). Without both, these tests skip rather than pretend.
// ---------------------------------------------------------------------------

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? 'demo-adtrack';

async function loadAdmin() {
  try {
    return await import('firebase-admin');
  } catch {
    return null;
  }
}
const admin = await loadAdmin();
const canRun = Boolean(emulatorHost && admin);
const reason = !emulatorHost
  ? 'FIRESTORE_EMULATOR_HOST is not set'
  : !admin
    ? 'firebase-admin is not installed (optional dependency)'
    : '';

describe.skipIf(!canRun)(`firestore adapter against the emulator (${reason || emulatorHost})`, () => {
  it('claims and consumes a consent exactly once', async () => {
    const { createFirestoreStore } = await import('../../../server/store.mjs');
    const { initializeApp, getApps } = admin as unknown as {
      initializeApp: (o: object, name?: string) => unknown;
      getApps: () => unknown[];
    };
    if (getApps().length === 0) initializeApp({ projectId });
    const { getFirestore } = await import('firebase-admin/firestore');
    const store = createFirestoreStore({ firestore: getFirestore() as never, prefix: `t${Date.now()}` });

    const session = await store.sessions.create({
      sessionId: 'sess_emu',
      ip: '1.1.1.1',
      userAgent: 'emulator',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    expect(session.sessionId).toBe('sess_emu');

    await store.consents.save({
      consentId: 'c_emu',
      sessionId: 'sess_emu',
      scopes: ['measurement'],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      consumedAt: null,
    });
    const claimed = await store.consents.claim({ consentId: 'c_emu', sessionId: 'sess_emu' });
    expect(claimed.pendingAt).toBeTruthy();
    const consumed = await store.consents.consume({ consentId: 'c_emu', sessionId: 'sess_emu' });
    expect(consumed.consumedAt).toBeTruthy();
    await expect(store.consents.consume({ consentId: 'c_emu', sessionId: 'sess_emu' })).rejects.toThrow(
      /already been used/,
    );
  });

  it('lists audit entries newest first, filtered by ad group and outcome', async () => {
    const { createFirestoreStore } = await import('../../../server/store.mjs');
    const { getFirestore } = await import('firebase-admin/firestore');
    const store = createFirestoreStore({ firestore: getFirestore() as never, prefix: `t${Date.now()}` });
    await store.audit.append({ id: 'a1', at: 1, action: 'push', adGroupId: 'g1', ok: true, actor: 'u' });
    await store.audit.append({
      id: 'a2',
      at: 2,
      action: 'push',
      adGroupId: 'g1',
      ok: false,
      error: 'nope',
      actor: 'u',
    });

    const all = await store.audit.list({ adGroupId: 'g1' });
    expect(all.map((e) => e.id)).toEqual(['a2', 'a1']);
    const failures = await store.audit.list({ adGroupId: 'g1', ok: false });
    expect(failures.map((e) => e.id)).toEqual(['a2']);
  });
});
