// Delivery outbox.
//
// Why it exists: a consent id must not be burned for an event the upstream API
// never accepted. So the flow is claim → forward → consume, and when the forward
// fails with a *retryable* error the event is queued instead of being dropped or
// silently re-sending the visitor's consent.
//
// States (see store.mjs):
//   pending → delivered            upstream accepted the event; consent consumed
//   pending → pending (attempts+1) retry with exponential backoff
//   pending → dead                 attempts exhausted; dead letter, claim released
//
// The worker is driven by a timer in server.mjs; tests call drain() directly, so
// nothing here needs a running server to be tested.

import { randomBytes } from 'node:crypto';

export const OUTBOX_STATES = ['pending', 'delivered', 'dead'];

/** A missing key or an unconfigured route is a deployment mistake, not bad luck. */
const PERMANENT_CODES = new Set([
  'missing_ads_key',
  'missing_capi_key',
  'missing_pixel_id',
  'ingest_not_configured',
  'outbox_full',
]);

/**
 * Retryable: worth keeping the event. A 4xx means our payload is wrong forever, and a
 * missing key will not appear by waiting — retrying those would fill the outbox with
 * events that can only ever dead-letter.
 */
export function isRetryable(error) {
  if (PERMANENT_CODES.has(error?.code)) return false;
  const status = Number(error?.status ?? 0);
  if (status === 429) return true;
  if (status >= 500) return true;
  // No status at all is a network/DNS/TLS failure.
  if (!status) return true;
  return false;
}

export function backoffMs(attempts, { baseDelayMs = 30_000, maxDelayMs = 30 * 60_000 } = {}) {
  const step = Math.max(0, attempts - 1);
  return Math.min(maxDelayMs, baseDelayMs * 2 ** step);
}

/**
 * deps:
 *   store    — storage interface (outbox + consents)
 *   deliver  — async (event) => upstream result; throws ApiError on failure
 *   consent  — createConsentService(...); consumed only after a successful delivery
 *   onDeadLetter — optional async (entry, error) => void, used to audit the give-up
 */
export function createOutbox({
  store,
  deliver,
  consent,
  onDeadLetter,
  now = () => Date.now(),
  maxAttempts = 6,
  baseDelayMs = 30_000,
  maxDelayMs = 30 * 60_000,
  logger = console,
} = {}) {
  if (!store?.outbox) throw new Error('createOutbox requires a store with an outbox.');
  if (typeof deliver !== 'function') throw new Error('createOutbox requires a deliver function.');

  async function enqueue({ event, consent: grant, reason = 'upstream_error' }) {
    const entry = await store.outbox.enqueue({
      id: `ob_${randomBytes(9).toString('base64url')}`,
      eventId: event.eventId,
      eventName: event.eventName,
      event,
      consent: grant ? { consentId: grant.consentId, sessionId: grant.sessionId, claimedAt: now() } : null,
      reason,
      // The request we just served *was* the first attempt, so the retry waits for
      // one backoff step rather than firing again the moment the next drain ticks.
      nextAttemptAt: now() + backoffMs(1, { baseDelayMs, maxDelayMs }),
    });
    return entry;
  }

  async function settleDelivery(entry) {
    await store.outbox.markDelivered(entry.id);
    if (entry.consent?.consentId) {
      try {
        // A retry lands after the consent window may have closed. The grant was valid
        // when the event was captured and the event is now delivered, so accept it.
        await consent.consume({
          consentId: entry.consent.consentId,
          sessionId: entry.consent.sessionId,
          allowExpired: true,
        });
      } catch (error) {
        // The event is delivered; failing to stamp the record must not undo that.
        logger.error?.(
          `[outbox] ${entry.id} delivered but consent ${entry.consent.consentId} could not be marked used: ${error?.message ?? error}`,
        );
      }
    }
    return { id: entry.id, status: 'delivered' };
  }

  async function attempt(entry) {
    try {
      await deliver(entry.event);
      return settleDelivery(entry);
    } catch (error) {
      const attempts = (entry.attempts ?? 0) + 1;
      const retryable = isRetryable(error);
      const dead = !retryable || attempts >= maxAttempts;
      const nextAttemptAt = dead ? undefined : now() + backoffMs(attempts, { baseDelayMs, maxDelayMs });
      const updated = await store.outbox.markFailed(entry.id, {
        error: error?.message ?? String(error),
        nextAttemptAt,
        dead,
      });
      if (dead) {
        // A dead letter means the event will never be delivered, so the claim is
        // released rather than counted as used.
        if (entry.consent?.consentId) {
          await consent.release?.({ consentId: entry.consent.consentId });
        }
        logger.error?.(
          `[outbox] ${entry.id} (${entry.eventName}) dead after ${attempts} attempt(s): ${error?.message ?? error}`,
        );
        await onDeadLetter?.(updated ?? entry, error);
      } else {
        logger.warn?.(
          `[outbox] ${entry.id} retry ${attempts} scheduled in ${Math.round((nextAttemptAt - now()) / 1000)}s: ${error?.message ?? error}`,
        );
      }
      return { id: entry.id, status: dead ? 'dead' : 'pending', attempts };
    }
  }

  /** Process everything that is due. Safe to call concurrently: each entry is claimed by id. */
  async function drain({ limit = 25 } = {}) {
    const due = await store.outbox.due({ limit });
    const results = [];
    for (const entry of due) results.push(await attempt(entry));
    return results;
  }

  async function stats() {
    const [pending, dead, delivered] = await Promise.all([
      store.outbox.list({ status: 'pending', limit: 1000 }),
      store.outbox.list({ status: 'dead', limit: 1000 }),
      store.outbox.list({ status: 'delivered', limit: 1000 }),
    ]);
    return { pending: pending.length, dead: dead.length, delivered: delivered.length };
  }

  return { enqueue, drain, attempt, stats, maxAttempts, backoffMs: (n) => backoffMs(n, { baseDelayMs, maxDelayMs }) };
}
