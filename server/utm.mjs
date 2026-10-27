// UTM link building and inspection.
//
// Shared by the API and the browser: the same function validates a campaign's
// destination in the UI (instant feedback) and server-side (the actual gate), so a
// link that the UI accepts cannot be rejected by the API for a different reason.
//
// Deliberate behaviours:
//   * existing query parameters are preserved, never dropped;
//   * an existing utm_* parameter is a conflict, not something to overwrite — silently
//     replacing a hand-set campaign value is how attribution gets destroyed;
//   * values are normalised to one convention (lowercase, hyphen-separated) and the
//     change is reported, so the UI can show what it did;
//   * nothing here claims a campaign is live. A tracking URL is a label on a link.

import { ApiError } from './errors.mjs';

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

const FIELD_FOR = {
  source: 'utm_source',
  medium: 'utm_medium',
  campaign: 'utm_campaign',
  term: 'utm_term',
  content: 'utm_content',
};

/**
 * One naming convention for every client account: lowercase, ASCII, words joined by
 * hyphens. Uppercase "Google" and lowercase "google" are different values in every
 * analytics tool, so two agencies reporting on the same channel would otherwise look
 * like two channels.
 */
export function normalizeUtmValue(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** Parse `utm_*` out of a URL. Used to detect conflicts before building anything. */
export function inspectUtm(url) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  const found = {};
  for (const key of UTM_KEYS) {
    const value = parsed.searchParams.get(key);
    if (value !== null) found[key] = value;
  }
  return found;
}

function assertDestination(destination) {
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new ApiError(400, 'missing_url', 'destinationUrl is required.');
  }
  let url;
  try {
    url = new URL(destination.trim());
  } catch {
    throw new ApiError(400, 'invalid_url', 'destinationUrl must be an absolute URL, e.g. https://example.com/pricing.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ApiError(400, 'invalid_url', 'destinationUrl must use http or https.');
  }
  if (url.username || url.password) {
    throw new ApiError(400, 'invalid_url', 'destinationUrl must not embed credentials.');
  }
  // A fragment is kept (it is part of the destination) but is never allowed to hide
  // query parameters: `/p?utm_source=x#/route` is a client-side router, and appending
  // after the fragment would put our parameters where the server never sees them.
  return url;
}

/**
 * Build a tracking URL.
 *
 * Returns { url, params, normalized, preserved } — `preserved` lists the query
 * parameters that were already on the destination and are still there, so a UI can
 * show that nothing was lost.
 */
export function buildUtmUrl({ destinationUrl, source, medium, campaign, term, content } = {}) {
  const url = assertDestination(destinationUrl);

  const existing = inspectUtm(url);
  const conflicts = Object.keys(existing);
  if (conflicts.length) {
    throw new ApiError(
      400,
      'conflicting_parameter',
      `destinationUrl already carries ${conflicts.join(', ')}. Remove it, or build the link from a clean destination, so the campaign's values are the only ones.`,
    );
  }

  const input = {
    utm_source: source,
    utm_medium: medium,
    utm_campaign: campaign,
    utm_term: term,
    utm_content: content,
  };

  const params = {};
  const normalized = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || String(value).trim() === '') continue;
    const clean = normalizeUtmValue(value);
    if (!clean) {
      throw new ApiError(400, 'invalid_utm_value', `${key} has no letters or digits after normalisation.`);
    }
    params[key] = clean;
    if (clean !== String(value)) normalized.push({ key, from: String(value), to: clean });
  }

  for (const required of ['utm_source', 'utm_medium', 'utm_campaign']) {
    if (!params[required]) {
      throw new ApiError(400, 'missing_utm', `${required} is required: without it the visit cannot be attributed.`);
    }
  }

  const preserved = [...url.searchParams.keys()];
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  return { url: url.toString(), params, normalized, preserved };
}

/** Field name for a UTM key, used by callers that report per-field errors. */
export function utmField(key) {
  return FIELD_FOR[key] ?? key;
}
