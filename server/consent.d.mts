export type ConsentScope = 'measurement';
export declare const CONSENT_SCOPES: ConsentScope[];

export interface ConsentIssue {
  consentId: string;
  scopes: string[];
  expiresAt: string;
  ttlSeconds: number;
}
export interface ConsentRecord {
  scopes: string[];
  grantedAt: string;
  expiresAt: string;
  subject: string | null;
  keyVersion: string;
  consumedAt: string;
}
export interface SessionRecord {
  sessionId: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface ConsentService {
  createSession(input?: {
    ip?: string;
    userAgent?: string | null;
  }): Promise<{ sessionId: string; expiresAt: string; ttlSeconds: number }>;
  requireSession(sessionId?: string): Promise<SessionRecord>;
  grant(input: { sessionId?: string; scopes?: string[]; subjectHash?: string }): Promise<ConsentIssue>;
  /** Reserve the id for one attempt without consuming it. */
  claim(input: {
    consentId?: string;
    sessionId?: string;
    scope?: string;
    ip?: string;
    userAgent?: string | null;
    owner?: string;
  }): Promise<ConsentRecord>;
  /**
   * Mark the claim delivered. `allowExpired` is only used by the outbox, for events
   * captured inside the consent window that are delivered after it.
   */
  consume(input: {
    consentId?: string;
    sessionId?: string;
    scope?: string;
    allowExpired?: boolean;
  }): Promise<ConsentRecord>;
  /** Give the claim back without marking it used. */
  release(input: { consentId?: string }): Promise<unknown>;
  secrets(): string[];
  currentVersion: string;
}

export declare function createConsentService(opts: {
  secrets: { version: string; secret: string }[];
  currentVersion: string;
  store: unknown;
  sessionTtlSeconds?: number;
  consentTtlSeconds?: number;
  now?: () => number;
}): ConsentService;
