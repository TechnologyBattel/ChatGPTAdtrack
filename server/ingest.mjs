// Server-to-server event ingest.
//
// Why the browser route is not enough: `lead_created`, `order_created` and any
// amount are things the browser can lie about. A visitor who opens devtools can
// claim a ₹99,999 order and, with a valid consent id, push revenue into the ad
// account's conversion history. High-value events therefore come from the server
// that actually recorded them, authenticated with a shared HMAC key.
//
// The scheme:
//   X-ADTrack-Key        key version, e.g. "v2"
//   X-ADTrack-Timestamp  unix seconds; rejected outside the skew window
//   X-ADTrack-Signature  hex HMAC-SHA256 over `${timestamp}.${rawBody}`
//
// The raw body is signed, not the parsed object: JSON re-serialisation differs
// between languages (key order, unicode escapes), which would make signatures
// impossible to reproduce from another stack.
//
// Keys are versioned for rotation: add v2, deploy it to senders, drop v1 once
// nothing is signing with it. Both keys are accepted while both are listed.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.mjs';

/** Events only a server may report: money, identity, or a real-world outcome. */
export const SERVER_EVENTS = new Set([
  'lead_created',
  'order_created',
  'registration_completed',
  'trial_started',
  'subscription_created',
  'appointment_scheduled',
  'custom',
]);

/** Events a browser may report: page-level signals with no money attached. */
export const BROWSER_EVENTS = new Set(['page_viewed', 'contents_viewed', 'checkout_started', 'items_added']);

export const SIGNATURE_HEADER = 'x-adtrack-signature';
export const KEY_HEADER = 'x-adtrack-key';
export const TIMESTAMP_HEADER = 'x-adtrack-timestamp';

/** Bases a sender may declare for a server event. Anything else fails closed. */
export const CONSENT_BASES = new Set(['granted', 'first_party_record']);

function header(headers, name) {
  return headers?.[name] ?? headers?.[name.toUpperCase()] ?? headers?.[name.replace(/-/g, '_')];
}

export function signIngestPayload({ secret, timestamp, body }) {
  const raw = typeof body === 'string' ? body : String(body ?? '');
  return createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a ?? ''), 'hex');
  const right = Buffer.from(String(b ?? ''), 'hex');
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verify the signature and freshness of one signed request with a known secret.
 *
 * Extracted so the two ingest paths share it exactly: the global v1 verifier (one
 * deployment-wide key list) and the per-tenant v2 path (one secret per source
 * connection). A second implementation of this check is a second chance to get it wrong.
 */
export function verifySignedPayload({
  secret,
  headers = {},
  rawBody = '',
  now = () => Date.now(),
  toleranceSeconds = 300,
}) {
  const timestamp = header(headers, TIMESTAMP_HEADER);
  const signature = header(headers, SIGNATURE_HEADER);
  if (!timestamp || !signature) {
    throw new ApiError(
      401,
      'ingest_unauthenticated',
      `Server-to-server events require ${KEY_HEADER}, ${TIMESTAMP_HEADER} and ${SIGNATURE_HEADER} headers.`,
    );
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new ApiError(401, 'ingest_timestamp_invalid', 'The ingest timestamp header is not a unix timestamp.');
  }
  const skew = Math.abs(now() / 1000 - ts);
  if (skew > toleranceSeconds) {
    throw new ApiError(
      401,
      'ingest_timestamp_stale',
      `The ingest timestamp is ${Math.round(skew)}s away from server time; the window is ±${toleranceSeconds}s.`,
    );
  }
  if (!safeEqualHex(signature, signIngestPayload({ secret, timestamp, body: rawBody }))) {
    throw new ApiError(401, 'ingest_signature_invalid', 'The ingest signature does not match the request body.');
  }
  return { timestamp: ts };
}

/**
 * opts.keys              [{version, secret}]
 * opts.now               clock injection for tests
 * opts.toleranceSeconds  ±window on the timestamp header (default 300)
 */
export function createIngestVerifier({ keys = [], now = () => Date.now(), toleranceSeconds = 300 } = {}) {
  const byVersion = new Map(keys.map((k) => [k.version, k.secret]));

  return function verifyIngest({ headers = {}, rawBody = '' } = {}) {
    if (byVersion.size === 0) {
      throw new ApiError(
        503,
        'ingest_not_configured',
        'No ingest key is configured on this server, so server-to-server events are refused.',
      );
    }
    const version = header(headers, KEY_HEADER);
    if (!version) {
      throw new ApiError(
        401,
        'ingest_unauthenticated',
        `Server-to-server events require ${KEY_HEADER}, ${TIMESTAMP_HEADER} and ${SIGNATURE_HEADER} headers.`,
      );
    }
    const secret = byVersion.get(String(version));
    if (!secret) {
      // Unknown and retired versions look identical on purpose.
      throw new ApiError(401, 'ingest_key_unknown', 'That ingest key version is not accepted by this server.');
    }
    verifySignedPayload({ secret, headers, rawBody, now, toleranceSeconds });
    return { keyVersion: String(version) };
  };
}
