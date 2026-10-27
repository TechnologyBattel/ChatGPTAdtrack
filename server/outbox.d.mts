import type { OutboxEntry, OutboxStatus, Store } from './store.mjs';

export declare const OUTBOX_STATES: OutboxStatus[];

/**
 * 429, any 5xx, and "no status at all" (network/DNS/TLS) are worth retrying.
 * Misconfiguration (`missing_capi_key`, …) is not: it will not fix itself.
 */
export declare function isRetryable(error: unknown): boolean;

/** Exponential: base * 2^(attempts - 1), capped at maxDelayMs. */
export declare function backoffMs(attempts: number, opts?: { baseDelayMs?: number; maxDelayMs?: number }): number;

export interface Outbox {
  enqueue(input: {
    event: Record<string, any>;
    consent?: { consentId?: string; sessionId?: string } | null;
    reason?: string;
  }): Promise<OutboxEntry>;
  drain(input?: { limit?: number }): Promise<{ id: string; status: OutboxStatus; attempts?: number }[]>;
  attempt(entry: OutboxEntry): Promise<{ id: string; status: OutboxStatus; attempts?: number }>;
  stats(): Promise<{ pending: number; dead: number; delivered: number }>;
  maxAttempts: number;
  backoffMs(attempts: number): number;
}

export declare function createOutbox(opts: {
  store: Store;
  deliver: (event: Record<string, any>) => Promise<unknown>;
  consent?: {
    consume(input: { consentId: string; sessionId: string; allowExpired?: boolean }): Promise<unknown>;
    release?(input: { consentId: string }): Promise<unknown>;
  };
  onDeadLetter?: (entry: OutboxEntry, error: unknown) => unknown;
  now?: () => number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
}): Outbox;
