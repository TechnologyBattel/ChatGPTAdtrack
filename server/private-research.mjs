// Private research: model-assisted *naming* of clusters that the deterministic pipeline in
// src/lib/research.ts has already computed.
//
// Scope, in one line: one provider call per request, using the caller's own key, returning
// names for ids we were given — and nothing else.
//
// Four rules hold this file together, and each has a test that fails if it stops being true:
//
//   1. THE KEY IS A FUNCTION ARGUMENT. It arrives in `input.apiKey`, lives in this call
//      frame, and is dropped when the function returns. It is never placed on a long-lived
//      object, never cached by actor or organization, never written to a log, never put in
//      an error message and never returned. `handler.mjs` logs 5xx exception messages
//      verbatim, so every failure below is converted to an ApiError with a FIXED message.
//
//   2. NOTHING IS PERSISTED. This module performs no store writes at all. The single audit
//      record is written by the caller (server/agency.mjs) through tenancy.audit, from the
//      allowlisted payload built by `auditDetail()` below.
//
//   3. THE MODEL ONLY NAMES. It receives ids and returns ids. Every returned id must be one
//      we sent, exactly once; anything else rejects the whole response. It cannot add,
//      remove, reorder, merge or re-scope clusters, and it never touches scores, validation
//      or hints — none of which are sent to it.
//
//   4. NAMED HOSTS ONLY. The provider host and model come from configuration. There is no
//      field for a URL anywhere in the schema, and a caller-supplied one has nowhere to go.

import { ApiError } from './errors.mjs';
import { createRateLimiter } from './limits.mjs';

/** The only path family this feature owns. Exported so app.mjs can gate it before auth. */
export const PRIVATE_PATH = /^\/api\/orgs\/[^/]+\/research\/private(?:\/run)?$/;

/** Fixed provider hosts. A caller cannot influence either value. */
const PROVIDER_HOSTS = Object.freeze({
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
});

/**
 * Fixed internal error codes. The audit entry may carry exactly one of these, and nothing
 * else, ever. Arbitrary strings are refused by `auditDetail()`.
 */
export const PRIVATE_ERROR_CODES = Object.freeze([
  'provider_key_rejected',
  'provider_throttled',
  'provider_unavailable',
  'provider_timeout',
  'invalid_provider_output',
  'invalid_request',
  'invalid_provider',
  'invalid_model',
  'busy',
  'rate_limited',
  'audit_unavailable',
  'internal_error',
]);

const OUTCOMES = Object.freeze(['ok', 'provider_error', 'invalid_output', 'timeout', 'rejected']);

const MAX_SEEDS_PER_CLUSTER = 200;
const MAX_SEED_CHARS = 300;
const MAX_LABEL_CHARS = 120;
const MAX_NAME_CHARS = 80;

/** What a mis-shaped body from a caller looks like: our own error, never theirs. */
function invalid(message) {
  return new ApiError(400, 'invalid_request', message);
}

/**
 * Build the audit `detail` object. This is the ONLY place that shape is assembled, and it
 * refuses anything outside the approved schema — including extra keys and arbitrary
 * `errorCode` strings — so a caller cannot smuggle content into the audit trail by adding a
 * field. Deliberately does not spread any input object.
 */
export function auditDetail(input = {}) {
  const { provider, model, clusterCount, outcome, errorCode } = input;
  const allowed = new Set(['provider', 'model', 'clusterCount', 'outcome', 'errorCode']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`audit detail: unexpected field "${key}"`);
  }
  if (!(provider in PROVIDER_HOSTS)) throw new Error('audit detail: provider must be a known provider');
  if (typeof model !== 'string' || model.length === 0) throw new Error('audit detail: model is required');
  if (!Number.isInteger(clusterCount) || clusterCount < 1) {
    throw new Error('audit detail: clusterCount must be a positive integer');
  }
  if (!OUTCOMES.includes(outcome)) throw new Error('audit detail: outcome is not an approved value');

  const detail = { provider, model, clusterCount, outcome };
  if (errorCode !== undefined) {
    if (!PRIVATE_ERROR_CODES.includes(errorCode)) {
      throw new Error('audit detail: errorCode is not an approved code');
    }
    // `outcome: 'ok'` and an error code are mutually exclusive: a run either worked or did not.
    if (outcome === 'ok') throw new Error('audit detail: errorCode is not allowed on a successful run');
    detail.errorCode = errorCode;
  }
  return detail;
}

/** Shape check only. This is not authentication and it does not validate the key. */
function keyLooksValid(provider, apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length < 20 || apiKey.length > 400) return false;
  if (/\s/.test(apiKey)) return false;
  return provider === 'anthropic' ? apiKey.startsWith('sk-ant-') : apiKey.startsWith('sk-');
}

/**
 * Validate the caller's clusters. Strict: unknown keys are refused rather than ignored, so a
 * caller cannot add a field that later code might start honouring by accident.
 */
function validateClusters(clusters, maxClusters) {
  if (!Array.isArray(clusters) || clusters.length === 0) {
    throw invalid('clusters must be a non-empty array.');
  }
  if (clusters.length > maxClusters) {
    throw invalid(`Too many clusters: at most ${maxClusters} per request.`);
  }
  const seen = new Set();
  const out = [];
  for (const cluster of clusters) {
    if (!cluster || typeof cluster !== 'object' || Array.isArray(cluster)) {
      throw invalid('Each cluster must be an object.');
    }
    for (const key of Object.keys(cluster)) {
      if (!['id', 'label', 'seeds'].includes(key)) {
        throw invalid(`Unexpected cluster field "${key}".`);
      }
    }
    if (typeof cluster.id !== 'string' || cluster.id.length === 0 || cluster.id.length > 100) {
      throw invalid('Each cluster needs a non-empty string id.');
    }
    if (seen.has(cluster.id)) throw invalid('Cluster ids must be unique.');
    seen.add(cluster.id);

    if (cluster.label !== undefined && (typeof cluster.label !== 'string' || cluster.label.length > MAX_LABEL_CHARS)) {
      throw invalid('A cluster label must be a short string.');
    }
    if (!Array.isArray(cluster.seeds) || cluster.seeds.length === 0) {
      throw invalid('Each cluster needs at least one seed.');
    }
    if (cluster.seeds.length > MAX_SEEDS_PER_CLUSTER) {
      throw invalid(`At most ${MAX_SEEDS_PER_CLUSTER} seeds per cluster.`);
    }
    const seeds = [];
    for (const seed of cluster.seeds) {
      if (typeof seed !== 'string' || seed.length === 0 || seed.length > MAX_SEED_CHARS) {
        throw invalid('Each seed must be a short non-empty string.');
      }
      seeds.push(seed);
    }
    out.push({ id: cluster.id, label: cluster.label ?? '', seeds });
  }
  return out;
}

/** The prompt. It carries the seeds (that is the point) and nothing else from our system. */
function buildPrompt(clusters) {
  const payload = clusters.map((c) => ({ id: c.id, label: c.label, seeds: c.seeds }));
  return [
    'You are naming groups of search/advertising queries that have already been clustered.',
    'For each group, write one short human-readable name (max 8 words, no quotes, no emoji).',
    'Do not merge, split, reorder or invent groups. Use exactly the ids provided.',
    'Reply with JSON only, shaped exactly like: {"names":[{"id":"...","name":"..."}]}',
    'Groups:',
    JSON.stringify(payload),
  ].join('\n');
}

/**
 * Pull the names array out of a provider response, all-or-nothing.
 *
 * Every rejection here is the same: the whole response is refused and the caller keeps the
 * deterministic names it already had. There is no partial application, because a half-applied
 * set is how ids and membership drift apart.
 */
function extractNames(provider, body, expectedIds) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApiError(502, 'invalid_provider_output', 'The provider did not return valid JSON.');
  }

  let text;
  if (provider === 'openai') {
    text = parsed?.choices?.[0]?.message?.content;
  } else {
    text = parsed?.content?.[0]?.text;
  }
  if (typeof text !== 'string') {
    throw new ApiError(502, 'invalid_provider_output', 'The provider response had no text content.');
  }

  // The model may wrap JSON in a fence even when told not to. Unwrapping a fence is safe;
  // guessing at prose is not, so anything else is refused.
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new ApiError(502, 'invalid_provider_output', 'The provider did not return a JSON object.');
  }

  const names = data?.names;
  if (!Array.isArray(names)) {
    throw new ApiError(502, 'invalid_provider_output', 'The provider response had no names array.');
  }
  if (names.length !== expectedIds.size) {
    throw new ApiError(502, 'invalid_provider_output', 'The provider returned the wrong number of names.');
  }

  const out = [];
  const seen = new Set();
  for (const entry of names) {
    if (!entry || typeof entry !== 'object') {
      throw new ApiError(502, 'invalid_provider_output', 'A name entry was not an object.');
    }
    const { id, name } = entry;
    if (typeof id !== 'string' || !expectedIds.has(id)) {
      throw new ApiError(502, 'invalid_provider_output', 'The provider returned an id that was not sent.');
    }
    if (seen.has(id)) throw new ApiError(502, 'invalid_provider_output', 'The provider returned a duplicate id.');
    if (typeof name !== 'string') throw new ApiError(502, 'invalid_provider_output', 'A name was not a string.');
    // Strip control characters without a control-character regex: they have no place in a
    // display name, and building the filter by code point keeps the linter honest.
    const clean = [...name]
      .map((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code < 32 || code === 127 ? ' ' : ch;
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length === 0 || clean.length > MAX_NAME_CHARS) {
      throw new ApiError(502, 'invalid_provider_output', 'A name was empty or too long.');
    }
    seen.add(id);
    out.push({ id, name: clean });
  }
  if (seen.size !== expectedIds.size) {
    throw new ApiError(502, 'invalid_provider_output', 'The provider omitted one or more ids.');
  }
  // Preserve the caller's order: the model's ordering carries no meaning and must not
  // become a side channel into the cluster list.
  out.sort((a, b) => [...expectedIds].indexOf(a.id) - [...expectedIds].indexOf(b.id));
  return out;
}

/** Map an upstream status to our own fixed, coded error. Never forwards their body. */
function mapProviderStatus(provider, status) {
  if (status === 401 || status === 403) {
    return new ApiError(401, 'provider_key_rejected', 'The provider rejected that API key.');
  }
  if (status === 429) {
    return new ApiError(429, 'provider_throttled', 'The provider is throttling requests for that key.');
  }
  if (status >= 500) {
    return new ApiError(502, 'provider_unavailable', `The ${provider} API is unavailable.`);
  }
  // Remaining 4xx are almost always a request the provider dislikes (unknown model, quota,
  // malformed body). The reason is theirs, may quote the request, and is therefore dropped.
  return new ApiError(502, 'provider_unavailable', `The ${provider} API refused the request.`);
}

export function createPrivateResearch({
  enabled = false,
  providers = ['openai'],
  models = { openai: [], anthropic: [] },
  timeoutMs = 20000,
  maxClusters = 40,
  maxResponseBytes = 262144,
  perMinute = 20,
  fetchImpl = null,
  now = () => Date.now(),
} = {}) {
  const limiter = createRateLimiter({ limit: perMinute, windowMs: 60_000, now });
  // One in-flight run per actor, per process. This is a politeness and blast-radius guard,
  // not a quota: it stops a double-click from buying two paid calls.
  const inFlight = new Set();

  function status() {
    return { enabled: true, providers: [...providers] };
  }

  async function run({ actor, provider, model, apiKey, clusters } = {}) {
    // --- validation (no provider call, and no key retention, before this point) ---------
    if (!providers.includes(provider)) {
      throw new ApiError(400, 'invalid_provider', 'That provider is not enabled on this server.');
    }
    const allowedModels = models[provider] ?? [];
    if (!allowedModels.includes(model)) {
      throw new ApiError(400, 'invalid_model', 'That model is not allowlisted for this provider.');
    }
    const safeClusters = validateClusters(clusters, maxClusters);
    if (!keyLooksValid(provider, apiKey)) {
      throw new ApiError(400, 'invalid_request', 'That does not look like an API key for this provider.');
    }

    const limit = limiter.hit(String(actor ?? 'anonymous'));
    if (!limit.allowed) {
      const error = new ApiError(429, 'rate_limited', 'Too many private research runs. Try again shortly.');
      error.retryAfterSeconds = Math.max(1, Math.ceil((limit.resetAt - now()) / 1000));
      throw error;
    }
    const actorKey = String(actor ?? 'anonymous');
    if (inFlight.has(actorKey)) {
      throw new ApiError(429, 'busy', 'A private research run is already in progress.');
    }

    inFlight.add(actorKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const doFetch = fetchImpl ?? fetch;
      const url =
        provider === 'openai'
          ? `${PROVIDER_HOSTS.openai}/v1/chat/completions`
          : `${PROVIDER_HOSTS.anthropic}/v1/messages`;
      const prompt = buildPrompt(safeClusters);
      const body =
        provider === 'openai'
          ? {
              model,
              messages: [
                { role: 'system', content: 'You name pre-clustered query groups. Reply with JSON only.' },
                { role: 'user', content: prompt },
              ],
              response_format: { type: 'json_object' },
              temperature: 0,
            }
          : {
              model,
              max_tokens: 1500,
              messages: [{ role: 'user', content: prompt }],
            };
      const headers =
        provider === 'openai'
          ? { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
          : {
              'content-type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            };

      let response;
      try {
        // `redirect: 'error'` for the same reason server/core.mjs uses it: this request
        // carries a credential, so a 3xx must be an error rather than a detour to a host we
        // did not choose.
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new ApiError(504, 'provider_timeout', 'The provider did not answer in time.');
        }
        // The thrown error may quote the request (headers included), so its text is dropped.
        throw new ApiError(502, 'provider_unavailable', `Could not reach the ${provider} API.`);
      }

      if (!response.ok) throw mapProviderStatus(provider, response.status);

      const raw = await response.text();
      if (raw.length > maxResponseBytes) {
        throw new ApiError(502, 'invalid_provider_output', 'The provider response was too large.');
      }

      const expectedIds = new Set(safeClusters.map((c) => c.id));
      const names = extractNames(provider, raw, expectedIds);
      return { names, provider, model };
    } finally {
      clearTimeout(timer);
      inFlight.delete(actorKey);
    }
  }

  // `models` is exposed so the route can decide which audit outcome a rejection belongs to
  // without duplicating the allowlist logic here.
  return { enabled, status, run, auditDetail, models };
}
