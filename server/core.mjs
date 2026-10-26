// Server core — pure, testable handlers for the Ads API integration.
// Nothing here reads process.env directly; the caller passes an env object.
// Keys NEVER reach the browser: this module only ever runs on the server.

import { ApiError } from './errors.mjs';

export { ApiError };

// Overridable so an end-to-end test can point the same code at a stub.
// Production always uses the real hosts.
const DEFAULT_ADS_BASE = 'https://api.ads.openai.com/v1';
const DEFAULT_EVENTS_BASE = 'https://bzr.openai.com/v1/events';

export const SUPPORTED_EVENTS = new Set([
  'page_viewed',
  'lead_created',
  'checkout_started',
  'order_created',
  'contents_viewed',
  'registration_completed',
  'trial_started',
  'subscription_created',
  'appointment_scheduled',
  'items_added',
  'custom',
]);

/** Standard shapes: the API requires data.type to match the event. */
export const EVENT_DATA_TYPE = {
  page_viewed: 'contents',
  contents_viewed: 'contents',
  checkout_started: 'contents',
  items_added: 'contents',
  order_created: 'contents',
  lead_created: 'customer_action',
  registration_completed: 'customer_action',
  appointment_scheduled: 'customer_action',
  app_installed: 'customer_action',
  app_opened: 'customer_action',
  subscription_created: 'plan_enrollment',
  trial_started: 'plan_enrollment',
  custom: 'custom',
};

function redact(value) {
  if (!value) return undefined;
  return value.length <= 6 ? '••••' : `${value.slice(0, 3)}…${value.slice(-2)}`;
}

export function configuration(env) {
  return {
    adsKey: Boolean(env.adsKey),
    capiKey: Boolean(env.capiKey),
    pixelId: Boolean(env.pixelId),
    adsKeyHint: redact(env.adsKey),
    live: Boolean(env.adsKey && env.pixelId),
  };
}

function requireKey(env, which) {
  const key = which === 'ads' ? env.adsKey : env.capiKey;
  if (!key) {
    throw new ApiError(
      503,
      `missing_${which}_key`,
      `No ${which === 'ads' ? 'Advertiser' : 'Conversions'} API key configured on the server.`,
    );
  }
  return key;
}

async function request(url, init, env, attempts = 3) {
  const doFetch = env.fetchImpl ?? fetch;
  // `redirect: 'error'` on purpose. These calls carry an API key in a header and the
  // response body is trusted enough to render; a provider (or anything that can answer
  // for it) must not be able to bounce the request somewhere else. Nothing in this client
  // needs a redirect, so a 3xx is an error rather than a detour.
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await doFetch(url, { redirect: 'error', ...init });
      if (res.status === 429 || res.status >= 500) {
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 300 * 2 ** i));
          continue;
        }
      }
      return res;
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
  throw new ApiError(502, 'upstream_unreachable', `Could not reach OpenAI Ads: ${String(lastError)}`);
}

async function adsGet(path, env) {
  const key = requireKey(env, 'ads');
  const res = await request(
    `${env.adsBase ?? DEFAULT_ADS_BASE}${path}`,
    { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } },
    env,
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, 'ads_error', body.error?.message ?? `Ads API ${res.status}`);
  return body;
}

async function adsPost(path, payload, env) {
  const key = requireKey(env, 'ads');
  const res = await request(
    `${env.adsBase ?? DEFAULT_ADS_BASE}${path}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    },
    env,
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, 'ads_error', body.error?.message ?? `Ads API ${res.status}`);
  return body;
}

export async function fetchAccount(env) {
  const account = await adsGet('/ad_account', env);
  return {
    id: account.id,
    name: account.name,
    status: account.status,
    currency: account.currency_code,
    timezone: account.timezone,
    review: account.review?.status ?? 'unknown',
  };
}

export async function listCampaigns(env) {
  const campaigns = [];
  let after;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (after) qs.set('after', after);
    const body = await adsGet(`/campaigns?${qs.toString()}`, env);
    const data = body.data ?? [];
    campaigns.push(...data);
    if (!body.has_more || !data.length) break;
    after = body.last_id;
  }
  return campaigns;
}

export async function listAdGroups(env, campaignId) {
  const qs = new URLSearchParams({ campaign_id: campaignId, limit: '200' });
  const body = await adsGet(`/ad_groups?${qs.toString()}`, env);
  return body.data ?? [];
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export function dateRange(days, today = new Date()) {
  const until = new Date(today);
  const since = new Date(today);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return { since: isoDate(since), until: isoDate(until) };
}

/**
 * Insights API: one segment per request. We use `daily` granularity so the
 * freshness/lag behaviour stays visible instead of being smoothed away.
 */
export async function fetchInsights(env, opts = {}) {
  const days = opts.days ?? 90;
  const { since, until } = dateRange(days);
  const timezone = env.accountTimezone ?? 'Asia/Kolkata';
  const aggregation = opts.aggregation ?? 'campaign';

  // The ad-group report asks for both ids: campaign_id is what links an ad-group row
  // back to its campaign, and asking for it explicitly is better than inferring it.
  // (Whether the API returns a parent id at ad_group level is unverified — the
  // dataset loader falls back to the ad-group list when it does not.)
  const idFields =
    aggregation === 'ad_group'
      ? ['ad_group_id', 'ad_group_name', 'campaign_id', 'campaign_name']
      : ['campaign_id', 'campaign_name'];

  const fields = [
    ...idFields,
    'readable_time',
    'impressions',
    'clicks',
    'spend',
    'ctr',
    'cpc',
    'conversions',
    'click_through_conversions',
    'view_through_conversions',
    'order_created_attributed_sales',
  ];

  const qs = new URLSearchParams();
  qs.set('aggregation_level', aggregation);
  qs.set('time_granularity', 'daily');
  qs.set('time_ranges[]', JSON.stringify({ type: 'date_range', since, until, timezone }));
  if (opts.segment) qs.set('segments[]', opts.segment);
  // A segmented report must request segment-prefixed metrics plus the segment
  // name itself; append, never set, or the earlier fields are dropped.
  for (const f of fields) qs.append('fields[]', opts.segment ? `${opts.segment}.${f}` : f);
  if (opts.segment) qs.append('fields[]', `${opts.segment}.name`);

  const body = await adsGet(`/ad_account/insights?${qs.toString()}`, env);
  return { timezone, currency: body.account_currency ?? 'INR', rows: body.data ?? [] };
}

function num(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map an Insights payload into the app's Dataset. Everything OpenAI reports is
 * native attribution; first-party columns stay at zero and the Dataset says so,
 * so the UI never presents a ₹0 CPL as if it were real.
 */
export function mapInsightsToDataset(payload, opts = {}) {
  const rows = payload.rows.map((r) => {
    const spendMajor = num(r.spend);
    const conversions = num(r.conversions);
    const viewThrough = num(r.view_through_conversions);
    return {
      date: String(r.readable_time ?? '').slice(0, 10),
      campaignId: String(r.campaign_id ?? ''),
      // Never fall back to the campaign id: a campaign-level report has no ad group,
      // and pretending it does invents per-ad-group metrics that do not exist.
      adGroupId: String(r.ad_group_id ?? ''),
      country: String(r.country ?? 'ALL'),
      device: String(r.device ?? 'ALL'),
      platform: 'web',
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      // Money lands in the browser as integer minor units, always.
      spendMinor: Math.round(spendMajor * 100),
      conversionsNative: conversions,
      viewThrough,
      leads: 0,
      customers: 0,
      salesMinor: 0,
    };
  });

  const campaignIds = [...new Set(rows.map((r) => r.campaignId).filter(Boolean))];
  return {
    generatedAt: new Date().toISOString(),
    endDate: rows.length
      ? rows
          .map((r) => r.date)
          .sort()
          .at(-1)
      : isoDate(new Date()),
    currency: payload.currency,
    timezone: payload.timezone,
    firstPartyAvailable: Boolean(opts.firstPartyAvailable),
    aggregation: opts.aggregation ?? (rows.some((r) => r.adGroupId) ? 'ad_group' : 'campaign'),
    campaigns: campaignIds.map((id) => ({
      id,
      name: id,
      objective: 'clicks',
      status: 'active',
      dailyBudgetMinor: 0,
      goalEvent: 'lead_created',
    })),
    adGroups: [],
    rows,
  };
}

/** Verify the key the way the docs suggest: GET /ad_account. */
export async function health(env) {
  const config = configuration(env);
  if (!config.live) {
    return {
      ok: false,
      mode: 'demo',
      configuration: config,
      reason: 'No Advertiser API key and Pixel ID on the server.',
    };
  }
  try {
    const account = await fetchAccount(env);
    return { ok: true, mode: 'live', configuration: config, account };
  } catch (error) {
    const e = error;
    return { ok: false, mode: 'error', configuration: config, reason: e.message, code: e.code ?? 'unknown' };
  }
}

/**
 * Consent-gated intake. The browser posts here; only this function talks to
 * bzr.openai.com. `event_id` must be identical to the Pixel's event_id so the
 * two copies dedupe (pixel id + event name + id, first event wins).
 */
export async function track(input, env) {
  if (!input.consent) throw new ApiError(403, 'consent_required', 'No measurement consent on record; event dropped.');
  if (!input.eventId) throw new ApiError(400, 'missing_event_id', 'event_id is required for deduplication.');
  if (!SUPPORTED_EVENTS.has(input.eventName))
    throw new ApiError(400, 'unsupported_event', `Unsupported event: ${input.eventName}`);

  const payload = {
    id: input.eventId,
    type: input.eventName,
    timestamp_ms: input.timestampMs ?? Date.now(),
    action_source: 'web',
    source_url: input.sourceUrl,
  };
  if (input.oppref) payload.oppref = input.oppref; // never modified
  const data = { type: EVENT_DATA_TYPE[input.eventName] };
  if (input.amountMinor !== undefined) {
    if (!input.currency) throw new ApiError(400, 'missing_currency', 'amount requires a currency.');
    data.amount = Math.round(input.amountMinor); // already minor units
    data.currency = input.currency;
  }
  payload.data = data;
  if (input.user && Object.keys(input.user).length) {
    payload.user = {
      ...(input.obref ? { obref: input.obref } : {}),
      ...(input.user.emailsSha256 ? { emails_sha256: input.user.emailsSha256 } : {}),
      ...(input.user.externalIdsSha256 ? { external_ids_sha256: input.user.externalIdsSha256 } : {}),
      ...(input.user.countries ? { countries: input.user.countries } : {}),
      ...(input.user.cities ? { cities: input.user.cities } : {}),
      ...(input.user.ipAddress ? { ip_address: input.user.ipAddress } : {}),
    };
  } else if (input.obref) {
    payload.user = { obref: input.obref };
  }

  const capiKey = requireKey(env, 'capi');
  if (!env.pixelId) throw new ApiError(503, 'missing_pixel_id', 'No Pixel ID configured on the server.');

  const res = await request(
    `${env.eventsBase ?? DEFAULT_EVENTS_BASE}?pid=${encodeURIComponent(env.pixelId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${capiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [payload] }),
    },
    env,
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, 'capi_error', body.error?.message ?? `Conversions API ${res.status}`);
  }
  return { accepted: true, eventId: input.eventId, eventName: input.eventName };
}

/**
 * Push a hint set onto an ad group. Returns the previous set so the caller can
 * offer a one-click rollback.
 */
export async function pushHintSet(adGroupId, hints, env) {
  if (!Array.isArray(hints) || hints.length === 0)
    throw new ApiError(400, 'empty_hints', 'Refusing to push an empty hint set.');
  if (hints.length > 2000)
    throw new ApiError(400, 'too_many_hints', 'The API caps context hints at 2,000 per ad group.');
  for (const h of hints) {
    if (typeof h !== 'string' || !h.trim())
      throw new ApiError(400, 'bad_hint', 'Every hint must be a non-empty string.');
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(h)) throw new ApiError(400, 'pii_in_hint', 'A hint contains an email address.');
  }

  const before = await adsGet(`/ad_groups/${encodeURIComponent(adGroupId)}`, env);
  const updated = await adsPost(`/ad_groups/${encodeURIComponent(adGroupId)}`, { context_hints: hints }, env);
  const after = await adsGet(`/ad_groups/${encodeURIComponent(adGroupId)}`, env);
  return {
    adGroupId,
    previousHints: before.context_hints ?? [],
    pushedHints: after.context_hints ?? updated.context_hints ?? hints,
    versionedAt: new Date().toISOString(),
  };
}
