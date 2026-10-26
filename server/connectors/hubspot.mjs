// HubSpot CRM connector — read-only.
//
// What this module is allowed to do: read contacts and deals, and turn them into the
// existing versioned event schema. What it cannot do: create, update, delete, or qualify
// anything in HubSpot. There is no write path in this file, and no scope is requested
// that would permit one.
//
// Design notes that matter:
//
//   * The provider is behind an adapter. `clientFactory(accessToken)` is the only way
//     this module touches HubSpot CRM data, so tests drive it with a fake client and the
//     production wiring is one small function (see `createSdkClientFactory`).
//   * Tokens are sealed with AES-256-GCM and bound to the tenant that owns them
//     (`connectors/crypto.mjs`). They are never returned by any method here.
//   * Imported records become events with deterministic ids, so re-running an import is
//     a no-op rather than a duplicate. The lead identity is the provider record
//     reference, so a contact imported twice is one lead.
//   * A contact is a lead, never a *qualified* lead. Qualification comes only from an
//     operator-configured set of deal stages, on a source explicitly trusted for it.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.mjs';
import { seal, open, tenantAad } from './crypto.mjs';
import { text } from '../validate.mjs';

export const CONNECTOR_PROVIDER = 'hubspot';

/** Read-only scopes. Deliberately no `.write` scope, and no scope we do not use. */
export const HUBSPOT_SCOPES = ['crm.objects.contacts.read', 'crm.objects.deals.read'];

export const CONNECTOR_STATUSES = [
  'not_connected',
  'connecting',
  'connected',
  'syncing',
  'degraded',
  'failed',
  'disconnected',
];

/** HubSpot object type ids used by webhook payloads. */
const OBJECT_TYPE_IDS = { '0-1': 'contacts', '0-3': 'deals' };

const CONTACT_PROPERTIES = ['createdate', 'hs_lastmodifieddate', 'country', 'lifecyclestage', 'hs_object_id'];
const DEAL_PROPERTIES = ['dealstage', 'hs_lastmodifieddate', 'closedate', 'hs_object_id'];

const STATE_TTL_MS = 10 * 60 * 1000;
// A sync lease must outlive one page fetch and a backoff, and it is renewed after every
// page, so a short lease is safe: if an instance dies, another takes over in minutes
// instead of waiting for a wall-clock heuristic to expire.
const SYNC_LEASE_MS = 2 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 15 * 1000;
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000; // HubSpot's documented v3 window
const SKEW_BEFORE_REFRESH_MS = 60 * 1000;

const isoFromMs = (value) => {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** HubSpot's `country` property is free text; only a two-letter code is usable as one. */
const iso2 = (value) => {
  const raw = String(value ?? '').trim();
  return /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
};

/**
 * Classify a provider/transport error. The connector's behaviour depends on this and
 * nothing else: retry what is transient, stop on what is not, and never retry auth.
 */
export function classifyProviderError(error) {
  // An error that already carries a classification keeps it. Re-classifying a wrapped
  // ApiError by its *HTTP status* (502) would turn a permanent 404 into a retryable
  // failure, and the webhook would ask HubSpot to retry something that will never exist.
  if (typeof error?.retryable === 'boolean' && typeof error?.kind === 'string') {
    return { code: error.code ?? 'hubspot_error', retryable: error.retryable, kind: error.kind };
  }
  const status = Number(error?.status ?? error?.response?.status ?? 0);
  if (status === 429) return { code: 'hubspot_rate_limited', retryable: true, kind: 'rate_limit' };
  if (status === 401) return { code: 'hubspot_auth_rejected', retryable: false, kind: 'auth' };
  if (status === 403) return { code: 'hubspot_scope_rejected', retryable: false, kind: 'scope' };
  if (status === 477) return { code: 'hubspot_migrating', retryable: false, kind: 'provider' };
  if (status >= 500) return { code: 'hubspot_unavailable', retryable: true, kind: 'provider' };
  if (status >= 400) return { code: 'hubspot_request_rejected', retryable: false, kind: 'request' };
  if (error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT' || error?.name === 'AbortError') {
    return { code: 'hubspot_unreachable', retryable: error?.name !== 'AbortError', kind: 'network' };
  }
  return { code: 'hubspot_unreachable', retryable: true, kind: 'network' };
}

/** Redact anything that could be credential material before it reaches a log or a response. */
export function redactError(error) {
  const message = String(error?.message ?? 'provider error');
  return message
    .replace(/access_token[=:]\s*[^\s&,;]+/gi, 'access_token=[redacted]')
    .replace(/refresh_token[=:]\s*[^\s&,;]+/gi, 'refresh_token=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .slice(0, 300);
}

export function createHubSpotConnector({
  store,
  tenancy,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  encryptionKey = null,
  oauth = {},
  clientFactory = null,
  limits = {},
  ingest = null,
} = {}) {
  if (!store?.records) throw new Error('createHubSpotConnector requires a store with records.');
  if (typeof clientFactory !== 'function') throw new Error('createHubSpotConnector requires a clientFactory.');

  const batchSize = Math.min(100, Math.max(1, Number(limits.batchSize ?? 100)));
  const maxPages = Math.min(200, Math.max(1, Number(limits.maxPages ?? 20)));
  const maxAttempts = Math.min(6, Math.max(1, Number(limits.maxAttempts ?? 3)));
  const baseDelayMs = Math.max(1, Number(limits.baseDelayMs ?? 250));
  // Deliveries accepted per source per window. HubSpot batches up to 100 events per
  // delivery and retries on 429, so this bounds the work one connection can create without
  // getting in the way of normal traffic. Set to 0 to disable (documented, not silent).
  const webhookLimit = Math.max(0, Number(limits.webhookPerMinute ?? 120));
  const webhookWindowMs = 60_000;

  const configured = Boolean(encryptionKey && oauth.clientId && oauth.clientSecret && oauth.redirectUri);
  const missingConfig = [
    !encryptionKey && 'CONNECTOR_ENCRYPTION_KEY',
    !oauth.clientId && 'HUBSPOT_CLIENT_ID',
    !oauth.clientSecret && 'HUBSPOT_CLIENT_SECRET',
    !oauth.redirectUri && 'HUBSPOT_REDIRECT_URI',
  ].filter(Boolean);

  const tokenPath = oauth.tokenPath ?? '/oauth/2026-09/token';
  const apiBase = (oauth.apiBase ?? 'https://api.hubapi.com').replace(/\/$/, '');
  const fetchImpl = oauth.fetch ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('createHubSpotConnector requires a fetch implementation.');
  }

  // ------------------------------------------------------------------ helpers

  function requireConfigured() {
    if (!configured) {
      throw new ApiError(
        503,
        'connector_not_configured',
        `The HubSpot connector is not configured on this server. Missing: ${missingConfig.join(', ')}.`,
      );
    }
  }

  async function hubspotSource(organizationId, workspaceId) {
    const rows = await store.records.list('sources', { orgId: organizationId, where: { workspaceId } });
    return rows.find((row) => row.connector === CONNECTOR_PROVIDER) ?? null;
  }

  async function requireSource(organizationId, workspaceId, sourceConnectionId = null) {
    const source = sourceConnectionId
      ? await store.records.get('sources', sourceConnectionId, { orgId: organizationId })
      : await hubspotSource(organizationId, workspaceId);
    if (!source || source.workspaceId !== workspaceId || source.connector !== CONNECTOR_PROVIDER) {
      throw new ApiError(404, 'not_found', 'No HubSpot connection for this workspace.');
    }
    return source;
  }

  function aadFor(source) {
    return tenantAad({
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
      sourceConnectionId: source.sourceConnectionId,
    });
  }

  function safeView(source) {
    if (!source) {
      return {
        provider: CONNECTOR_PROVIDER,
        configured,
        missingConfig,
        status: 'not_connected',
        connected: false,
        sourceConnectionId: null,
        trustedForQualification: false,
        scopesGranted: [],
        portalId: null,
        lastSyncAt: null,
        lastSyncStatus: null,
        lastSync: null,
        checkpoint: null,
        lastError: null,
        qualifiedStages: [],
        nextAction: configured ? 'connect' : 'configure_server',
      };
    }
    const auth = source.auth ?? null;
    const status = source.connectionStatus ?? 'not_connected';
    // A `syncing` status with an expired lease is what a crashed instance leaves behind.
    // It is reported as stale rather than as work in progress, because nothing is running.
    const leaseActive = Boolean(source.lease && Number(source.lease.expiresAt) > now());
    const syncStale = status === 'syncing' && !leaseActive;
    return {
      provider: CONNECTOR_PROVIDER,
      configured,
      missingConfig,
      status,
      connected: status === 'connected' || status === 'syncing' || status === 'degraded',
      sourceConnectionId: source.sourceConnectionId,
      trustedForQualification: Boolean(source.trustedForQualification),
      // Exactly the scopes the provider reported. `scopesVerified: false` means it did not
      // report any, which is not the same as "granted everything we asked for".
      scopesGranted: auth?.scopes ?? [],
      scopesVerified: Boolean(auth?.scopesVerified),
      portalId: auth?.portalId ?? null,
      syncInProgress: leaseActive,
      syncLeaseExpiresAt: leaseActive ? source.lease.expiresAt : null,
      syncStale,
      // `null` is "never synced", not an epoch and not now.
      lastSyncAt: source.lastSyncAt ?? null,
      lastSyncStatus: source.lastSyncStatus ?? null,
      lastSync: source.lastSync ?? null,
      checkpoint: source.checkpoint ?? null,
      lastError: source.lastError ?? null,
      qualifiedStages: source.qualifiedStages ?? [],
      nextAction: syncStale
        ? 'run_sync'
        : status === 'failed'
          ? 'reconnect'
          : status === 'degraded'
            ? 'run_sync'
            : status === 'connected'
              ? 'run_sync'
              : status === 'disconnected'
                ? 'connect'
                : status === 'connecting'
                  ? 'finish_connect'
                  : 'connect',
    };
  }

  async function audit({ action, source, principal, actorRole, detail, ok = true }) {
    await tenancy.audit({
      action,
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
      actor: principal?.uid ?? 'system',
      actorRole: actorRole ?? null,
      target: source.sourceConnectionId,
      ok,
      detail,
    });
  }

  async function callProvider(operation, signal) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const classified = classifyProviderError(error);
        lastError = { error, classified };
        if (!classified.retryable || attempt === maxAttempts) break;
        // Bounded exponential backoff. The delay is measured from the attempt number, not
        // from a provider hint we cannot trust across every endpoint.
        await sleep(baseDelayMs * 2 ** (attempt - 1));
        if (signal?.aborted) break;
      }
    }
    const { error, classified } = lastError;
    const wrapped = new ApiError(
      classified.kind === 'auth' || classified.kind === 'scope' ? 401 : 502,
      classified.code,
      `HubSpot request failed: ${redactError(error)}`,
    );
    wrapped.retryable = classified.retryable;
    wrapped.kind = classified.kind;
    throw wrapped;
  }

  // ------------------------------------------------------------------- oauth

  async function exchangeToken(params) {
    const body = new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      ...params,
    });
    let response;
    try {
      response = await fetchImpl(`${apiBase}${tokenPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        // The body carries client_secret and the refresh token. A redirect would re-send
        // it to whatever host answered the 3xx, so redirects are refused outright.
        redirect: 'error',
        // A hung provider must not hold a request open until the platform kills it.
        signal: AbortSignal.timeout(Number(oauth.requestTimeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS)),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new ApiError(
        timedOut ? 504 : 502,
        timedOut ? 'hubspot_token_timeout' : 'hubspot_unreachable',
        timedOut
          ? `HubSpot token endpoint did not answer within ${oauth.requestTimeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS} ms.`
          : `HubSpot token endpoint unreachable: ${redactError(error)}`,
      );
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(
        502,
        'hubspot_token_rejected',
        `HubSpot rejected the token request (status ${response.status}${payload?.error ? `, ${redactError({ message: payload.error })}` : ''}).`,
      );
    }
    if (typeof payload?.access_token !== 'string' || typeof payload?.refresh_token !== 'string') {
      throw new ApiError(502, 'hubspot_token_response_invalid', 'HubSpot returned no access/refresh token.');
    }
    const expiresIn = Number(payload.expires_in);
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      // HubSpot documents ~30 minutes; if `expires_in` is missing, treat the token as
      // already stale so the next call refreshes rather than failing mid-sync.
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : now(),
      scopes: typeof payload.scope === 'string' && payload.scope.trim() ? payload.scope.trim().split(/\s+/) : null,
      portalId: payload.hub_id !== undefined ? String(payload.hub_id) : null,
    };
  }

  async function accessTokenFor(source) {
    const aad = aadFor(source);
    const accessToken = open(source.auth?.sealedAccessToken, encryptionKey, { aad });
    const refreshToken = open(source.auth?.sealedRefreshToken, encryptionKey, { aad });
    if (!refreshToken) {
      throw new ApiError(401, 'hubspot_reauth_required', 'The stored HubSpot credential cannot be opened. Reconnect.');
    }
    const expiresAt = Number(source.auth?.expiresAt ?? 0);
    if (accessToken && expiresAt - SKEW_BEFORE_REFRESH_MS > now()) return { accessToken, source };

    const refreshed = await exchangeToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const updated = await store.records.update(
      'sources',
      source.sourceConnectionId,
      {
        auth: {
          sealedAccessToken: seal(refreshed.accessToken, encryptionKey, { aad }),
          sealedRefreshToken: seal(refreshed.refreshToken, encryptionKey, { aad }),
          expiresAt: refreshed.expiresAt,
          // Exactly what the provider reported. A refresh that returns no scope list
          // keeps the previous *observed* list; it never falls back to the requested one.
          scopes: refreshed.scopes ?? source.auth?.scopes ?? [],
          portalId: refreshed.portalId ?? source.auth?.portalId ?? null,
          tokenVersion: 'v1',
        },
        // Deliberately no `connectionStatus` write: a refresh happens *inside* a sync or a
        // webhook, and writing 'connected' there would erase 'syncing', and could undo a
        // disconnect that landed while the refresh was in flight.
        lastError: null,
      },
      { orgId: source.organizationId },
    );
    // A refresh is a credential event, so it is audited — with no token material.
    await audit({
      action: 'connector.token_refresh',
      source: updated,
      detail: { expiresAt: refreshed.expiresAt },
    });
    return { accessToken: refreshed.accessToken, source: updated };
  }

  async function connectStart({ principal, organizationId, workspaceId, body = {} }) {
    const ctx = await tenancy.context(principal, organizationId, 'source.manage');
    await tenancy.workspace(organizationId, workspaceId, { role: ctx.role });
    requireConfigured();

    const trustedForQualification = body?.trustedForQualification === true;
    // Deals stages are the *only* qualification signal, so an empty mapping means "import
    // leads, but never mark one qualified". Explicit, not inferred.
    const qualifiedStages = Array.isArray(body?.qualifiedStages)
      ? [...new Set(body.qualifiedStages.map((stage) => text(stage, 'qualifiedStages[]', { max: 64 })))]
      : [];

    let source = await hubspotSource(organizationId, workspaceId);
    if (source && (source.connectionStatus === 'connected' || source.connectionStatus === 'syncing')) {
      throw new ApiError(409, 'connector_already_connected', 'A HubSpot connection already exists for this workspace.');
    }
    if (!source) {
      source = {
        sourceConnectionId: `src_hs_${randomBytes(9).toString('base64url')}`,
        organizationId,
        workspaceId,
        provider: 'crm',
        connector: CONNECTOR_PROVIDER,
        label: 'HubSpot CRM',
        capability: 'read',
        status: 'connected',
        connectionStatus: 'connecting',
        trustedForQualification,
        qualifiedStages,
        lastSyncAt: null,
        lastSyncStatus: null,
        checkpoint: null,
        createdAt: now(),
        createdBy: principal.uid,
      };
      await store.records.put('sources', source.sourceConnectionId, source, { orgId: organizationId });
    } else {
      source = await store.records.update(
        'sources',
        source.sourceConnectionId,
        { connectionStatus: 'connecting', trustedForQualification, qualifiedStages, lastError: null },
        { orgId: organizationId },
      );
    }

    const state = randomBytes(24).toString('base64url');
    await store.records.put('oauthStates', state, {
      state,
      organizationId,
      workspaceId,
      sourceConnectionId: source.sourceConnectionId,
      userId: principal.uid,
      createdAt: now(),
      expiresAt: now() + STATE_TTL_MS,
      usedAt: null,
    });

    const params = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: oauth.redirectUri,
      // HubSpot takes a space-separated scope list; the URLSearchParams encoder sends it
      // as `+`, which HubSpot decodes correctly.
      scope: HUBSPOT_SCOPES.join(' '),
      state,
    });

    await audit({
      action: 'connector.connect_start',
      source,
      principal,
      actorRole: ctx.role,
      detail: { provider: CONNECTOR_PROVIDER, scopes: HUBSPOT_SCOPES, trustedForQualification },
    });

    return {
      authorizationUrl: `https://app.hubspot.com/oauth/authorize?${params.toString()}`,
      state,
      expiresAt: now() + STATE_TTL_MS,
      sourceConnectionId: source.sourceConnectionId,
      scopes: HUBSPOT_SCOPES,
      status: 'connecting',
    };
  }

  async function connectComplete({ principal, organizationId, workspaceId, body = {} }) {
    const ctx = await tenancy.context(principal, organizationId, 'source.manage');
    await tenancy.workspace(organizationId, workspaceId, { role: ctx.role });
    requireConfigured();

    const state = text(body?.state, 'state', { max: 200 });
    const code = text(body?.code, 'code', { max: 500 });
    const stateRecord = await store.records.get('oauthStates', state);
    if (!stateRecord || stateRecord.organizationId !== organizationId || stateRecord.workspaceId !== workspaceId) {
      // A state that belongs to another tenant is indistinguishable from one that does
      // not exist, so a probe cannot confirm that a tenant exists.
      throw new ApiError(400, 'invalid_state', 'That connection attempt is not valid for this workspace.');
    }
    if (stateRecord.expiresAt < now()) throw new ApiError(400, 'state_expired', 'That connection attempt expired.');
    if (stateRecord.userId !== principal.uid) {
      throw new ApiError(403, 'forbidden', 'This connection attempt was started by a different user.');
    }

    const source = await requireSource(organizationId, workspaceId, stateRecord.sourceConnectionId);

    /**
     * Spend the state atomically, *before* the exchange.
     *
     * Two callbacks may arrive with the same valid state (a double-click, a provider
     * retry, two instances behind a load balancer). A read-then-write would let both pass
     * the check and both exchange the code. `consumeOnce` is a single transaction, so
     * exactly one caller gets `consumed: true`; the other is refused here, before any
     * provider call.
     */
    const claim = await store.records.consumeOnce('oauthStates', state, {
      at: now(),
      expect: { organizationId, workspaceId, userId: principal.uid },
    });
    if (!claim.consumed) {
      if (claim.reason === 'already_used') {
        throw new ApiError(400, 'state_already_used', 'That connection attempt was already used.');
      }
      // not_found or mismatch: both are "not yours", and both look the same on purpose.
      throw new ApiError(400, 'invalid_state', 'That connection attempt is not valid for this workspace.');
    }

    let tokens;
    try {
      tokens = await exchangeToken({ grant_type: 'authorization_code', code, redirect_uri: oauth.redirectUri });
    } catch (error) {
      const failed = await store.records.update(
        'sources',
        source.sourceConnectionId,
        {
          connectionStatus: 'failed',
          lastError: { code: error.code ?? 'hubspot_token_rejected', message: redactError(error), at: now() },
        },
        { orgId: organizationId },
      );
      await audit({
        action: 'connector.connect',
        source: failed,
        principal,
        actorRole: ctx.role,
        ok: false,
        detail: { error: error.code ?? 'hubspot_token_rejected' },
      });
      throw error;
    }

    // The scopes we hold are the ones the provider *reported*, never the ones we asked
    // for. Requesting a scope is not a grant, and reporting it as one is a lie the UI
    // would repeat.
    const grantedScopes = Array.isArray(tokens.scopes) ? tokens.scopes : [];
    const missingScopes =
      tokens.scopes === null ? [] : HUBSPOT_SCOPES.filter((scope) => !grantedScopes.includes(scope));
    if (missingScopes.length > 0) {
      const failed = await store.records.update(
        'sources',
        source.sourceConnectionId,
        {
          connectionStatus: 'failed',
          auth: null,
          lastError: {
            code: 'hubspot_scope_rejected',
            message: `HubSpot granted a narrower scope set than required; missing: ${missingScopes.join(', ')}.`,
            at: now(),
          },
        },
        { orgId: organizationId },
      );
      await audit({
        action: 'connector.connect',
        source: failed,
        principal,
        actorRole: ctx.role,
        ok: false,
        detail: { error: 'hubspot_scope_rejected', missingScopes },
      });
      throw new ApiError(
        502,
        'hubspot_scope_rejected',
        `HubSpot granted a narrower scope set than required; missing: ${missingScopes.join(', ')}.`,
      );
    }

    const aad = aadFor(source);
    const updated = await store.records.update(
      'sources',
      source.sourceConnectionId,
      {
        connectionStatus: 'connected',
        auth: {
          sealedAccessToken: seal(tokens.accessToken, encryptionKey, { aad }),
          sealedRefreshToken: seal(tokens.refreshToken, encryptionKey, { aad }),
          expiresAt: tokens.expiresAt,
          scopes: grantedScopes,
          // `null` scope list means the provider did not say. Recorded as unverified
          // rather than quietly assumed to be complete.
          scopesVerified: tokens.scopes !== null,
          portalId: tokens.portalId,
          tokenVersion: 'v1',
        },
        lastError: null,
        connectedAt: now(),
      },
      { orgId: organizationId },
    );

    await audit({
      action: 'connector.connect',
      source: updated,
      principal,
      actorRole: ctx.role,
      detail: {
        provider: CONNECTOR_PROVIDER,
        scopes: updated.auth.scopes,
        trustedForQualification: updated.trustedForQualification,
      },
    });

    return safeView(updated);
  }

  // ------------------------------------------------------------------ import

  function mapContact(record) {
    const props = record?.properties ?? {};
    const id = String(props.hs_object_id ?? record?.id ?? '');
    if (!id) return { skip: 'missing_id' };
    const occurredAt = isoFromMs(props.createdate ?? props.hs_lastmodifieddate);
    // A record with no provider timestamp cannot be placed in time. Skipping is honest;
    // stamping `now()` would invent an occurrence that never happened.
    if (!occurredAt) return { skip: 'missing_timestamp' };
    return {
      event: {
        schema_version: 2,
        event_id: `hs.contact.${id}`,
        event_type: 'lead_created',
        occurred_at: occurredAt,
        event_source: 'crm',
        crm_record_reference: `hubspot:contact:${id}`,
        consent_state: 'unknown',
        country_code: iso2(props.country) ?? undefined,
        // Identifier and provenance only: no email, name, phone or free-text fields.
        metadata: { provider: CONNECTOR_PROVIDER, object: 'contact', recordId: id },
      },
    };
  }

  function mapDeal(record, { trustedForQualification, qualifiedStages }) {
    const props = record?.properties ?? {};
    const id = String(props.hs_object_id ?? record?.id ?? '');
    if (!id) return { skip: 'missing_id' };
    const stage = String(props.dealstage ?? '');
    if (!stage) return { skip: 'missing_stage' };
    // Qualification is a documented, operator-configured stage — never "a deal exists".
    if (!trustedForQualification) return { skip: 'source_not_trusted_for_qualification' };
    if (!qualifiedStages.includes(stage)) return { skip: 'stage_not_qualified' };

    const contactId = record?.associations?.contacts?.results?.[0]?.id ?? null;
    if (!contactId) return { skip: 'no_associated_contact' };

    const occurredAt = isoFromMs(props.hs_lastmodifieddate ?? props.closedate);
    if (!occurredAt) return { skip: 'missing_timestamp' };

    return {
      event: {
        schema_version: 2,
        event_id: `hs.deal.${id}.${stage}`,
        event_type: 'lead_qualified',
        occurred_at: occurredAt,
        event_source: 'crm',
        crm_record_reference: `hubspot:contact:${contactId}`,
        consent_state: 'unknown',
        metadata: { provider: CONNECTOR_PROVIDER, object: 'deal', recordId: id, stage },
      },
    };
  }

  async function importPage({ source, client, objectType, after, signal, totals }) {
    const page =
      objectType === 'contacts'
        ? await client.contacts.getPage({ limit: batchSize, after, properties: CONTACT_PROPERTIES, signal })
        : await client.deals.getPage({
            limit: batchSize,
            after,
            properties: DEAL_PROPERTIES,
            associations: ['contacts'],
            signal,
          });

    const results = Array.isArray(page?.results) ? page.results : [];
    for (const record of results) {
      const mapped =
        objectType === 'contacts'
          ? mapContact(record)
          : mapDeal(record, {
              trustedForQualification: Boolean(source.trustedForQualification),
              qualifiedStages: source.qualifiedStages ?? [],
            });
      if (mapped.skip) {
        totals.skipped += 1;
        totals.skippedReasons[mapped.skip] = (totals.skippedReasons[mapped.skip] ?? 0) + 1;
        continue;
      }
      try {
        const result = await ingest.ingest({ source, body: mapped.event });
        totals[result.duplicate ? 'duplicates' : 'imported'] += 1;
      } catch (error) {
        // A record that cannot be mapped is counted and named, never dropped silently.
        const code = error?.code ?? 'ingest_rejected';
        totals.skipped += 1;
        totals.skippedReasons[code] = (totals.skippedReasons[code] ?? 0) + 1;
      }
    }
    return { next: page?.paging?.next?.after ?? null, count: results.length };
  }

  /**
   * Renew the lease after every page. If the lease is gone, this sync must stop: another
   * holder owns the connection and whatever we wrote next would race it.
   */
  async function renewOrAbort({ source, holder }) {
    const renewed = await store.records.renewLease('sources', source.sourceConnectionId, {
      orgId: source.organizationId,
      at: now(),
      ttlMs: SYNC_LEASE_MS,
      holder,
    });
    if (!renewed.renewed) {
      throw new ApiError(
        409,
        'sync_lock_lost',
        'The sync lease was lost (it expired or was taken over); this run stopped without writing its checkpoint.',
      );
    }
  }

  async function importObject({ source, client, objectType, checkpoint, signal, totals, onPage = null }) {
    let after = checkpoint?.[objectType]?.after ?? null;
    let pages = 0;
    // Not complete until a page reports that there is no next cursor.
    let complete = false;
    while (pages < maxPages) {
      if (signal?.aborted) {
        const abort = new Error('sync cancelled');
        abort.name = 'AbortError';
        throw abort;
      }
      const { next, count } = await callProvider(
        () => importPage({ source, client, objectType, after, signal, totals }),
        signal,
      );
      pages += 1;
      after = next;
      complete = !after;
      if (onPage) await onPage();
      if (!after || count === 0) break;
    }
    return { after, pages, complete };
  }

  async function sync({
    principal = null,
    organizationId,
    workspaceId,
    sourceConnectionId = null,
    trigger = 'manual',
    signal,
  }) {
    // Only an authenticated member may trigger a sync. There is no "system" path here
    // that would bypass the permission check.
    if (!principal) throw new ApiError(401, 'unauthenticated', 'A sync requires an authenticated principal.');
    const ctx = await tenancy.context(principal, organizationId, 'source.manage');
    await tenancy.workspace(organizationId, workspaceId, { role: ctx.role });
    requireConfigured();
    const existing = await requireSource(organizationId, workspaceId, sourceConnectionId);
    if (existing.connectionStatus === 'disconnected') {
      throw new ApiError(409, 'connector_disconnected', 'This connection is disconnected. Reconnect to import again.');
    }

    /**
     * Take the sync lease, atomically.
     *
     * The previous implementation read `connectionStatus`, decided nobody was syncing,
     * and *then* wrote `syncing`. Two concurrent requests both read "connected" and both
     * imported. The lease is a single atomic operation in the store (a Firestore
     * transaction in production), so exactly one caller can hold it; the other gets a
     * deterministic conflict instead of a second import and a clobbered checkpoint.
     */
    const holder = `sync_${randomBytes(9).toString('base64url')}`;
    const acquired = await store.records.acquireLease('sources', existing.sourceConnectionId, {
      orgId: organizationId,
      at: now(),
      ttlMs: SYNC_LEASE_MS,
      holder,
      patch: { connectionStatus: 'syncing', syncStartedAt: now() },
    });
    if (!acquired.acquired) {
      if (acquired.reason === 'not_found') {
        throw new ApiError(404, 'not_found', 'No HubSpot connection for this workspace.');
      }
      const retryAfterMs = Math.max(1000, Number(acquired.lease?.expiresAt ?? now()) - now());
      const conflict = new ApiError(409, 'sync_in_progress', 'A sync is already running for this connection.');
      conflict.retryAfterMs = retryAfterMs;
      throw conflict;
    }
    const source = acquired.doc;
    if (acquired.tookOver) {
      // A previous holder stopped before releasing the lease (crash, eviction). Say so in
      // the audit trail: a takeover is a recovery event, not a normal start.
      await audit({
        action: 'connector.sync_takeover',
        source,
        principal,
        actorRole: ctx.role,
        detail: { reason: 'expired_lease', previousExpiresAt: acquired.lease?.expiresAt ?? null },
      });
    }

    const totals = { imported: 0, duplicates: 0, skipped: 0, skippedReasons: {}, pages: 0 };
    const startedAt = now();
    let outcome;

    try {
      const { accessToken } = await accessTokenFor(source);
      const client = await clientFactory(accessToken, { signal });
      const checkpoint = source.checkpoint ?? {};
      const nextCheckpoint = { ...checkpoint };

      const onPage = () => renewOrAbort({ source: { ...source, organizationId }, holder });
      const contacts = await importObject({
        source,
        client,
        objectType: 'contacts',
        checkpoint,
        signal,
        totals,
        onPage,
      });
      nextCheckpoint.contacts = { after: contacts.after, complete: contacts.complete };
      totals.pages += contacts.pages;

      const deals = await importObject({
        source,
        client,
        objectType: 'deals',
        checkpoint,
        signal,
        totals,
        onPage,
      });
      nextCheckpoint.deals = { after: deals.after, complete: deals.complete };
      totals.pages += deals.pages;

      const partial = !contacts.complete || !deals.complete;
      const finishedAt = now();
      outcome = {
        connectionStatus: partial ? 'degraded' : 'connected',
        lastSyncStatus: partial ? 'partial' : 'complete',
        partial,
        lastError: partial
          ? {
              code: 'sync_incomplete',
              message: `Pagination stopped at the configured page limit; ${contacts.complete ? 'deals' : 'contacts'} has more records. Run the sync again to continue.`,
              at: finishedAt,
            }
          : null,
        checkpoint: nextCheckpoint,
        lastSyncAt: finishedAt,
        syncStartedAt: null,
      };
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      const finishedAt = now();
      const code = aborted ? 'sync_cancelled' : (error.code ?? 'hubspot_unreachable');
      const authFailure = ['hubspot_auth_rejected', 'hubspot_scope_rejected', 'hubspot_reauth_required'].includes(code);
      outcome = {
        // A cancelled or failed sync is never reported as a successful one.
        connectionStatus: aborted ? 'degraded' : authFailure ? 'failed' : 'degraded',
        lastSyncStatus: aborted ? 'cancelled' : 'failed',
        partial: totals.imported + totals.duplicates > 0,
        lastError: { code, message: redactError(error), at: finishedAt },
        // Keep the previous successful time: "last success" is a different fact from
        // "last attempt", and overwriting it would hide an outage.
        syncStartedAt: null,
      };
    }

    if (outcome.lastError?.code === 'sync_lock_lost') {
      // The events we stored are real (they are idempotent), but the checkpoint and the
      // status are not ours to write any more. Report the truth instead of a success —
      // and name the reason, because "disconnected" and "another worker took over" lead
      // to different operator actions.
      const current = await requireSource(organizationId, workspaceId, source.sourceConnectionId);
      const disconnected = current?.connectionStatus === 'disconnected';
      return {
        status: disconnected ? 'disconnected' : 'failed',
        lastSyncStatus: 'failed',
        partial: totals.imported + totals.duplicates > 0,
        trigger,
        startedAt,
        finishedAt: now(),
        imported: totals.imported,
        duplicates: totals.duplicates,
        skipped: totals.skipped,
        skippedReasons: totals.skippedReasons,
        pages: totals.pages,
        countsSemantics: 'unique events stored; a duplicate is one the server already had',
        error: disconnected
          ? {
              code: 'connection_disconnected',
              message: 'The connection was disconnected while this sync was running, so its result was not applied.',
            }
          : outcome.lastError,
        applied: false,
        connection: safeView(current),
      };
    }

    /**
     * Release the lease and write the result in one atomic step. `unless` runs inside
     * that step: if the connection was disconnected while this sync was running, the
     * outcome is dropped and the disconnect stands. A sync must never resurrect an
     * account whose credentials were erased.
     */
    const released = await store.records.releaseLease('sources', source.sourceConnectionId, {
      orgId: organizationId,
      at: now(),
      holder,
      patch: outcome,
      unless: (record) => record.connectionStatus !== 'disconnected',
    });

    if (!released.released) {
      // Why the lease is gone changes what the operator should do: a disconnect is a
      // decision, a lost lease is a race. Report the real reason, not a generic one.
      const current = released.doc ?? (await requireSource(organizationId, workspaceId, source.sourceConnectionId));
      const disconnected = current?.connectionStatus === 'disconnected';
      return {
        status: disconnected ? 'disconnected' : 'failed',
        lastSyncStatus: 'failed',
        partial: totals.imported + totals.duplicates > 0,
        trigger,
        startedAt,
        finishedAt: now(),
        imported: totals.imported,
        duplicates: totals.duplicates,
        skipped: totals.skipped,
        skippedReasons: totals.skippedReasons,
        pages: totals.pages,
        countsSemantics: 'unique events stored; a duplicate is one the server already had',
        error: disconnected
          ? {
              code: 'connection_disconnected',
              message: 'The connection was disconnected while this sync was running, so its result was not applied.',
            }
          : { code: 'sync_lock_lost', message: 'The sync lease was lost before the result could be written.' },
        applied: false,
        connection: safeView(current),
      };
    }

    const updated = released.doc;
    const appliedOutcome = released.applied
      ? outcome
      : {
          lastSyncStatus: 'failed',
          lastError: {
            code: 'connection_disconnected',
            message: 'The connection was disconnected while this sync was running, so its result was not applied.',
            at: now(),
          },
        };

    const summary = {
      status: updated.connectionStatus,
      lastSyncStatus: appliedOutcome.lastSyncStatus,
      partial: Boolean(appliedOutcome.partial),
      applied: released.applied,
      trigger,
      startedAt,
      finishedAt: updated.lastSyncAt ?? now(),
      imported: totals.imported,
      duplicates: totals.duplicates,
      skipped: totals.skipped,
      skippedReasons: totals.skippedReasons,
      pages: totals.pages,
      countsSemantics: 'unique events stored; a duplicate is one the server already had',
      error: appliedOutcome.lastError ?? null,
    };

    await audit({
      action: 'connector.sync',
      source: updated,
      principal,
      actorRole: ctx?.role ?? null,
      ok: summary.lastSyncStatus === 'complete',
      detail: {
        trigger,
        status: summary.status,
        imported: summary.imported,
        duplicates: summary.duplicates,
        skipped: summary.skipped,
        pages: summary.pages,
        applied: summary.applied,
        error: summary.error?.code ?? null,
      },
    });

    return { ...summary, connection: safeView(updated) };
  }

  async function disconnect({ principal, organizationId, workspaceId, sourceConnectionId = null }) {
    const ctx = await tenancy.context(principal, organizationId, 'source.manage');
    await tenancy.workspace(organizationId, workspaceId, { role: ctx.role });
    const source = await requireSource(organizationId, workspaceId, sourceConnectionId);
    const updated = await store.records.update(
      'sources',
      source.sourceConnectionId,
      {
        connectionStatus: 'disconnected',
        // The sealed tokens are removed, not merely ignored: a stored credential for a
        // disconnected account is a liability with no upside.
        auth: null,
        checkpoint: null,
        // Any in-flight sync now owns nothing: its release is refused, so it cannot write
        // a status or a checkpoint over this disconnect.
        lease: null,
        disconnectedAt: now(),
        lastError: null,
      },
      { orgId: organizationId },
    );
    await audit({
      action: 'connector.disconnect',
      source: updated,
      principal,
      actorRole: ctx.role,
      detail: { provider: CONNECTOR_PROVIDER },
    });
    return safeView(updated);
  }

  // ----------------------------------------------------------------- webhook

  function verifyWebhook({ headers, rawBody, url, method = 'POST' }) {
    requireConfigured();
    const signature = headers?.['x-hubspot-signature-v3'];
    const timestamp = headers?.['x-hubspot-request-timestamp'];
    if (!signature || !timestamp) {
      throw new ApiError(401, 'webhook_unauthenticated', 'Missing HubSpot signature headers.');
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > WEBHOOK_TOLERANCE_MS) {
      throw new ApiError(401, 'webhook_timestamp_stale', 'The webhook timestamp is outside the accepted window.');
    }
    // Documented v3 scheme: base64(HMAC-SHA256(clientSecret, method + uri + body + ts)).
    const expected = createHmac('sha256', oauth.clientSecret)
      .update(`${method}${url}${rawBody}${timestamp}`, 'utf8')
      .digest('base64');
    const given = String(signature);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(given, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ApiError(401, 'webhook_signature_invalid', 'The webhook signature does not match.');
    }
  }

  async function webhook({ organizationId, sourceConnectionId, headers, rawBody, url, method = 'POST' }) {
    verifyWebhook({ headers, rawBody, url, method });

    const source = await store.records.get('sources', sourceConnectionId, { orgId: organizationId });
    if (!source || source.connector !== CONNECTOR_PROVIDER) {
      throw new ApiError(404, 'not_found', 'No such connector.');
    }
    if (source.connectionStatus === 'disconnected') {
      throw new ApiError(409, 'connector_disconnected', 'This connection is disconnected.');
    }

    // Per-source rate limit, checked before any provider work is done. The signature has
    // already been verified, so an attacker cannot spend another tenant's budget; and
    // because the counter is a store record, the limit holds across instances rather than
    // per process.
    if (webhookLimit > 0) {
      const window = await store.records.bumpCounter('rateLimits', `hubspot-webhook:${sourceConnectionId}`, {
        orgId: organizationId,
        at: now(),
        windowMs: webhookWindowMs,
        limit: webhookLimit,
      });
      if (!window.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil((window.resetAt - now()) / 1000));
        const limited = new ApiError(
          429,
          'webhook_rate_limited',
          `This connection sent more than ${webhookLimit} webhook deliveries in a minute; HubSpot should retry after ${retryAfterSeconds}s.`,
        );
        limited.retryAfterSeconds = retryAfterSeconds;
        limited.rateLimit = { limit: webhookLimit, count: window.count, resetAt: window.resetAt };
        // Audited once per rejected delivery: a silent 429 is invisible in an incident.
        await audit({
          action: 'connector.webhook_rate_limited',
          source,
          ok: false,
          detail: { limit: webhookLimit, count: window.count, resetAt: window.resetAt },
        });
        throw limited;
      }
    }

    let entries;
    try {
      entries = JSON.parse(rawBody);
    } catch {
      throw new ApiError(400, 'malformed_json', 'The webhook body is not JSON.');
    }
    if (!Array.isArray(entries)) throw new ApiError(400, 'invalid_body', 'The webhook body must be an array.');
    if (entries.length > 50) {
      throw new ApiError(413, 'batch_too_large', 'At most 50 webhook events are processed per delivery.');
    }

    const totals = { imported: 0, duplicates: 0, skipped: 0 };
    // A provider outage is not the same as a record we chose to skip. If a read fails for
    // a retryable reason we answer 5xx so HubSpot retries the delivery; answering 200
    // would drop the record silently.
    let retryableFailures = 0;
    const { accessToken } = await accessTokenFor(source);
    const client = await clientFactory(accessToken, {});

    for (const entry of entries) {
      const objectType = OBJECT_TYPE_IDS[String(entry?.objectTypeId ?? '')];
      const recordId = entry?.objectId !== undefined ? String(entry.objectId) : null;
      if (!objectType || !recordId) {
        totals.skipped += 1;
        continue;
      }
      try {
        // Read the record fresh: a webhook tells us *that* something changed, and the
        // current state is the only thing worth importing.
        const record = await callProvider(() =>
          objectType === 'contacts'
            ? client.contacts.getById(recordId, CONTACT_PROPERTIES)
            : client.deals.getById(recordId, DEAL_PROPERTIES, ['contacts']),
        );
        const mapped =
          objectType === 'contacts'
            ? mapContact(record)
            : mapDeal(record, {
                trustedForQualification: Boolean(source.trustedForQualification),
                qualifiedStages: source.qualifiedStages ?? [],
              });
        if (mapped.skip) {
          totals.skipped += 1;
          continue;
        }
        const result = await ingest.ingest({ source, body: mapped.event });
        totals[result.duplicate ? 'duplicates' : 'imported'] += 1;
      } catch (error) {
        totals.skipped += 1;
        if (classifyProviderError(error).retryable) retryableFailures += 1;
      }
    }

    if (retryableFailures > 0) {
      const failure = new ApiError(
        502,
        'webhook_partial_failure',
        `HubSpot could not be read for ${retryableFailures} of ${entries.length} event(s); HubSpot should retry this delivery.`,
      );
      failure.partial = { received: entries.length, ...totals, retryableFailures };
      // The audit still records what did land, because "we imported 3 of 50" is the fact
      // an operator needs after an incident.
      await audit({
        action: 'connector.webhook',
        source,
        ok: false,
        detail: {
          events: entries.length,
          imported: totals.imported,
          duplicates: totals.duplicates,
          retryableFailures,
        },
      });
      throw failure;
    }

    await audit({
      action: 'connector.webhook',
      source,
      detail: { events: entries.length, imported: totals.imported, duplicates: totals.duplicates },
    });

    return { received: entries.length, ...totals };
  }

  return {
    configured,
    missingConfig,
    scopes: HUBSPOT_SCOPES,
    status: async ({ principal, organizationId, workspaceId }) => {
      const ctx = await tenancy.context(principal, organizationId, 'data.read');
      await tenancy.workspace(organizationId, workspaceId, { role: ctx.role });
      return safeView(await hubspotSource(organizationId, workspaceId));
    },
    connectStart,
    connectComplete,
    sync,
    disconnect,
    webhook,
    // Exposed for tests and for the workspace panel's next-action copy.
    classifyProviderError,
  };
}
