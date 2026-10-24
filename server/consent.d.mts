export type ConsentScope = 'measurement';
export interface ConsentGrant {
  scopes: string[];
  grantedAt: string;
  expiresAt: string;
  subject: string | null;
}
export interface ConsentStore {
  issue(input?: { scopes?: string[]; subjectHash?: string }): {
    consentId: string;
    scopes: string[];
    expiresAt: string;
  };
  verify(consentId: unknown, requiredScope?: string): ConsentGrant;
}
export declare const CONSENT_SCOPES: ConsentScope[];
export declare function createConsentStore(opts: {
  secret: string;
  ttlSeconds?: number;
  now?: () => number;
}): ConsentStore;
