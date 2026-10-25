export declare const STORE_CONTRACT: string[];

export interface StoredSession {
  sessionId: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  expiresAt: number;
}
export interface StoredConsent {
  consentId: string;
  sessionId: string;
  scopes: string[];
  subject: string | null;
  keyVersion: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
}
export interface AuditEntry {
  id: string;
  at: number;
  action: string;
  adGroupId: string;
  before: string[];
  after: string[];
  actor: string;
  actorRole?: string;
  ok: boolean;
}
export interface Store {
  kind: 'memory' | 'firestore';
  sessions: {
    create(session: StoredSession): Promise<StoredSession>;
    get(sessionId: string): Promise<StoredSession | null>;
    count(): Promise<number>;
  };
  consents: {
    save(record: StoredConsent): Promise<StoredConsent>;
    get(consentId: string): Promise<StoredConsent | null>;
    consume(input: { consentId: string; sessionId: string }): Promise<StoredConsent>;
  };
  audit: {
    append(entry: AuditEntry): Promise<AuditEntry>;
    list(input?: { adGroupId?: string; limit?: number }): Promise<AuditEntry[]>;
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
