// Request-shaping guards: body size, per-IP rate limit, origin allowlist.

import { ApiError } from './errors.mjs';

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024; // 256 KB is generous for one event

/** Read a request body with a hard cap, so a client cannot exhaust memory. */
export async function readJsonBody(stream, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new ApiError(413, 'payload_too_large', `Body exceeds the ${maxBytes} byte limit.`);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
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

export function clientIp(headers = {}, socketAddress) {
  const forwarded = headers['x-forwarded-for'] ?? headers['X-Forwarded-For'];
  if (typeof forwarded === 'string' && forwarded.length) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return socketAddress ?? 'unknown';
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
