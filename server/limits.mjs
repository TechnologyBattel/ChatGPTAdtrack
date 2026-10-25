// Request-shaping guards: body size, per-IP rate limit, origin allowlist.

import { ApiError } from './errors.mjs';

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024; // 256 KB is generous for one event

/** Read the raw bytes with a hard cap, so a client cannot exhaust memory. */
async function readRawBody(stream, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new ApiError(413, 'payload_too_large', `Body exceeds the ${maxBytes} byte limit.`);
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
}

function parseObject(raw) {
  // An empty body is "no fields", not malformed JSON: a chunked request may send
  // zero-length chunks, and a POST with nothing to say is still a valid request.
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      throw new ApiError(400, 'bad_json', 'Body must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'bad_json', 'Body is not valid JSON.');
  }
}

export async function readJsonBody(stream, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return parseObject(await readRawBody(stream, { maxBytes }));
}

/**
 * Same read, but also hands back the exact bytes received. The ingest route signs
 * the raw body, because re-serialising JSON from another language does not
 * reproduce byte-identical output.
 */
export async function readJsonBodyWithRaw(stream, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const raw = await readRawBody(stream, { maxBytes });
  return { body: parseObject(raw), raw };
}

/** Declared Content-Length is checked before the body is read at all. */
export function assertDeclaredSize(headers = {}, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const raw = headers['content-length'] ?? headers['Content-Length'];
  if (raw === undefined) return;
  const declared = Number(raw);
  if (!Number.isFinite(declared) || declared < 0) {
    throw new ApiError(400, 'bad_length', 'Content-Length is not a valid number.');
  }
  if (declared > maxBytes) {
    throw new ApiError(413, 'payload_too_large', `Declared body exceeds the ${maxBytes} byte limit.`);
  }
}

/**
 * Fixed-window counter per key. In-memory, so it is per instance: a multi-instance
 * deployment needs a shared store (Firestore/Redis). Documented, not hidden.
 */
export function createRateLimiter({ limit = 60, windowMs = 60_000, now = () => Date.now() } = {}) {
  const buckets = new Map();

  return {
    hit(key) {
      const ts = now();
      const bucket = buckets.get(key);
      if (!bucket || ts - bucket.start >= windowMs) {
        buckets.set(key, { start: ts, count: 1 });
        return { allowed: true, remaining: limit - 1, resetAt: ts + windowMs };
      }
      bucket.count += 1;
      if (bucket.count > limit) {
        const retryAfter = Math.ceil((bucket.start + windowMs - ts) / 1000);
        throw new ApiError(429, 'rate_limited', `Too many requests from this address; retry in ${retryAfter}s.`);
      }
      if (buckets.size > 5000) {
        for (const [k, v] of buckets) if (ts - v.start >= windowMs) buckets.delete(k);
      }
      return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.start + windowMs };
    },
    size: () => buckets.size,
  };
}

/**
 * Resolve the client address.
 *
 * X-Forwarded-For is attacker-controlled on the left: a client can prepend
 * anything. It is only trustworthy when we know how many proxies of our own sit in
 * front of the app, so `trustProxy` is the number of hops to skip from the RIGHT.
 * With TRUST_PROXY unset (0) the header is ignored entirely and the socket address
 * is used, which is the only safe default when the topology is unknown.
 *
 *   trustProxy=0  header ignored
 *   trustProxy=1  "spoofed, real-client"        -> real-client   (rightmost)
 *   trustProxy=2  "spoofed, real-client, p1"    -> real-client   (second from right)
 */
export function clientIp(headers = {}, socketAddress, { trustProxy = 0 } = {}) {
  const socket = socketAddress ?? 'unknown';
  const hops = Number.isFinite(trustProxy) ? Math.max(0, Math.trunc(trustProxy)) : 0;
  if (hops === 0) return socket;

  const forwarded = headers['x-forwarded-for'] ?? headers['X-Forwarded-For'];
  if (typeof forwarded !== 'string' || forwarded.trim() === '') return socket;

  const entries = forwarded
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) return socket;

  // Walk in from the right past our own proxies; clamp so a short header still
  // resolves to the leftmost (farthest upstream) address rather than to a proxy.
  const index = Math.max(0, entries.length - hops);
  return entries[index] ?? socket;
}

/**
 * Origin allowlist. An absent Origin is allowed because /api/track is also
 * called server-to-server (no Origin is sent); set requireOrigin to change that.
 */
export function assertOrigin(headers = {}, allowlist = [], { requireOrigin = false } = {}) {
  const origin = headers.origin ?? headers.Origin;
  if (origin === undefined) {
    if (requireOrigin) throw new ApiError(403, 'origin_required', 'This endpoint requires an Origin header.');
    return { origin: null };
  }
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    throw new ApiError(403, 'origin_not_allowed', 'No origin allowlist is configured; cross-origin calls are refused.');
  }
  const normalised = String(origin).replace(/\/$/, '');
  const match = allowlist.some((allowed) => String(allowed).replace(/\/$/, '') === normalised);
  if (!match) {
    throw new ApiError(403, 'origin_not_allowed', `Origin ${normalised} is not allowed.`);
  }
  return { origin: normalised };
}

export function parseAllowlist(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
