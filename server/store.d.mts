export declare const STORE_CONTRACT: string[];

export interface StoredSession {
  sessionId: string;
  ip: string | null;
  userAgent: string | null;
  uaHash?: string | null;
  createdAt: number;
  expiresAt: number;
}
export interface StoredConsent {
  consentId: string;
  sessionId: string;
  scopes: string[];
  subject?: string | null;
  keyVersion?: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  /** Set while an attempt holds the id; a second attempt is `consent_in_flight`. */
  pendingAt?: number | null;
  /** Who holds the claim: `direct` or an outbox entry id. */
  pendingBy?: string | null;
}
export interface AuditEntry {
  id: string;
  at: number;
  action: string;
  adGroupId: string;
  before?: string[];
  after?: string[];
  actor: string;
  actorRole?: string;
  ok: boolean;
  error?: string;
  errorCode?: string;
  upstreamStatus?: number;
  outboxId?: string;
}
export type OutboxStatus = 'pending' | 'delivered' | 'dead';
export interface OutboxEntry {
  id: string;
  eventId: string;
  eventName: string;
  event: Record<string, unknown>;
  consent: { consentId: string; sessionId: string; claimedAt?: number } | null;
  reason: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  lastError: string | null;
  deliveredAt?: number;
  deadAt?: number | null;
}
export interface ListOptions {
  orgId?: string | null;
  where?: Record<string, unknown>;
  limit?: number;
}
export interface WriteOptions {
  orgId?: string | null;
}

/**
 * Tenant-scoped document storage. Every method that takes `orgId` prefixes the key, so a
 * read can never cross tenants; collections that must be tenant-global (ingest keys,
 * memberships) are written without it deliberately.
 */
export interface Records {
  kind: string;
  put(collection: string, id: string, doc: Record<string, any>, opts?: WriteOptions): Promise<Record<string, any>>;
  /** Insert-once: `created:false` on retry instead of throwing. */
  create(
    collection: string,
    id: string,
    doc: Record<string, any>,
    opts?: WriteOptions,
  ): Promise<{ created: boolean; doc: Record<string, any> }>;
  get(collection: string, id: string, opts?: WriteOptions): Promise<Record<string, any> | null>;
  list(collection: string, opts?: ListOptions): Promise<Record<string, any>[]>;
  update(
    collection: string,
    id: string,
    patch: Record<string, any>,
    opts?: WriteOptions,
  ): Promise<Record<string, any> | null>;
  remove(collection: string, id: string, opts?: WriteOptions): Promise<boolean>;
  purgeWhere(collection: string, where: Record<string, unknown>, opts?: WriteOptions): Promise<number>;
  purgeBefore(collection: string, field: string, cutoffMs: number, opts?: WriteOptions): Promise<number>;
  /**
   * Consume a one-shot record exactly once. Atomic in both adapters: a memory section
   * with no await between check and write, and a Firestore transaction.
   */
  consumeOnce(
    collection: string,
    id: string,
    opts?: { orgId?: string | null; at?: number; expect?: Record<string, unknown> },
  ): Promise<{
    consumed: boolean;
    reason: 'not_found' | 'mismatch' | 'already_used' | null;
    doc: Record<string, any> | null;
  }>;
  /**
   * Count a hit inside a fixed window, atomically, and report whether it is allowed.
   * Used for per-source webhook rate limiting; the counter keeps rising past `limit`
   * so an operator can see how far over a source went.
   */
  bumpCounter(
    collection: string,
    id: string,
    opts: { orgId?: string | null; at?: number; windowMs: number; limit: number },
  ): Promise<{
    allowed: boolean;
    count: number;
    limit: number;
    resetAt: number;
    windowStart: number;
  }>;
  /** Take an expiring lease, or report the lease that is already held. */
  acquireLease(
    collection: string,
    id: string,
    opts: { orgId?: string | null; at?: number; ttlMs: number; holder: string; patch?: Record<string, any> },
  ): Promise<{
    acquired: boolean;
    reason?: 'not_found' | 'held';
    tookOver?: boolean;
    doc: Record<string, any> | null;
    lease?: { holder: string; expiresAt: number } | null;
  }>;
  renewLease(
    collection: string,
    id: string,
    opts: { orgId?: string | null; at?: number; ttlMs: number; holder: string },
  ): Promise<{ renewed: boolean; reason: 'not_found' | 'lost' | null }>;
  /** Release the lease and (optionally) commit the holder's result in the same step. */
  releaseLease(
    collection: string,
    id: string,
    opts: {
      orgId?: string | null;
      at?: number;
      holder: string;
      patch?: Record<string, any>;
      /** Guard evaluated atomically: returning false drops `patch` but frees the lease. */
      unless?: ((record: Record<string, any>) => boolean) | null;
    },
  ): Promise<{
    released: boolean;
    applied: boolean;
    reason: 'not_found' | 'lost' | 'guarded' | null;
    doc: Record<string, any> | null;
  }>;
}

export interface Maintenance {
  /** Returns counts per collection; a silent purge is indistinguishable from a no-op. */
  purge(input?: {
    organizationId?: string | null;
    days?: Record<string, number | null | undefined>;
  }): Promise<{ at: number; organizationId: string | null; removed: Record<string, number> }>;
  policy(): Record<string, number | null | undefined>;
}

export interface Store {
  records: Records;
  maintenance: Maintenance | null;
  kind: 'memory' | 'firestore';
  sessions: {
    create(session: StoredSession): Promise<StoredSession>;
    get(sessionId: string): Promise<StoredSession | null>;
    count(): Promise<number>;
  };
  consents: {
    save(record: StoredConsent): Promise<StoredConsent>;
    get(consentId: string): Promise<StoredConsent | null>;
    /** Reserve the id for one attempt. Refuses replay, in-flight use, cross-session use. */
    claim(input: { consentId: string; sessionId: string; owner?: string }): Promise<StoredConsent>;
    /**
     * Mark the claim delivered. `allowExpired` is for outbox retries that settle after
     * the consent window closed; the direct path enforces expiry.
     */
    consume(input: { consentId: string; sessionId: string; allowExpired?: boolean }): Promise<StoredConsent>;
    /** Give the claim back without marking it used. */
    release(input: { consentId: string }): Promise<StoredConsent | null>;
  };
  audit: {
    append(entry: AuditEntry): Promise<AuditEntry>;
    list(input?: { adGroupId?: string; limit?: number; ok?: boolean }): Promise<AuditEntry[]>;
  };
  outbox: {
    enqueue(entry: Partial<OutboxEntry> & { id: string }): Promise<OutboxEntry>;
    get(id: string): Promise<OutboxEntry | null>;
    /** Entries whose nextAttemptAt has passed, oldest first. */
    due(input?: { limit?: number }): Promise<OutboxEntry[]>;
    list(input?: { status?: OutboxStatus; limit?: number }): Promise<OutboxEntry[]>;
    markDelivered(id: string, opts?: { deliveredAt?: number }): Promise<OutboxEntry | null>;
    markFailed(
      id: string,
      input: { error: string; nextAttemptAt?: number; dead?: boolean },
    ): Promise<OutboxEntry | null>;
  };
  health(): Promise<{ ok: boolean; kind: string; reason?: string }>;
}

export declare function createMemoryStore(opts?: { now?: () => number; maxAudit?: number }): Store;
export declare function createFirestoreStore(opts: {
  firestore: unknown;
  prefix?: string;
  now?: () => number;
  maxAudit?: number;
}): Store;
