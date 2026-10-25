// Field validation for everything that crosses a trust boundary.
//
// One module so the rules cannot drift between routes: a workspace's currency and an
// event's currency are checked by the same function, so "USD" is either valid
// everywhere or nowhere.
//
// Conventions: every function either returns the normalised value or throws an
// ApiError with a stable code and a field name. Messages never echo the rejected
// value back when it might be a secret; they name the field instead.

import { ApiError } from './errors.mjs';

const bad = (code, message) => new ApiError(400, code, message);

/** Two-letter ISO-3166-1 alpha-2. Upper-cased, because "in" and "IN" are one country. */
export function countryCode(value, field = 'country_code') {
  if (value === undefined || value === null || value === '') return null;
  const code = String(value).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw bad('invalid_country_code', `${field} must be a two-letter ISO-3166-1 code (e.g. IN, US).`);
  }
  return code;
}

/**
 * IANA time zone. Validated by asking Intl, not by a hard-coded list: the tz database
 * changes and a stale list would reject valid zones (or accept retired ones).
 */
export function timeZone(value, field = 'time_zone') {
  if (value === undefined || value === null || value === '') {
    throw bad('missing_time_zone', `${field} is required (an IANA zone such as Asia/Kolkata).`);
  }
  const zone = String(value).trim();

  // "IST", "EST" and "PST" are ambiguous abbreviations (IST alone is India, Israel and
  // Ireland). Intl accepts several of them as legacy aliases, which is exactly the
  // silent-wrong-time-zone bug this project exists to avoid, so the *shape* is checked
  // before Intl is asked: Area/Location, or UTC.
  const isIanaName = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/.test(zone);
  if (!isIanaName && !['UTC', 'Etc/UTC'].includes(zone)) {
    throw bad('invalid_time_zone', `${field} must be an IANA zone like Asia/Kolkata, not "${zone}".`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw bad('invalid_time_zone', `${field} is not a known IANA time zone.`);
  }
  return zone;
}

/**
 * ISO-4217 currency. Intl resolves the code, so a three-letter string that is not a
 * real currency ("XYZ") is refused instead of quietly formatting as "XYZ 12.00".
 */
export function currencyCode(value, field = 'currency') {
  if (value === undefined || value === null || value === '') {
    throw bad('missing_currency', `${field} is required (an ISO-4217 code such as INR).`);
  }
  const code = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw bad('invalid_currency', `${field} must be a three-letter ISO-4217 code.`);
  }
  // Intl formats ANY three-letter code without complaint ("XYZ 1.00"), so membership in
  // the ISO list is what actually validates it. supportedValuesOf is the ICU list.
  try {
    const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : null;
    if (supported && !supported.includes(code)) {
      throw bad('invalid_currency', `${field} is not an ISO-4217 currency.`);
    }
    const resolved = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions().currency;
    if (resolved !== code) throw bad('invalid_currency', `${field} is not an ISO-4217 currency.`);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw bad('invalid_currency', `${field} is not a currency this server recognises.`);
  }
  return code;
}

/** BCP-47 language tag, canonicalised ("en-in" → "en-IN"). */
export function languageTag(value, field = 'default_language') {
  if (value === undefined || value === null || value === '') {
    throw bad('missing_language', `${field} is required (a BCP-47 tag such as en or pt-BR).`);
  }
  const tag = String(value).trim();
  try {
    // Intl.Locale canonicalises and rejects nonsense; toString() gives en-IN, not en-in.
    return new Intl.Locale(tag.replace('_', '-')).toString();
  } catch {
    throw bad('invalid_language', `${field} must be a BCP-47 language tag.`);
  }
}

/**
 * An instant, kept twice.
 *
 * `ms` is the UTC epoch used for ordering, windows and retention. `raw` is the string
 * the sender wrote, kept verbatim so a report can be reproduced in the source's own
 * offset after the fact — normalising on write only, never losing the original.
 *
 * A timestamp with no offset is refused: "2026-10-25T10:00:00" is ambiguous by up to
 * 26 hours across the world, and guessing the server's zone is exactly the bug this
 * project is trying to avoid.
 */
export function isoInstant(value, field = 'occurred_at') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw bad('missing_timestamp', `${field} is required as an ISO-8601 timestamp with an offset.`);
  }
  const raw = value.trim();
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    throw bad('ambiguous_timestamp', `${field} must include a UTC offset (Z or ±HH:MM); a local time is ambiguous.`);
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw bad('invalid_timestamp', `${field} is not a valid ISO-8601 timestamp.`);
  if (ms > Date.now() + 24 * 60 * 60 * 1000) {
    throw bad('timestamp_in_future', `${field} is more than a day in the future.`);
  }
  return { ms, raw };
}

/** https/http URL without credentials, length-capped. Used for landing pages and sources. */
export function webUrl(value, field = 'url', { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    throw bad('missing_url', `${field} is required.`);
  }
  if (typeof value !== 'string' || value.length > 2048) throw bad('invalid_url', `${field} is not a usable URL.`);
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw bad('invalid_url', `${field} must be an absolute URL.`);
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw bad('invalid_url', `${field} must use http or https.`);
  }
  if (url.username || url.password) {
    throw bad('invalid_url', `${field} must not embed credentials.`);
  }
  if (!url.hostname) throw bad('invalid_url', `${field} has no host.`);
  return url.toString();
}

/** A short, opaque identifier: what we accept as an event id or a record reference. */
export function idToken(value, field, { max = 128, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    throw bad('missing_id', `${field} is required.`);
  }
  const id = String(value).trim();
  if (id.length > max) throw bad('invalid_id', `${field} is longer than ${max} characters.`);
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw bad('invalid_id', `${field} may contain only letters, digits, dot, colon, dash and underscore.`);
  }
  return id;
}

/** Free text with a length cap; control characters stripped, whitespace collapsed. */
export function text(value, field, { max = 500, required = true, min = 1 } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw bad('missing_field', `${field} is required.`);
  }
  const clean = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length < min) {
    if (!required && clean.length === 0) return null;
    throw bad('invalid_field', `${field} must be at least ${min} character(s).`);
  }
  if (clean.length > max) throw bad('field_too_long', `${field} must be at most ${max} characters.`);
  return clean;
}

/** Escape hatch for allow-lists: returns the value only when it is one of `allowed`. */
export function oneOf(value, allowed, field) {
  const list = allowed instanceof Set ? [...allowed] : allowed;
  if (!list.includes(value)) {
    throw bad('invalid_value', `${field} must be one of: ${list.join(', ')}.`);
  }
  return value;
}

/**
 * Reject keys the contract does not define.
 *
 * Without this, a typo (`amountMinor` vs `amount_minor`) is silently dropped, and a
 * smuggled field (`qualified: true`) is silently stored. Failing loudly is the only
 * way a schema stays true.
 */
export function assertKnownKeys(object, allowed, label = 'body') {
  const unknown = Object.keys(object ?? {}).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw bad('unknown_field', `${label} has unknown field(s): ${unknown.join(', ')}.`);
  }
}
