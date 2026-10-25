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
  consume(input: { consentId?: string; sessionId?: string; scope?: string }): Promise<ConsentRecord>;
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
