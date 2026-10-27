export declare const SERVER_EVENTS: Set<string>;
export declare const BROWSER_EVENTS: Set<string>;
export declare const SIGNATURE_HEADER: 'x-adtrack-signature';
export declare const KEY_HEADER: 'x-adtrack-key';
export declare const TIMESTAMP_HEADER: 'x-adtrack-timestamp';
export declare const CONSENT_BASES: Set<'granted' | 'first_party_record'>;

/** Hex HMAC-SHA256 over `${timestamp}.${rawBody}`, matching what senders compute. */
export declare function signIngestPayload(input: { secret: string; timestamp: string | number; body: string }): string;

export interface IngestVerifierOptions {
  keys?: { version: string; secret: string }[];
  now?: () => number;
  toleranceSeconds?: number;
}

export interface IngestVerifier {
  (input: { headers?: Record<string, string | undefined>; rawBody?: string }): { keyVersion: string };
}

export declare function createIngestVerifier(opts?: IngestVerifierOptions): IngestVerifier;
