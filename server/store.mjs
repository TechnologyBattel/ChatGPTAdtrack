// Storage interface for everything that must outlive a single request:
//   sessions          — short-lived tracking sessions consent ids are bound to
//   consents          — the grant record, so replay and cross-session use can be refused
//   audit             — push/undo history, including failed pushes
//   outbox            — events accepted but not yet delivered upstream (retry + dead letter)
//
// Two implementations, one contract:
//   createMemoryStore()                 — tests, local dev
//   createFirestoreStore({ firestore }) — production; needs the Admin SDK
//
// The contract is async everywhere so swapping implementations cannot change
// call sites. Errors use ApiError with stable codes.
//
// Consent lifecycle (three states, one record):
//   issued  — signed, stored, usable
//   pending — claimed by exactly one delivery attempt; a second claim is refused, so a
//             double POST cannot enqueue the same event twice
//   consumed— the upstream forward was accepted. Only this state is "used".
//
// `claim` exists because the id must stay usable while the outbox retries: consuming
// on capture would burn consent for an event that may never be delivered, and
// consuming on every retry would make the retry impossible.

import { ApiError } from './errors.mjs';

export const STORE_CONTRACT = ['sessions', 'consents', 'audit', 'outbox', 'records', 'maintenance'];

/**
 * Tenant-scoped record collections. Everything that belongs to one customer lives in
 * one of these, and every access names the organization it is scoped to.
 *
 * `organizations` and `memberships` are global (a membership is how you discover an
 * organization); the rest are always read and written under an organization path.
 */
export const RECORD_COLLECTIONS = [
  'organizations',
  'memberships',
  'workspaces',
  'campaigns',
  'topics',
  'events',
  'leads',
  'sources',
  'auditLog',
  // Global, not tenant-scoped: an ingest key must be resolvable from the key id alone.
  'ingestKeys',
  // Global, one-shot: a HubSpot OAuth state, consumed atomically by exactly one callback.
  'oauthStates',
  // Tenant-scoped: saved guided-research reports.
  'researchRuns',
  // Tenant-scoped: fixed-window counters (webhook delivery limits). Ephemeral.
  'rateLimits',
];

function assertContract(store, kind) {
  for (const part of STORE_CONTRACT) {
    if (!store[part]) throw new Error(`${kind} store is missing "${part}".`);
  }
  return store;
}

function expired(at, now) {
  return typeof at === 'number' ? at <= now : new Date(at).getTime() <= now;
}

function consentChecks(record, { sessionId, now, allowExpired = false }) {
  if (!record) throw new ApiError(403, 'consent_unknown', 'Consent id is not recognised by this server.');
  if (record.sessionId !== sessionId) {
    throw new ApiError(403, 'consent_session_mismatch', 'Consent id belongs to a different session.');
  }
  if (record.consumedAt) throw new ApiError(403, 'consent_replayed', 'Consent id has already been used.');
  if (!allowExpired && expired(record.expiresAt, typeof now === 'function' ? now() : now)) {
    throw new ApiError(403, 'consent_expired', 'Consent has expired; ask the visitor again.');
  }
}

// ---------------------------------------------------------------------------
// Tenant-scoped records
//
// One tiny document API, two implementations. `orgId` is not a filter applied after
// the fact — it is part of the key (memory) or the path (Firestore), so a query that
// forgot the tenant cannot accidentally return another tenant's rows.
// ---------------------------------------------------------------------------

function matchesWhere(doc, where = {}) {
  return Object.entries(where).every(([field, value]) => {
    if (value === undefined) return true;
    return doc?.[field] === value;
  });
}

function memoryRecords({ now }) {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const keyOf = (id, orgId) => (orgId ? `${orgId}|${id}` : id);

  return {
    kind: 'memory',

    async put(collection, id, doc, { orgId = null } = {}) {
      const record = { ...doc, updatedAt: now() };
      table(collection).set(keyOf(id, orgId), record);
      return { ...record };
    },

    /** Insert-once. Returns `{created:false}` instead of throwing, so a retry is a 200. */
    async create(collection, id, doc, { orgId = null } = {}) {
      const key = keyOf(id, orgId);
      if (table(collection).has(key)) return { created: false, doc: { ...table(collection).get(key) } };
      const record = { ...doc, createdAt: doc.createdAt ?? now(), updatedAt: now() };
      table(collection).set(key, record);
      return { created: true, doc: { ...record } };
    },

    async get(collection, id, { orgId = null } = {}) {
      const record = table(collection).get(keyOf(id, orgId));
      return record ? { ...record } : null;
    },

    async list(collection, { orgId = null, where = {}, limit = 1000 } = {}) {
      const prefix = orgId ? `${orgId}|` : null;
      const rows = [];
      for (const [key, doc] of table(collection)) {
        if (prefix && !key.startsWith(prefix)) continue;
        if (!matchesWhere(doc, where)) continue;
        rows.push({ ...doc });
      }
      return rows.slice(0, limit);
    },

    async update(collection, id, patch, { orgId = null } = {}) {
      const key = keyOf(id, orgId);
      const existing = table(collection).get(key);
      if (!existing) return null;
      const next = { ...existing, ...patch, updatedAt: now() };
      table(collection).set(key, next);
      return { ...next };
    },

    async remove(collection, id, { orgId = null } = {}) {
      return table(collection).delete(keyOf(id, orgId));
    },

    /**
     * Consume a one-shot record (an OAuth state) exactly once.
     *
     * The whole read-check-write happens in this function with **no await between the
     * check and the write**, so two concurrent callers in one process cannot both win:
     * an `await` is the only place Node can interleave them. The Firestore adapter gets
     * the same guarantee from a transaction instead (see below), which is what makes it
     * safe across instances.
     *
     * Returns `{consumed, reason, doc}`; the caller maps `reason` to its own error codes
     * so the HTTP surface does not have to know about storage.
     */
    async consumeOnce(collection, id, { orgId = null, at = now(), expect = {} } = {}) {
      const key = keyOf(id, orgId);
      const record = table(collection).get(key);
      if (!record) return { consumed: false, reason: 'not_found', doc: null };
      if (!matchesWhere(record, expect)) return { consumed: false, reason: 'mismatch', doc: { ...record } };
      if (record.usedAt) return { consumed: false, reason: 'already_used', doc: { ...record } };
      const next = { ...record, usedAt: at, updatedAt: at };
      table(collection).set(key, next);
      return { consumed: true, reason: null, doc: { ...next } };
    },

    /**
     * Acquire an expiring lease on an existing record.
     *
     * A lease is how two instances agree that one of them owns a job. It expires, so a
     * crashed holder cannot block the job forever, and it carries a holder id, so the
     * owner can prove it still owns the lease when it finally writes its result.
     */
    async acquireLease(collection, id, { orgId = null, at = now(), ttlMs, holder, patch = {} } = {}) {
      const key = keyOf(id, orgId);
      const record = table(collection).get(key);
      if (!record) return { acquired: false, reason: 'not_found', doc: null };
      const lease = record.lease ?? null;
      if (lease && Number(lease.expiresAt) > at) {
        return { acquired: false, reason: 'held', doc: { ...record }, lease };
      }
      const nextLease = { holder, acquiredAt: at, renewedAt: at, expiresAt: at + ttlMs };
      const next = { ...record, ...patch, lease: nextLease, updatedAt: at };
      table(collection).set(key, next);
      return { acquired: true, tookOver: Boolean(lease), doc: { ...next } };
    },

    /** Extend a lease we still hold. Returns `{renewed:false, reason:'lost'}` if we do not. */
    async renewLease(collection, id, { orgId = null, at = now(), ttlMs, holder }) {
      const key = keyOf(id, orgId);
      const record = table(collection).get(key);
      if (!record) return { renewed: false, reason: 'not_found' };
      const lease = record.lease ?? null;
      if (!lease || lease.holder !== holder || Number(lease.expiresAt) <= at) {
        return { renewed: false, reason: 'lost' };
      }
      const nextLease = { ...lease, renewedAt: at, expiresAt: at + ttlMs };
      table(collection).set(key, { ...record, lease: nextLease, updatedAt: at });
      return { renewed: true, reason: null, lease: nextLease };
    },

    /**
     * Release a lease and write the holder's result in the same atomic step.
     *
     * `unless(record)` is evaluated inside the atomic section. That is what stops a sync
     * that finished after a disconnect from writing its own status over the disconnect:
     * the guard sees the disconnected record and the patch is dropped (the lease is still
     * released, so nothing is left locked).
     */
    async releaseLease(collection, id, { orgId = null, at = now(), holder, patch = {}, unless = null } = {}) {
      const key = keyOf(id, orgId);
      const record = table(collection).get(key);
      if (!record) return { released: false, applied: false, reason: 'not_found', doc: null };
      const lease = record.lease ?? null;
      if (!lease || lease.holder !== holder) {
        return { released: false, applied: false, reason: 'lost', doc: { ...record } };
      }
      const blocked = typeof unless === 'function' ? !unless(record) : false;
      const { lease: _lease, ...rest } = record;
      const next = { ...rest, ...(blocked ? {} : patch), updatedAt: at };
      table(collection).set(key, next);
      return { released: true, applied: !blocked, reason: blocked ? 'guarded' : null, doc: { ...next } };
    },

    /**
     * Count a hit inside a fixed window, atomically, and say whether it is allowed.
     *
     * This is the primitive behind per-source webhook rate limiting. It has to be atomic
     * for the same reason `consumeOnce` does: two deliveries arriving together must not
     * both read "count 119" and both proceed. A window is fixed, not sliding, because a
     * fixed window needs one counter instead of a list of timestamps, and a webhook
     * limiter only needs to bound bursts, not be statistically exact.
     */
    async bumpCounter(collection, id, { orgId = null, at = now(), windowMs, limit } = {}) {
      const key = keyOf(id, orgId);
      const record = table(collection).get(key) ?? null;
      const fresh = !record || Number(at) - Number(record.windowStart) >= Number(windowMs);
      const windowStart = fresh ? at : Number(record.windowStart);
      const previous = fresh ? 0 : Number(record.count) || 0;
      const count = previous + 1;
      const resetAt = windowStart + Number(windowMs);
      // The counter keeps rising past the limit on purpose: an operator wants to know a
      // source sent 900 deliveries, not merely "more than 120".
      const next = { id, organizationId: orgId ?? null, windowStart, count, resetAt, updatedAt: at };
      table(collection).set(key, next);
      return { allowed: count <= Number(limit), count, limit: Number(limit), resetAt, windowStart };
    },

    async purgeWhere(collection, where, { orgId = null } = {}) {
      const prefix = orgId ? `${orgId}|` : null;
      const doomed = [];
      for (const [key, doc] of table(collection)) {
        if (prefix && !key.startsWith(prefix)) continue;
        if (matchesWhere(doc, where)) doomed.push(key);
      }
      for (const key of doomed) table(collection).delete(key);
      return doomed.length;
    },

    async purgeBefore(collection, field, cutoffMs, { orgId = null } = {}) {
      const prefix = orgId ? `${orgId}|` : null;
      const doomed = [];
      for (const [key, doc] of table(collection)) {
        if (prefix && !key.startsWith(prefix)) continue;
        const at = doc?.[field];
        if (typeof at === 'number' && at < cutoffMs) doomed.push(key);
      }
      for (const key of doomed) table(collection).delete(key);
      return doomed.length;
    },
  };
}

function firestoreRecords({ firestore, prefix, now }) {
  /**
   * Organization data lives under `adtrack_orgs/{orgId}/{collection}`: a subcollection,
   * so a Firestore security rule (or a future query) cannot cross tenants by accident,
   * and no composite index is needed for the common "everything in this workspace"
   * read. Global collections are a single `adtrack_{collection}`.
   */
  const ref = (collection, orgId) =>
    orgId
      ? firestore.collection(`${prefix}_orgs`).doc(orgId).collection(collection)
      : firestore.collection(`${prefix}_${collection}`);

  const toDoc = (data) => {
    if (!data) return null;
    const out = { ...data };
    // Timestamps are stored as epoch milliseconds: numbers sort and compare without a
    // conversion step, and retention queries use the same unit everywhere.
    for (const key of ['createdAt', 'updatedAt', 'occurredAt', 'at']) {
      if (out[key]?.toDate) out[key] = out[key].toDate().getTime();
    }
    return out;
  };

  return {
    kind: 'firestore',

    async put(collection, id, doc, { orgId = null } = {}) {
      const record = { ...doc, updatedAt: now() };
      await ref(collection, orgId).doc(id).set(record);
      return record;
    },

    async create(collection, id, doc, { orgId = null } = {}) {
      const record = { ...doc, createdAt: doc.createdAt ?? now(), updatedAt: now() };
      try {
        // `create` fails with ALREADY_EXISTS, which is what makes idempotency a
        // property of the database rather than of a read-then-write race.
        await ref(collection, orgId).doc(id).create(record);
        return { created: true, doc: record };
      } catch (error) {
        const code = error?.code;
        if (code === 6 || /already exists/i.test(String(error?.message ?? ''))) {
          const existing = await ref(collection, orgId).doc(id).get();
          return { created: false, doc: toDoc(existing.data()) };
        }
        throw error;
      }
    },

    async get(collection, id, { orgId = null } = {}) {
      const snap = await ref(collection, orgId).doc(id).get();
      return snap.exists ? toDoc(snap.data()) : null;
    },

    async list(collection, { orgId = null, where = {}, limit = 1000 } = {}) {
      let query = ref(collection, orgId);
      for (const [field, value] of Object.entries(where)) {
        if (value !== undefined) query = query.where(field, '==', value);
      }
      const snap = await query.limit(limit).get();
      return snap.docs.map((doc) => ({ id: doc.id, ...toDoc(doc.data()) }));
    },

    async update(collection, id, patch, { orgId = null } = {}) {
      const target = ref(collection, orgId).doc(id);
      const snap = await target.get();
      if (!snap.exists) return null;
      await target.set({ ...patch, updatedAt: now() }, { merge: true });
      const after = await target.get();
      return toDoc(after.data());
    },

    async remove(collection, id, { orgId = null } = {}) {
      await ref(collection, orgId).doc(id).delete();
      return true;
    },

    /**
     * Consume a one-shot record exactly once.
     *
     * A Firestore transaction, not a read-then-write: the read and the write belong to
     * the same commit, so two callbacks racing on the same OAuth state produce exactly
     * one `consumed: true` no matter how many instances are running.
     */
    async consumeOnce(collection, id, { orgId = null, at = now(), expect = {} } = {}) {
      const target = ref(collection, orgId).doc(id);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(target);
        if (!snap.exists) return { consumed: false, reason: 'not_found', doc: null };
        const record = toDoc(snap.data());
        if (!matchesWhere(record, expect)) return { consumed: false, reason: 'mismatch', doc: record };
        if (record.usedAt) return { consumed: false, reason: 'already_used', doc: record };
        tx.set(target, { usedAt: at, updatedAt: at }, { merge: true });
        return { consumed: true, reason: null, doc: { ...record, usedAt: at } };
      });
    },

    /** Acquire an expiring lease, or report who holds it. Same transaction rule as above. */
    async acquireLease(collection, id, { orgId = null, at = now(), ttlMs, holder, patch = {} } = {}) {
      const target = ref(collection, orgId).doc(id);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(target);
        if (!snap.exists) return { acquired: false, reason: 'not_found', doc: null };
        const record = toDoc(snap.data());
        const lease = record.lease ?? null;
        if (lease && Number(lease.expiresAt) > at) {
          return { acquired: false, reason: 'held', doc: record, lease };
        }
        const nextLease = { holder, acquiredAt: at, renewedAt: at, expiresAt: at + ttlMs };
        tx.set(target, { ...patch, lease: nextLease, updatedAt: at }, { merge: true });
        return { acquired: true, tookOver: Boolean(lease), doc: { ...record, ...patch, lease: nextLease } };
      });
    },

    async renewLease(collection, id, { orgId = null, at = now(), ttlMs, holder }) {
      const target = ref(collection, orgId).doc(id);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(target);
        if (!snap.exists) return { renewed: false, reason: 'not_found' };
        const record = toDoc(snap.data());
        const lease = record.lease ?? null;
        if (!lease || lease.holder !== holder || Number(lease.expiresAt) <= at) {
          return { renewed: false, reason: 'lost' };
        }
        const nextLease = { ...lease, renewedAt: at, expiresAt: at + ttlMs };
        tx.set(target, { lease: nextLease, updatedAt: at }, { merge: true });
        return { renewed: true, reason: null, lease: nextLease };
      });
    },

    async releaseLease(collection, id, { orgId = null, at = now(), holder, patch = {}, unless = null } = {}) {
      const target = ref(collection, orgId).doc(id);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(target);
        if (!snap.exists) return { released: false, applied: false, reason: 'not_found', doc: null };
        const record = toDoc(snap.data());
        const lease = record.lease ?? null;
        if (!lease || lease.holder !== holder) {
          return { released: false, applied: false, reason: 'lost', doc: record };
        }
        const blocked = typeof unless === 'function' ? !unless(record) : false;
        const patchFields = blocked ? {} : patch;
        const committed = { ...record, ...patchFields };
        delete committed.lease;
        tx.set(target, { ...patchFields, lease: null, updatedAt: at }, { merge: true });
        return { released: true, applied: !blocked, reason: blocked ? 'guarded' : null, doc: committed };
      });
    },

    /** Atomic fixed-window counter. See the in-memory adapter for why it exists. */
    async bumpCounter(collection, id, { orgId = null, at = now(), windowMs, limit } = {}) {
      const target = ref(collection, orgId).doc(id);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(target);
        const record = snap.exists ? toDoc(snap.data()) : null;
        const fresh = !record || Number(at) - Number(record.windowStart) >= Number(windowMs);
        const windowStart = fresh ? at : Number(record.windowStart);
        const previous = fresh ? 0 : Number(record.count) || 0;
        const count = previous + 1;
        const resetAt = windowStart + Number(windowMs);
        tx.set(
          target,
          { id, organizationId: orgId ?? null, windowStart, count, resetAt, updatedAt: at },
          { merge: true },
        );
        return { allowed: count <= Number(limit), count, limit: Number(limit), resetAt, windowStart };
      });
    },

    async purgeWhere(collection, where, { orgId = null } = {}) {
      let query = ref(collection, orgId);
      for (const [field, value] of Object.entries(where)) query = query.where(field, '==', value);
      const snap = await query.limit(500).get();
      for (const doc of snap.docs) await doc.ref.delete();
      return snap.docs.length;
    },

    async purgeBefore(collection, field, cutoffMs, { orgId = null } = {}) {
      const snap = await ref(collection, orgId).where(field, '<', cutoffMs).limit(500).get();
      for (const doc of snap.docs) await doc.ref.delete();
      return snap.docs.length;
    },
  };
}

/** Retention policy per collection, in days. Absent means "kept until deleted". */
export const RETENTION_DAYS = {
  events: 396, // 13 months
  leads: 760, // 25 months
  auditLog: 396,
  topics: null,
  // Saved research is a business record made by a person; it is kept as long as the
  // evidence it cites (topics are kept indefinitely), so it is not swept.
  researchRuns: null,
  // One-shot OAuth states are useless an hour after they expire. Kept for a day so a
  // late callback still gets `state_expired` rather than an indistinguishable 404.
  oauthStates: 1,
  // Rate-limit windows are ephemeral; a day is already far past useful.
  rateLimits: 1,
};

/** Which timestamp decides a record's age. Explicit per collection, not guessed. */
const RETENTION_FIELD = {
  events: 'occurredAt',
  leads: 'createdAt',
  auditLog: 'at',
  topics: 'createdAt',
  researchRuns: 'createdAt',
  oauthStates: 'createdAt',
  rateLimits: 'windowStart',
};

function createMaintenance({ records, now }) {
  /**
   * Delete what the retention policy says is past its life.
   *
   * Runs per organization as well as globally, so one tenant's deletion request can be
   * satisfied without touching anyone else. Returns counts — a silent purge is
   * indistinguishable from a purge that did nothing.
   */
  async function purge({ organizationId = null, days = RETENTION_DAYS } = {}) {
    const at = now();
    const removed = {};
    for (const [collection, maxDays] of Object.entries(days)) {
      if (!maxDays) continue;
      const cutoff = at - maxDays * 24 * 60 * 60 * 1000;
      const field = RETENTION_FIELD[collection] ?? 'createdAt';
      removed[collection] = await records.purgeBefore(collection, field, cutoff, { orgId: organizationId });
    }
    return { at, organizationId, removed };
  }

  return { purge, policy: () => ({ ...RETENTION_DAYS }) };
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

export function createMemoryStore({ now = () => Date.now(), maxAudit = 500, maxOutbox = 1000 } = {}) {
  const sessions = new Map();
  const consents = new Map();
  const audit = [];
  const outbox = new Map();

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
       * Reserve the id for one delivery attempt. Refuses a replay (already consumed),
       * a second in-flight attempt, a different session, and an expired id.
       * `owner` records who holds the claim: 'direct' or the outbox entry id.
       */
      async claim({ consentId, sessionId, owner = 'direct' }) {
        const record = consents.get(consentId);
        consentChecks(record, { sessionId, now });
        if (record.pendingAt) {
          throw new ApiError(403, 'consent_in_flight', 'Consent id is already being delivered for another event.');
        }
        record.pendingAt = now();
        record.pendingBy = owner;
        consents.set(consentId, record);
        return { ...record };
      },
      /**
       * Mark the claim delivered. This is the only transition that counts as "used",
       * and it happens only after the upstream API accepted the event.
       * `allowExpired` lets a queued retry settle a grant that expired while queued —
       * the consent was valid when the event was captured.
       */
      // Strict by default: expiry is enforced unless the caller explicitly opts out
      // (only the outbox does, for events captured inside the window).
      async consume({ consentId, sessionId, allowExpired = false }) {
        const record = consents.get(consentId);
        consentChecks(record, { sessionId, now, allowExpired });
        record.consumedAt = now();
        record.pendingAt = record.pendingAt ?? record.consumedAt;
        consents.set(consentId, record);
        return { ...record };
      },
      /** Drop a claim that will never be delivered (dead letter), without marking it used. */
      async release({ consentId }) {
        const record = consents.get(consentId);
        if (!record || record.consumedAt) return record ? { ...record } : null;
        delete record.pendingAt;
        delete record.pendingBy;
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
      async list({ adGroupId, limit = 50, ok } = {}) {
        const filtered = audit.filter(
          (e) => (!adGroupId || e.adGroupId === adGroupId) && (ok === undefined || e.ok === ok),
        );
        return filtered.slice(0, limit).map((e) => ({ ...e }));
      },
    },

    outbox: {
      async enqueue(entry) {
        if (outbox.size >= maxOutbox) {
          throw new ApiError(503, 'outbox_full', 'The event outbox is full; refusing to accept more events.');
        }
        const record = {
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now(),
          lastError: null,
          createdAt: now(),
          ...entry,
        };
        outbox.set(record.id, record);
        return { ...record };
      },
      async get(id) {
        const record = outbox.get(id);
        return record ? { ...record } : null;
      },
      async due({ limit = 25 } = {}) {
        const ts = now();
        return [...outbox.values()]
          .filter((e) => e.status === 'pending' && e.nextAttemptAt <= ts)
          .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
          .slice(0, limit)
          .map((e) => ({ ...e }));
      },
      async markDelivered(id, { deliveredAt = now() } = {}) {
        const record = outbox.get(id);
        if (!record) return null;
        const next = { ...record, status: 'delivered', deliveredAt, lastError: null };
        outbox.set(id, next);
        return { ...next };
      },
      async markFailed(id, { error, nextAttemptAt, dead = false }) {
        const record = outbox.get(id);
        if (!record) return null;
        const next = {
          ...record,
          attempts: record.attempts + 1,
          status: dead ? 'dead' : 'pending',
          lastError: error ?? 'unknown error',
          nextAttemptAt: dead ? record.nextAttemptAt : (nextAttemptAt ?? now()),
          deadAt: dead ? now() : null,
        };
        outbox.set(id, next);
        return { ...next };
      },
      async list({ status, limit = 50 } = {}) {
        return [...outbox.values()]
          .filter((e) => !status || e.status === status)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit)
          .map((e) => ({ ...e }));
      },
    },

    records: memoryRecords({ now }),
    maintenance: null, // filled in below, once `store` exists

    async health() {
      return { ok: true, kind: 'memory' };
    },
  };

  store.maintenance = createMaintenance({ records: store.records, now });

  return assertContract(store, 'memory');
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------

/**
 * Adapts a Firestore instance to the contract above. `firestore` is injected so
 * this file never imports the Admin SDK: the SDK is an optional dependency and is
 * only loaded when AUTH_MODE=firebase.
 *
 * Indexes required by the queries here are declared in firestore.indexes.json;
 * TTL policies and rules are documented in docs/SECURITY.md §7.
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
            pendingAt: null,
          });
        return { ...record };
      },
      async get(consentId) {
        const snap = await col('consents').doc(consentId).get();
        return snap.exists ? snap.data() : null;
      },
      /** Compare-and-set inside a transaction, so two concurrent claims cannot both win. */
      async claim({ consentId, sessionId, owner = 'direct' }) {
        const ref = col('consents').doc(consentId);
        return firestore.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const record = snap.exists ? snap.data() : null;
          consentChecks(record, { sessionId, now });
          if (record.pendingAt) {
            throw new ApiError(403, 'consent_in_flight', 'Consent id is already being delivered for another event.');
          }
          const pendingAt = now();
          tx.set(ref, { pendingAt: new Date(pendingAt), pendingBy: owner }, { merge: true });
          return { ...record, pendingAt, pendingBy: owner };
        });
      },
      // Strict by default: expiry is enforced unless the caller explicitly opts out
      // (only the outbox does, for events captured inside the window).
      async consume({ consentId, sessionId, allowExpired = false }) {
        const ref = col('consents').doc(consentId);
        return firestore.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const record = snap.exists ? snap.data() : null;
          consentChecks(record, { sessionId, now, allowExpired });
          const consumedAt = now();
          tx.set(
            ref,
            { consumedAt: new Date(consumedAt), pendingAt: record.pendingAt ?? new Date(consumedAt) },
            { merge: true },
          );
          return { ...record, consumedAt };
        });
      },
      async release({ consentId }) {
        const ref = col('consents').doc(consentId);
        const snap = await ref.get();
        if (!snap.exists) return null;
        const record = snap.data();
        if (record.consumedAt) return record;
        await ref.set({ pendingAt: null, pendingBy: null }, { merge: true });
        const { pendingAt: _pendingAt, pendingBy: _pendingBy, ...rest } = record;
        return rest;
      },
    },

    audit: {
      async append(entry) {
        await col('audit')
          .doc(entry.id)
          .set({ ...entry, at: new Date(entry.at) });
        return { ...entry };
      },
      /** `ok` needs the composite indexes declared in firestore.indexes.json. */
      async list({ adGroupId, limit = 50, ok } = {}) {
        let query = col('audit');
        if (adGroupId) query = query.where('adGroupId', '==', adGroupId);
        if (ok !== undefined) query = query.where('ok', '==', ok);
        query = query.orderBy('at', 'desc').limit(limit);
        const snap = await query.get();
        return snap.docs.map((doc) => {
          const data = doc.data();
          return { ...data, id: data.id ?? doc.id, at: typeof data.at === 'number' ? data.at : toMillis(data.at) };
        });
      },
    },

    outbox: {
      async enqueue(entry) {
        const record = {
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now(),
          lastError: null,
          createdAt: now(),
          ...entry,
        };
        await col('outbox')
          .doc(record.id)
          .set({
            ...record,
            createdAt: new Date(record.createdAt),
            nextAttemptAt: new Date(record.nextAttemptAt),
          });
        return record;
      },
      async get(id) {
        const snap = await col('outbox').doc(id).get();
        if (!snap.exists) return null;
        const data = snap.data();
        return { ...data, nextAttemptAt: toMillis(data.nextAttemptAt), createdAt: toMillis(data.createdAt) };
      },
      /** Needs the composite index on (status asc, nextAttemptAt asc). */
      async due({ limit = 25 } = {}) {
        const snap = await col('outbox')
          .where('status', '==', 'pending')
          .where('nextAttemptAt', '<=', new Date(now()))
          .orderBy('nextAttemptAt', 'asc')
          .limit(limit)
          .get();
        return snap.docs.map((doc) => {
          const data = doc.data();
          return { ...data, nextAttemptAt: toMillis(data.nextAttemptAt), createdAt: toMillis(data.createdAt) };
        });
      },
      async markDelivered(id, { deliveredAt = now() } = {}) {
        const ref = col('outbox').doc(id);
        await ref.set({ status: 'delivered', deliveredAt: new Date(deliveredAt), lastError: null }, { merge: true });
        const snap = await ref.get();
        return snap.exists ? snap.data() : null;
      },
      async markFailed(id, { error, nextAttemptAt, dead = false }) {
        const ref = col('outbox').doc(id);
        const snap = await ref.get();
        if (!snap.exists) return null;
        const record = snap.data();
        const update = {
          attempts: (record.attempts ?? 0) + 1,
          status: dead ? 'dead' : 'pending',
          lastError: error ?? 'unknown error',
          ...(dead ? { deadAt: new Date(now()) } : {}),
          ...(nextAttemptAt ? { nextAttemptAt: new Date(nextAttemptAt) } : {}),
        };
        await ref.set(update, { merge: true });
        return { ...record, ...update };
      },
      async list({ status, limit = 50 } = {}) {
        const base = col('outbox');
        const query = status
          ? base.where('status', '==', status).orderBy('createdAt', 'desc').limit(limit)
          : base.orderBy('createdAt', 'desc').limit(limit);
        const snap = await query.get();
        return snap.docs.map((doc) => {
          const data = doc.data();
          return { ...data, nextAttemptAt: toMillis(data.nextAttemptAt), createdAt: toMillis(data.createdAt) };
        });
      },
    },

    records: firestoreRecords({ firestore, prefix, now }),
    maintenance: null, // filled in below, once `store` exists

    async health() {
      try {
        await col('audit').limit(1).get();
        return { ok: true, kind: 'firestore' };
      } catch (error) {
        return { ok: false, kind: 'firestore', reason: String(error?.message ?? error) };
      }
    },
  };

  store.maintenance = createMaintenance({ records: store.records, now });

  return assertContract(store, 'firestore');
}
