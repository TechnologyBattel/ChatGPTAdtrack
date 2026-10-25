// The qualified-lead event contract (schema_version 2) and its ingest path.
//
// This extends the existing ingest rather than replacing it: `/api/events` still
// accepts the v1 body shape for the single-account demo, and switches to this module
// when the body declares `schema_version: "2"`.
//
// Two properties matter more than anything else here:
//
//   1. THE TENANT COMES FROM THE KEY, NOT THE BODY. A v2 event is signed with a key
//      that belongs to exactly one source connection, which belongs to exactly one
//      workspace. The workspace is read from that record, so a body claiming another
//      workspace is either ignored (no such field) or rejected as a mismatch. There is
//      no code path where the caller picks its own tenant.
//
//   2. A CLIENT NEVER DECLARES QUALIFICATION OR REVENUE. `lead_qualified` from a
//      trusted CRM source or a human on the API is the only way a lead becomes
//      qualified; amounts are accepted only on server-authoritative event types.

import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { assertKnownKeys, currencyCode, countryCode, idToken, isoInstant, text, webUrl } from './validate.mjs';

export const EVENT_SCHEMA_VERSION = 2;

/**
 * The normalised lifecycle. Not every customer emits every step; a missing step is
 * "unavailable", never a zero.
 */
export const EVENT_TYPES = [
  'landing_visit',
  'campaign_attributed_visit',
  'enquiry_submitted',
  'lead_created',
  'lead_qualified',
  'appointment_scheduled',
  'order_created',
  'refund_or_cancellation',
];

/** Types that create or update a lead record. */
export const LEAD_EVENT_TYPES = new Set(['enquiry_submitted', 'lead_created']);

/** Types that may carry money. Everything else must not. */
export const MONEY_EVENT_TYPES = new Set(['order_created', 'refund_or_cancellation']);

/** Types a browser may never send, whatever key it holds. */
export const SERVER_ONLY_EVENT_TYPES = new Set([
  'lead_created',
  'lead_qualified',
  'appointment_scheduled',
  'order_created',
  'refund_or_cancellation',
]);

const ALLOWED_KEYS = [
  'schema_version',
  'event_id',
  'event_type',
  'occurred_at',
  'event_source',
  'workspace_id',
  'source_connection_id',
  'campaign_id',
  'anonymous_session_id',
  'landing_url',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'country_code',
  'region',
  'city',
  'consent_state',
  'crm_record_reference',
  'currency',
  'amount_minor',
  'metadata',
];

/**
 * Fields that would let a sender assert an outcome it cannot know. Rejected by name,
 * not silently dropped: a sender that believes it is reporting a qualified lead should
 * be told why it is not.
 */
const FORBIDDEN_KEYS = {
  qualification: 'Qualification is a human or CRM decision made through the API, not an event field.',
  qualified: 'A sender cannot mark a lead qualified; that is a separate, audited decision.',
  qualified_at: 'A sender cannot mark a lead qualified; that is a separate, audited decision.',
  revenue: 'Revenue is derived from amount_minor on a money event type, never asserted directly.',
  revenue_minor: 'Revenue is derived from amount_minor on a money event type, never asserted directly.',
  organization_id: 'The organization is derived from the ingest key, never from the body.',
  received_at: 'received_at is assigned by this server; a sender cannot choose it.',
  ingested_at: 'ingested_at is assigned by this server; a sender cannot choose it.',
};

/** Deterministic document id: replaying the same event lands on the same document. */
export function eventDocumentId({ workspaceId, eventId }) {
  return `evt_${createHash('sha256').update(`${workspaceId}:${eventId}`).digest('hex').slice(0, 40)}`;
}

/**
 * Validate and normalise a v2 event body.
 *
 * Pure and synchronous: nothing here reads the clock except to stamp `receivedAt` from
 * the injected `now`, so a test can pin every timestamp.
 */
export function validateEventV2(body, { now = () => Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_body', 'The event body must be a JSON object.');
  }
  for (const [key, reason] of Object.entries(FORBIDDEN_KEYS)) {
    if (body[key] !== undefined) throw new ApiError(400, 'forbidden_field', `${key} is not accepted: ${reason}`);
  }
  if (body.schema_version !== EVENT_SCHEMA_VERSION && body.schema_version !== String(EVENT_SCHEMA_VERSION)) {
    throw new ApiError(400, 'unsupported_schema_version', `schema_version must be ${EVENT_SCHEMA_VERSION}.`);
  }
  assertKnownKeys(body, ALLOWED_KEYS, 'event');

  const eventType = body.event_type;
  if (!EVENT_TYPES.includes(eventType)) {
    throw new ApiError(400, 'unsupported_event_type', `event_type must be one of: ${EVENT_TYPES.join(', ')}.`);
  }

  const eventSource = body.event_source;
  if (!['server', 'crm'].includes(eventSource)) {
    throw new ApiError(
      403,
      'browser_event_not_allowed',
      'A browser may not post a v2 event. Use the consent-gated /api/track for page views; leads and outcomes come from a server or CRM.',
    );
  }
  if (SERVER_ONLY_EVENT_TYPES.has(eventType) && eventSource === 'browser') {
    throw new ApiError(403, 'browser_event_not_allowed', 'A browser may not report this event type.');
  }

  const occurred = isoInstant(body.occurred_at, 'occurred_at');
  const consentState = body.consent_state ?? 'unknown';
  if (!['granted', 'denied', 'unknown'].includes(consentState)) {
    throw new ApiError(400, 'invalid_consent_state', 'consent_state must be granted, denied or unknown.');
  }

  // City is the finest location we will store, and only with a live consent basis:
  // coarse country/region reporting does not need it, and it is personal data.
  const city = body.city ? text(body.city, 'city', { max: 120 }) : null;
  if (city && consentState !== 'granted') {
    throw new ApiError(
      400,
      'city_requires_consent',
      'city is only stored when consent_state is "granted"; report country_code instead.',
    );
  }

  const money = body.amount_minor;
  if (money !== undefined && money !== null) {
    if (!MONEY_EVENT_TYPES.has(eventType)) {
      throw new ApiError(
        400,
        'amount_not_allowed',
        `amount_minor is only valid on ${[...MONEY_EVENT_TYPES].join(' or ')}; "${eventType}" carries no money.`,
      );
    }
    if (!Number.isSafeInteger(money) || money < 0) {
      throw new ApiError(400, 'invalid_amount', 'amount_minor must be a non-negative integer in minor units.');
    }
    if (money > 1e12) throw new ApiError(400, 'invalid_amount', 'amount_minor is implausibly large.');
  }

  const currency = body.currency ? currencyCode(body.currency) : null;
  if (money !== undefined && !currency) {
    throw new ApiError(400, 'missing_currency', 'amount_minor requires currency.');
  }
  if (currency && money === undefined) {
    throw new ApiError(400, 'amount_required_with_currency', 'currency was supplied without an amount.');
  }

  const utm = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    if (body[key] === undefined || body[key] === null || body[key] === '') continue;
    utm[key] = text(body[key], key, { max: 256 });
  }

  const metadata = body.metadata ?? null;
  if (metadata !== null) {
    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new ApiError(400, 'invalid_metadata', 'metadata must be an object.');
    }
    if (JSON.stringify(metadata).length > 4096) {
      throw new ApiError(400, 'metadata_too_large', 'metadata must be under 4 KB.');
    }
  }

  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: idToken(body.event_id, 'event_id'),
    eventType,
    occurredAt: occurred.ms,
    occurredAtRaw: occurred.raw,
    receivedAt: now(),
    eventSource,
    workspaceIdClaim: body.workspace_id ? idToken(body.workspace_id, 'workspace_id') : null,
    sourceConnectionIdClaim: body.source_connection_id
      ? idToken(body.source_connection_id, 'source_connection_id')
      : null,
    campaignId: body.campaign_id ? idToken(body.campaign_id, 'campaign_id', { max: 128 }) : null,
    anonymousSessionId: body.anonymous_session_id ? idToken(body.anonymous_session_id, 'anonymous_session_id') : null,
    landingUrl: webUrl(body.landing_url, 'landing_url', { required: false }),
    referrer: webUrl(body.referrer, 'referrer', { required: false }),
    utm,
    countryCode: countryCode(body.country_code, 'country_code'),
    region: body.region ? text(body.region, 'region', { max: 120 }) : null,
    city,
    consentState,
    crmRecordReference: body.crm_record_reference
      ? idToken(body.crm_record_reference, 'crm_record_reference', { max: 200 })
      : null,
    currency,
    amountMinor: money === undefined || money === null ? null : money,
    metadata,
  };
}

/**
 * The ingest path.
 *
 * opts.store — storage interface
 * opts.now   — clock injection
 */
export function createEventIngest({ store, now = () => Date.now() } = {}) {
  if (!store?.records) throw new Error('createEventIngest requires a store with records.');

  const leadDocId = ({ workspaceId, leadKey }) =>
    `lead_${createHash('sha256').update(`${workspaceId}:${leadKey}`).digest('hex').slice(0, 40)}`;

  /**
   * Persist before acknowledging. If this throws, the sender gets an error and can
   * retry; if it succeeds, the event is durable and the ack is honest.
   */
  async function ingest({ source, body }) {
    const event = validateEventV2(body, { now });

    // Tenant check: the key owns the tenant. A conflicting claim in the body is a
    // rejected request, not a hint we should follow.
    if (event.workspaceIdClaim && event.workspaceIdClaim !== source.workspaceId) {
      throw new ApiError(
        403,
        'tenant_mismatch',
        'workspace_id does not match the ingest key. The key decides the tenant.',
      );
    }
    if (event.sourceConnectionIdClaim && event.sourceConnectionIdClaim !== source.sourceConnectionId) {
      throw new ApiError(403, 'tenant_mismatch', 'source_connection_id does not match the ingest key.');
    }

    // `lead_qualified` is an outcome, so only a source explicitly trusted for
    // qualification (a CRM sync) may report it. Everything else goes through the API,
    // where a named human is recorded.
    if (event.eventType === 'lead_qualified' && !source.trustedForQualification) {
      throw new ApiError(
        403,
        'qualification_not_trusted',
        'This source is not trusted to qualify leads. Qualify through POST /api/orgs/{org}/workspaces/{ws}/leads/{lead}/qualification so the decision is attributed to a person.',
      );
    }

    const docId = eventDocumentId({ workspaceId: source.workspaceId, eventId: event.eventId });
    const record = {
      id: docId,
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
      sourceConnectionId: source.sourceConnectionId,
      ...event,
      ingestedAt: now(),
    };

    const { created } = await store.records.create('events', docId, record, { orgId: source.organizationId });

    // A replay is a success with `duplicate: true`: the sender's retry worked, and
    // nothing was counted twice. Lead state is not re-applied on a duplicate.
    if (!created) return { accepted: true, duplicate: true, eventId: event.eventId, eventType: event.eventType };

    let lead = null;
    if (LEAD_EVENT_TYPES.has(event.eventType)) {
      lead = await upsertLead({ source, event });
    } else if (event.eventType === 'lead_qualified') {
      lead = await applyQualification({ source, event });
    }

    return {
      accepted: true,
      duplicate: false,
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      leadId: lead?.leadId ?? null,
    };
  }

  /** First touch wins: a later enquiry must not overwrite the campaign that found them. */
  async function upsertLead({ source, event }) {
    const leadKey = event.crmRecordReference ?? event.eventId;
    const id = leadDocId({ workspaceId: source.workspaceId, leadKey });
    const existing = await store.records.get('leads', id, { orgId: source.organizationId });

    if (existing) {
      const eventIds = existing.eventIds.includes(event.eventId)
        ? existing.eventIds
        : [...existing.eventIds, event.eventId];
      const updated = await store.records.update(
        'leads',
        id,
        {
          eventIds,
          lastEventAt: event.occurredAt,
          // A qualification is never downgraded by a later enquiry event.
          qualification: existing.qualification,
        },
        { orgId: source.organizationId },
      );
      return updated;
    }

    const record = {
      id,
      leadId: id,
      leadKey,
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
      sourceConnectionId: source.sourceConnectionId,
      crmRecordReference: event.crmRecordReference,
      campaignId: event.campaignId,
      anonymousSessionId: event.anonymousSessionId,
      countryCode: event.countryCode,
      region: event.region,
      currency: event.currency,
      // Two separate facts: the enquiry exists, and whether anyone judged it good.
      stage: 'enquiry',
      qualification: null,
      firstTouch: {
        eventId: event.eventId,
        campaignId: event.campaignId,
        utm: event.utm,
        landingUrl: event.landingUrl,
        occurredAt: event.occurredAt,
      },
      eventIds: [event.eventId],
      createdAt: event.occurredAt,
      lastEventAt: event.occurredAt,
      // Provenance of the row itself, so a report can say where a lead came from.
      createdFrom: { eventType: event.eventType, sourceConnectionId: source.sourceConnectionId },
    };
    const { created, doc } = await store.records.create('leads', id, record, { orgId: source.organizationId });
    // A concurrent duplicate insert loses the race: return the winner, not ours.
    return created ? doc : doc;
  }

  async function applyQualification({ source, event }) {
    const leadKey = event.crmRecordReference ?? event.eventId;
    const id = leadDocId({ workspaceId: source.workspaceId, leadKey });
    const existing = await store.records.get('leads', id, { orgId: source.organizationId });
    const qualification = {
      status: 'qualified',
      // Recorded explicitly: a CRM said so, or a named user did.
      source: `crm:${source.sourceConnectionId}`,
      actor: null,
      at: event.occurredAt,
      definitionVersion: 'v1',
      note: null,
    };
    if (!existing) {
      // Qualification can arrive for a lead we never saw an enquiry for (a phone call,
      // a referral). Record it plainly rather than inventing the missing funnel.
      const record = {
        id,
        leadId: id,
        leadKey,
        organizationId: source.organizationId,
        workspaceId: source.workspaceId,
        sourceConnectionId: source.sourceConnectionId,
        crmRecordReference: event.crmRecordReference,
        campaignId: event.campaignId,
        currency: event.currency,
        stage: 'qualified',
        qualification,
        firstTouch: null,
        eventIds: [event.eventId],
        createdAt: event.occurredAt,
        lastEventAt: event.occurredAt,
        createdFrom: { eventType: event.eventType, sourceConnectionId: source.sourceConnectionId },
        missingEnquiryEvent: true,
      };
      const { doc } = await store.records.create('leads', id, record, { orgId: source.organizationId });
      return doc;
    }
    return store.records.update(
      'leads',
      id,
      {
        stage: 'qualified',
        qualification,
        eventIds: existing.eventIds.includes(event.eventId) ? existing.eventIds : [...existing.eventIds, event.eventId],
        lastEventAt: event.occurredAt,
      },
      { orgId: source.organizationId },
    );
  }

  return { ingest };
}

/** Attribution windows are explicit; the default matches the platform's click window. */
export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 30;

/**
 * First-touch and last-touch attribution over stored touchpoints.
 *
 * Only *touchpoints that exist* are used. If a lead has no landing event on record the
 * answer is `available:false` with a reason — never an imputed campaign.
 *
 * This is correlation with a stated window, not proof of causation, and the returned
 * object says so in `basis`.
 */
export function attribute({ touchpoints = [], conversionAt, windowDays = DEFAULT_ATTRIBUTION_WINDOW_DAYS, timeZone }) {
  const cutoff = conversionAt - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = touchpoints
    .filter((t) => typeof t.occurredAt === 'number' && t.occurredAt >= cutoff && t.occurredAt <= conversionAt)
    .sort((a, b) => a.occurredAt - b.occurredAt);

  const window = {
    days: windowDays,
    start: new Date(cutoff).toISOString(),
    end: new Date(conversionAt).toISOString(),
    timeZone: timeZone ?? 'UTC',
  };

  if (!inWindow.length) {
    return {
      available: false,
      reason: 'no_touchpoints_in_window',
      window,
      basis: 'observed_touchpoints',
      models: { firstTouch: null, lastTouch: null },
    };
  }

  const summarise = (t) => ({
    campaignId: t.campaignId ?? null,
    utm: t.utm ?? {},
    landingUrl: t.landingUrl ?? null,
    occurredAt: t.occurredAt,
  });

  return {
    available: true,
    window,
    basis: 'observed_touchpoints',
    note: 'Association within the stated window, not proof of causation.',
    models: {
      firstTouch: summarise(inWindow[0]),
      lastTouch: summarise(inWindow[inWindow.length - 1]),
    },
    touchpointCount: inWindow.length,
  };
}
