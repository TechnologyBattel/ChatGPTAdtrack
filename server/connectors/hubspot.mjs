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
    return {
      provider: CONNECTOR_PROVIDER,
      configured,
      missingConfig,
      status,
      connected: status === 'connected' || status === 'syncing' || status === 'degraded',
      sourceConnectionId: source.sourceConnectionId,
      trustedForQualification: Boolean(source.trustedForQualification),
      scopesGranted: auth?.scopes ?? [],
      portalId: auth?.portalId ?? null,
      // `null` is "never synced", not an epoch and not now.
      lastSyncAt: source.lastSyncAt ?? null,
      lastSyncStatus: source.lastSyncStatus ?? null,
      lastSync: source.lastSync ?? null,
      checkpoint: source.checkpoint ?? null,
      lastError: source.lastError ?? null,
      qualifiedStages: source.qualifiedStages ?? [],
      nextAction:
        status === 'failed'
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
      });
    } catch (error) {
      throw new ApiError(502, 'hubspot_unreachable', `HubSpot token endpoint unreachable: ${redactError(error)}`);
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
          scopes: refreshed.scopes ?? source.auth?.scopes ?? HUBSPOT_SCOPES,
          portalId: refreshed.portalId ?? source.auth?.portalId ?? null,
          tokenVersion: 'v1',
        },
        connectionStatus: 'connected',
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
    if (stateRecord.usedAt) throw new ApiError(400, 'state_already_used', 'That connection attempt was already used.');
    if (stateRecord.expiresAt < now()) throw new ApiError(400, 'state_expired', 'That connection attempt expired.');
    if (stateRecord.userId !== principal.uid) {
      throw new ApiError(403, 'forbidden', 'This connection attempt was started by a different user.');
    }

    const source = await requireSource(organizationId, workspaceId, stateRecord.sourceConnectionId);
    // Spend the state before the exchange: a failed exchange must not leave a replayable
    // code behind, and the user can restart from the connect screen.
    await store.records.update('oauthStates', state, { usedAt: now() });

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
          scopes: tokens.scopes ?? HUBSPOT_SCOPES,
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

  async function importObject({ source, client, objectType, checkpoint, signal, totals }) {
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
    let source = await requireSource(organizationId, workspaceId, sourceConnectionId);
    if (source.connectionStatus === 'disconnected') {
      throw new ApiError(409, 'connector_disconnected', 'This connection is disconnected. Reconnect to import again.');
    }

    if (source.connectionStatus === 'syncing' && now() - (source.syncStartedAt ?? 0) < 10 * 60 * 1000) {
      throw new ApiError(409, 'sync_in_progress', 'A sync is already running for this connection.');
    }

    source = await store.records.update(
      'sources',
      source.sourceConnectionId,
      { connectionStatus: 'syncing', syncStartedAt: now() },
      { orgId: organizationId },
    );

    const totals = { imported: 0, duplicates: 0, skipped: 0, skippedReasons: {}, pages: 0 };
    const startedAt = now();
    let outcome;

    try {
      const { accessToken } = await accessTokenFor(source);
      const client = await clientFactory(accessToken, { signal });
      const checkpoint = source.checkpoint ?? {};
      const nextCheckpoint = { ...checkpoint };

      const contacts = await importObject({ source, client, objectType: 'contacts', checkpoint, signal, totals });
      nextCheckpoint.contacts = { after: contacts.after, complete: contacts.complete };
      totals.pages += contacts.pages;

      const deals = await importObject({ source, client, objectType: 'deals', checkpoint, signal, totals });
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

    const updated = await store.records.update('sources', source.sourceConnectionId, outcome, {
      orgId: organizationId,
    });

    const summary = {
      status: updated.connectionStatus,
      lastSyncStatus: updated.lastSyncStatus,
      partial: Boolean(outcome.partial),
      trigger,
      startedAt,
      finishedAt: updated.lastSyncAt ?? now(),
      imported: totals.imported,
      duplicates: totals.duplicates,
      skipped: totals.skipped,
      skippedReasons: totals.skippedReasons,
      pages: totals.pages,
      countsSemantics: 'unique events stored; a duplicate is one the server already had',
      error: updated.lastError ?? null,
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
      } catch {
        totals.skipped += 1;
      }
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
