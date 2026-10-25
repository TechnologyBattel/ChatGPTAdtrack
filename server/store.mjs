// Storage interface for everything that must outlive a single request:
//   sessions          — short-lived tracking sessions consent ids are bound to
//   consents          — the grant record, so replay and cross-session use can be refused
//   audit             — push/undo history (previously browser-only localStorage)
//
// Two implementations, one contract:
//   createMemoryStore()                 — tests, local dev
//   createFirestoreStore({ firestore }) — production; needs the Admin SDK
//
// The contract is async everywhere so swapping implementations cannot change
// call sites. Errors use ApiError with stable codes.

import { ApiError } from './errors.mjs';

export const STORE_CONTRACT = ['sessions', 'consents', 'audit'];

function assertContract(store, kind) {
  for (const part of STORE_CONTRACT) {
    if (!store[part]) throw new Error(`${kind} store is missing "${part}".`);
  }
  return store;
}

function expired(at, now) {
  return typeof at === 'number' ? at <= now : new Date(at).getTime() <= now;
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

export function createMemoryStore({ now = () => Date.now(), maxAudit = 500 } = {}) {
  const sessions = new Map();
  const consents = new Map();
  const audit = [];

  function sweep() {
    const ts = now();
    for (const [id, session] of sessions) if (expired(session.expiresAt, ts)) sessions.delete(id);
    for (const [id, consent] of consents) {
      if (expired(consent.expiresAt, ts) && expired(consent.issuedAt + 24 * 3600 * 1000, ts)) consents.delete(id);
    }
  }

  const store = {
    kind: 'memory',

    sessions: {
      async create(session) {
        sweep();
        sessions.set(session.sessionId, { ...session });
        return { ...session };
      },
      async get(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return null;
        if (expired(session.expiresAt, now())) {
          sessions.delete(sessionId);
          return null;
        }
        return { ...session };
      },
      async count() {
        sweep();
        return sessions.size;
      },
    },

    consents: {
      async save(record) {
        consents.set(record.consentId, { ...record });
        return { ...record };
      },
      async get(consentId) {
        const record = consents.get(consentId);
        return record ? { ...record } : null;
      },
      /**
       * Single use: the first consumer wins. A second attempt with the same id is
       * a replay, and an attempt from a different session is cross-session use.
       */
      async consume({ consentId, sessionId }) {
        const record = consents.get(consentId);
        if (!record) throw new ApiError(403, 'consent_unknown', 'Consent id is not recognised by this server.');
        if (record.sessionId !== sessionId) {
          throw new ApiError(403, 'consent_session_mismatch', 'Consent id belongs to a different session.');
        }
        if (record.consumedAt) throw new ApiError(403, 'consent_replayed', 'Consent id has already been used.');
        if (expired(record.expiresAt, now()))
          throw new ApiError(403, 'consent_expired', 'Consent has expired; ask the visitor again.');
        record.consumedAt = now();
        consents.set(consentId, record);
        return { ...record };
      },
    },

    audit: {
      async append(entry) {
        audit.unshift({ ...entry });
        if (audit.length > maxAudit) audit.length = maxAudit;
        return { ...entry };
      },
      async list({ adGroupId, limit = 50 } = {}) {
        const filtered = adGroupId ? audit.filter((e) => e.adGroupId === adGroupId) : audit;
        return filtered.slice(0, limit).map((e) => ({ ...e }));
      },
    },

    async health() {
      return { ok: true, kind: 'memory' };
    },
  };

  return assertContract(store, 'memory');
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------

/**
 * Adapts a Firestore instance to the contract above. `firestore` is injected so
 * this file never imports the Admin SDK: the SDK is an optional dependency and is
 * only loaded when AUTH_MODE=firebase.
 */
export function createFirestoreStore({ firestore, prefix = 'adtrack', now = () => Date.now() } = {}) {
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new Error('createFirestoreStore requires a Firestore instance.');
  }

  const col = (name) => firestore.collection(`${prefix}_${name}`);
  const toMillis = (value) => (typeof value === 'number' ? value : new Date(value).getTime());

  const store = {
    kind: 'firestore',

    sessions: {
      async create(session) {
        await col('sessions')
          .doc(session.sessionId)
          .set({
            ...session,
            expiresAt: new Date(session.expiresAt),
            createdAt: new Date(session.createdAt ?? now()),
          });
        return { ...session };
      },
      async get(sessionId) {
        const snap = await col('sessions').doc(sessionId).get();
        if (!snap.exists) return null;
        const data = snap.data();
        if (toMillis(data.expiresAt) <= now()) return null;
        return { ...data, expiresAt: toMillis(data.expiresAt) };
      },
      async count() {
        const snap = await col('sessions').count?.().get?.();
        return snap?.data?.().count ?? 0;
      },
    },

    consents: {
      async save(record) {
        await col('consents')
          .doc(record.consentId)
          .set({
            ...record,
            issuedAt: new Date(record.issuedAt),
            expiresAt: new Date(record.expiresAt),
            consumedAt: null,
          });
        return { ...record };
      },
      async get(consentId) {
        const snap = await col('consents').doc(consentId).get();
        return snap.exists ? snap.data() : null;
      },
      /** Compare-and-set inside a transaction, so two concurrent replays cannot both win. */
      async consume({ consentId, sessionId }) {
        const ref = col('consents').doc(consentId);
        return firestore.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) {
            throw new ApiError(403, 'consent_unknown', 'Consent id is not recognised by this server.');
          }
          const record = snap.data();
          if (record.sessionId !== sessionId) {
            throw new ApiError(403, 'consent_session_mismatch', 'Consent id belongs to a different session.');
          }
          if (record.consumedAt) {
            throw new ApiError(403, 'consent_replayed', 'Consent id has already been used.');
          }
          if (toMillis(record.expiresAt) <= now()) {
            throw new ApiError(403, 'consent_expired', 'Consent has expired; ask the visitor again.');
          }
          const consumedAt = now();
          tx.set(ref, { consumedAt: new Date(consumedAt) }, { merge: true });
          return { ...record, consumedAt };
        });
      },
    },

    audit: {
      async append(entry) {
        await col('audit')
          .doc(entry.id)
          .set({ ...entry, at: new Date(entry.at) });
        return { ...entry };
      },
      async list({ adGroupId, limit = 50 } = {}) {
        const base = col('audit');
        const query = adGroupId
          ? base.where('adGroupId', '==', adGroupId).orderBy('at', 'desc').limit(limit)
          : base.orderBy('at', 'desc').limit(limit);
        const snap = await query.get();
        return snap.docs.map((doc) => {
          const data = doc.data();
          return { ...data, id: data.id ?? doc.id, at: typeof data.at === 'number' ? data.at : toMillis(data.at) };
        });
      },
    },

    async health() {
      try {
        await col('audit').limit(1).get();
        return { ok: true, kind: 'firestore' };
      } catch (error) {
        return { ok: false, kind: 'firestore', reason: String(error?.message ?? error) };
      }
    },
  };

  return assertContract(store, 'firestore');
}
