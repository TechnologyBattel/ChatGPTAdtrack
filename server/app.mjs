// The router. Transport-free on purpose: `handle()` takes a plain request
// description and returns a status + body, so every rule can be tested without
// opening a socket or touching a real ad account.

import { ApiError } from './errors.mjs';
import { configuration, health, listAdGroups, listCampaigns, pushHintSet, track } from './core.mjs';
import { WRITE_ROLES } from './auth.mjs';
import { BROWSER_EVENTS, CONSENT_BASES, SERVER_EVENTS, verifySignedPayload } from './ingest.mjs';
import { isRetryable } from './outbox.mjs';
import { assertOrigin } from './limits.mjs';

/** Public shape of /api/health. Details are only for authenticated callers. */
function publicHealth(h) {
  return { ok: Boolean(h.ok), mode: h.mode };
}

/**
 * deps:
 *   env        — server config (keys, bases, allowlists)
 *   auth       — createAuth(...)
 *   consent    — createConsentService(...)
 *   store      — storage interface (audit log, outbox)
 *   outbox     — createOutbox(...); optional, but without it a retryable upstream
 *                failure is returned verbatim instead of being queued
 *   rateLimit  — createRateLimiter(...)
 *   dataset    — async (days) => dataset  (injected so tests skip the network)
 *   verifyIngest — (headers, rawBody) => {keyVersion}; from server/ingest.mjs
 *   agency     — createAgencyApi(...); optional. Without it the tenancy routes 404 and
 *                schema_version 2 events are refused rather than half-handled.
 *   sources    — createSources(...); resolves per-tenant ingest keys
 *   ingestV2   — createEventIngest(...); validates and persists v2 events
 *   logger     — optional
 */
export function createApp({
  env = {},
  auth,
  consent,
  store,
  outbox = null,
  rateLimit,
  dataset,
  verifyIngest = null,
  agency = null,
  sources = null,
  ingestV2 = null,
  logger = console,
  cacheMs = 5 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  if (!auth) throw new Error('createApp requires an auth gate.');
  if (!consent) throw new Error('createApp requires a consent service.');
  if (!store) throw new Error('createApp requires a store.');

  let cache = { at: 0, key: '', data: null };

  const originAllowlist = env.trackOrigins ?? [];
  const requireOrigin = env.requireOrigin === true;

  async function requirePrincipal(req) {
    return auth.authenticate(req.headers ?? {});
  }

  /**
   * Claim consent → forward upstream → consume only on acceptance.
   *
   * A retryable upstream failure queues the event in the outbox and leaves the
   * consent claim in place, so the retry can use it and the visitor is never asked
   * for consent twice. A non-retryable 4xx releases the claim and surfaces the
   * error verbatim: nothing will ever accept that payload, and holding the claim
   * would silently burn the visitor's consent.
   */
  async function deliverEvent({ input, origin, ip, userAgent, requireConsent = true }) {
    const hasConsent = Boolean(input.consentId);
    if (requireConsent && !hasConsent) {
      throw new ApiError(403, 'consent_required', 'A server-issued consentId is required for this event.');
    }
    if (requireConsent && !input.sessionId) {
      throw new ApiError(403, 'session_required', 'A tracking session is required before consent can be used.');
    }

    // core.track works in a single boolean: "do we have a basis to send this?".
    // Resolve that here, where the basis is known — a claimed consent id, or the
    // sender's own first-party record vouched for by the ingest signature.
    const event = {
      ...input,
      consent: hasConsent || input.consent === true || input.consentBasis === 'first_party_record',
    };
    if (!event.consent) {
      throw new ApiError(403, 'consent_required', 'No measurement consent on record; event dropped.');
    }

    if (hasConsent) {
      await consent.claim({
        consentId: input.consentId,
        sessionId: input.sessionId,
        scope: 'measurement',
        ip,
        userAgent,
        owner: origin,
      });
    }

    try {
      const result = await track(event, env);
      if (hasConsent) {
        const settled = await consent.consume({ consentId: input.consentId, sessionId: input.sessionId });
        return { ...result, consent: { consumedAt: settled.consumedAt, expiresAt: settled.expiresAt }, queued: false };
      }
      return { ...result, queued: false };
    } catch (error) {
      const retryable = isRetryable(error);
      const status = Number(error?.status ?? 0);
      if (!retryable || !outbox) {
        if (hasConsent) await consent.release({ consentId: input.consentId });
        throw error;
      }
      const entry = await outbox.enqueue({
        event,
        consent: hasConsent ? { consentId: input.consentId, sessionId: input.sessionId } : null,
        reason: error?.code ?? 'upstream_error',
      });
      logger.warn?.(
        `[api] ${input.eventName} ${input.eventId} queued as ${entry.id} after ${status || 'network'} failure: ${error?.message ?? error}`,
      );
      return {
        accepted: true,
        queued: true,
        outboxId: entry.id,
        eventId: input.eventId,
        eventName: input.eventName,
        reason: error?.code ?? 'upstream_error',
      };
    }
  }

  return {
    /** Drop the cached dataset (used by tests and after a push). */
    invalidateCache() {
      cache = { at: 0, key: '', data: null };
    },

    async handle(req = {}) {
      const method = (req.method ?? 'GET').toUpperCase();
      const path = req.path ?? '/';
      const headers = req.headers ?? {};
      const ip = req.ip ?? 'unknown';

      try {
        // ---------------------------------------------------------------- health
        if (path === '/api/health' && method === 'GET') {
          const h = await health(env);
          // Unauthenticated callers learn only whether the service is up and in
          // which mode. Key names, account identity and error text stay behind auth.
          const principal = await auth.authenticate(headers).catch(() => null);
          if (!principal) return { status: 200, body: publicHealth(h) };
          const storeHealth = await store.health();
          return {
            status: 200,
            body: {
              ...h,
              configuration: configuration(env),
              storage: { kind: store.kind, ok: Boolean(storeHealth.ok) },
              // The UI needs the role to disable write controls it cannot use.
              auth: { mode: auth.mode, role: principal.role, canWrite: WRITE_ROLES.has(principal.role) },
              outbox: outbox ? await outbox.stats() : null,
              // Capability, not a promise: the UI hides or disables what is not wired.
              features: {
                tenancy: Boolean(agency),
                tenantIngest: Boolean(ingestV2 && sources),
                legacyIngest: Boolean(verifyIngest),
              },
            },
          };
        }

        // ---------------------------------------------------------- dev session
        if (path === '/api/dev/session' && method === 'POST') {
          const session = auth.issueDevSession();
          if (!session) throw new ApiError(404, 'not_found', 'No route for POST /api/dev/session');
          return { status: 200, body: session };
        }

        // -------------------------------------------------------- tracking session
        // Step 1 of consent: a short-lived session the browser can bind a grant to.
        if (path === '/api/session' && method === 'POST') {
          if (rateLimit) rateLimit.hit(`session:${ip}`);
          assertOrigin(headers, originAllowlist, { requireOrigin });
          const created = await consent.createSession({ ip, userAgent: headers['user-agent'] });
          return { status: 201, body: created };
        }

        // --------------------------------------------------------------- consent
        // Step 2: record the grant for that session and receive a single-use id.
        if (path === '/api/consent' && method === 'POST') {
          if (rateLimit) rateLimit.hit(`consent:${ip}`);
          assertOrigin(headers, originAllowlist, { requireOrigin });
          const body = req.body ?? {};
          if (body.granted !== true) {
            throw new ApiError(400, 'consent_not_granted', 'Consent can only be recorded when granted is true.');
          }
          const issued = await consent.grant({
            sessionId: body.sessionId,
            scopes: Array.isArray(body.scopes) ? body.scopes : ['measurement'],
            subjectHash: typeof body.subjectHash === 'string' ? body.subjectHash : undefined,
            ip,
            userAgent: headers['user-agent'],
          });
          return { status: 201, body: issued };
        }

        // --------------------------------------------------------------- dataset
        if (path === '/api/dataset' && method === 'GET') {
          await requirePrincipal(req);
          const days = Math.min(365, Math.max(1, Number(req.query?.days ?? 90)));
          if (!configuration(env).live) {
            return { status: 200, body: { mode: 'demo', reason: 'No keys configured on the server.' } };
          }
          const key = `${days}`;
          if (cache.data && cache.key === key && now() - cache.at < cacheMs) {
            return { status: 200, body: cache.data };
          }
          const payload = { mode: 'live', dataset: await dataset(days) };
          cache = { at: now(), key, data: payload };
          return { status: 200, body: payload };
        }

        // ----------------------------------------------------------------- track
        // Browser events only: low-value signals with no money attached. A browser
        // can claim anything, so leads, orders and amounts come from /api/events.
        if (path === '/api/track' && method === 'POST') {
          if (rateLimit) rateLimit.hit(`track:${ip}`);
          assertOrigin(headers, originAllowlist, { requireOrigin });
          const body = req.body ?? {};
          if (body.consent === true || body.consent === false) {
            throw new ApiError(
              403,
              'consent_required',
              'A boolean consent field is not consent. Send a consentId issued by /api/consent.',
            );
          }
          if (SERVER_EVENTS.has(body.eventName)) {
            throw new ApiError(
              403,
              'server_event_required',
              `"${body.eventName}" reports money or identity, so it must come from your server via POST /api/events with an ingest key, not from the browser.`,
            );
          }
          if (!BROWSER_EVENTS.has(body.eventName)) {
            throw new ApiError(
              400,
              'unsupported_browser_event',
              `The browser route accepts only ${[...BROWSER_EVENTS].join(', ')}.`,
            );
          }
          if (body.amountMinor !== undefined || body.currency !== undefined) {
            throw new ApiError(
              400,
              'amount_not_allowed',
              'The browser cannot report an amount. Send money-bearing events from your server via POST /api/events.',
            );
          }

          const result = await deliverEvent({
            input: { ...body, consent: true },
            origin: 'browser',
            ip,
            userAgent: headers['user-agent'],
          });
          return { status: 202, body: result };
        }

        // ---------------------------------------------------------------- ingest
        // Server-to-server events: money, leads, orders. HMAC-authenticated with a
        // rotatable key, so the value in the payload is vouched for by the sender.
        if (path === '/api/events' && method === 'POST') {
          const rawBody = req.rawBody ?? '';
          // Parse the bytes the signature covers, once. The transport also parses the
          // body, but two parsers are two chances to act on something unverified.
          let body;
          try {
            body = rawBody ? JSON.parse(rawBody) : (req.body ?? {});
          } catch {
            throw new ApiError(400, 'malformed_json', 'Request body is not valid JSON.');
          }

          // ---------------------------------------------------- schema_version 2
          // Per-tenant ingest: the key names one source connection, and *that record*
          // decides the organization and workspace. The body cannot choose its tenant.
          if (String(body?.schema_version) === '2') {
            if (!ingestV2 || !sources) {
              throw new ApiError(
                503,
                'ingest_not_configured',
                'Tenant-scoped ingest (schema_version 2) is not configured on this server.',
              );
            }
            const keyRecord = await sources.resolveKey(headers['x-adtrack-key']);
            if (!keyRecord) {
              // Unknown, revoked and malformed keys are indistinguishable on purpose.
              throw new ApiError(
                401,
                'ingest_unauthenticated',
                'That ingest key is not recognised or has been revoked.',
              );
            }
            if (rateLimit) rateLimit.hit(`source:${keyRecord.sourceConnectionId}`);
            verifySignedPayload({
              secret: keyRecord.secret,
              headers,
              rawBody,
              now,
              toleranceSeconds: env.ingestToleranceSeconds ?? 300,
            });
            const result = await ingestV2.ingest({ source: keyRecord, body });
            return { status: result.duplicate ? 200 : 201, body: { ...result, keyVersion: keyRecord.keyVersion } };
          }

          // ---------------------------------------------------- schema_version 1
          const keyHint = headers['x-adtrack-key'] ?? 'anonymous';
          if (rateLimit) rateLimit.hit(`ingest:${keyHint}:${ip}`);
          if (!verifyIngest) {
            throw new ApiError(
              503,
              'ingest_not_configured',
              'Server-to-server ingest is not configured on this server.',
            );
          }
          const { keyVersion } = verifyIngest({ headers, rawBody });

          if (!SERVER_EVENTS.has(body.eventName)) {
            throw new ApiError(
              400,
              'event_requires_browser',
              `"${body.eventName}" is not a server event. Browser events are reported through the consent-gated /api/track.`,
            );
          }
          const basis = body.consentBasis;
          if (!CONSENT_BASES.has(basis)) {
            throw new ApiError(
              400,
              'consent_basis_required',
              `Declare consentBasis as one of: ${[...CONSENT_BASES].join(', ')}.`,
            );
          }
          if (basis === 'granted' && (!body.consentId || !body.sessionId)) {
            throw new ApiError(
              400,
              'consent_required',
              'consentBasis "granted" requires the consentId and sessionId that granted it.',
            );
          }
          if (basis === 'first_party_record' && !body.eventId) {
            throw new ApiError(400, 'missing_event_id', 'event_id is required for deduplication.');
          }

          const result = await deliverEvent({
            input: body,
            origin: 'server',
            ip,
            userAgent: headers['user-agent'],
            requireConsent: basis === 'granted',
          });
          return { status: 202, body: { ...result, keyVersion } };
        }

        // --------------------------------------------------------------- agency
        // Organizations, workspaces, campaigns, topics, leads, sources. Every one of
        // these proves membership before touching a record; none of them trusts an
        // organization id from the request without that check.
        if (agency && (path === '/api/orgs' || path.startsWith('/api/orgs/'))) {
          const principal = await requirePrincipal(req);
          const routed = await agency.handle({ method, path, body: req.body ?? {}, query: req.query, principal });
          if (routed.matched) return { status: routed.status ?? 200, body: routed.body };
        }

        const push = /^\/api\/adgroups\/([^/]+)\/hints$/.exec(path);
        if (push && method === 'POST') {
          // Authenticate first: an unauthenticated caller must never reach the
          // upstream API, and must not learn whether the ad group exists.
          const principal = await requirePrincipal(req);
          auth.requireWrite(principal);
          const adGroupId = decodeURIComponent(push[1]);
          const hints = Array.isArray(req.body?.hints) ? req.body.hints : [];

          let previous;
          try {
            previous = await pushHintSet(adGroupId, hints, env);
          } catch (error) {
            // A failed push is a security-relevant event: someone tried to change a
            // live ad group and it did not happen. Recording only successes would
            // hide exactly the incidents an audit trail exists for.
            await store.audit.append({
              id: `audit_${now()}_${Math.random().toString(36).slice(2, 8)}`,
              at: now(),
              action: 'push',
              adGroupId,
              before: [],
              after: Array.isArray(hints) ? hints : [],
              actor: principal.uid,
              actorRole: principal.role,
              ok: false,
              error: error instanceof ApiError ? `${error.code}: ${error.message}` : String(error?.message ?? error),
              errorCode: error instanceof ApiError ? error.code : 'internal_error',
              upstreamStatus: Number(error?.status) || null,
            });
            logger.warn?.(
              `[api] ${principal.uid} (${principal.role}) push to ${adGroupId} failed: ${error?.message ?? error}`,
            );
            throw error;
          }

          // Push history lives server-side, so it survives a cleared browser and is
          // visible to every admin rather than only the one who clicked.
          await store.audit.append({
            id: `audit_${now()}_${Math.random().toString(36).slice(2, 8)}`,
            at: now(),
            action: 'push',
            adGroupId,
            before: previous.previousHints ?? [],
            after: previous.pushedHints ?? hints,
            actor: principal.uid,
            actorRole: principal.role,
            ok: true,
            error: null,
            errorCode: null,
          });

          cache = { at: 0, key: '', data: null };
          logger.info?.(`[api] ${principal.uid} (${principal.role}) pushed ${hints.length} hints to ${adGroupId}`);
          return { status: 200, body: previous };
        }

        // ------------------------------------------------------------- audit log
        if (path === '/api/audit' && method === 'GET') {
          const principal = await requirePrincipal(req);
          const limit = Math.min(200, Math.max(1, Number(req.query?.limit ?? 50)));
          const adGroupId = req.query?.adGroupId || undefined;
          const ok = req.query?.ok === 'false' ? false : req.query?.ok === 'true' ? true : undefined;
          const entries = await store.audit.list({ adGroupId, limit, ok });
          return { status: 200, body: { entries, actor: principal.uid } };
        }

        // Read-only ad groups for the research target picker.
        if (path === '/api/adgroups' && method === 'GET') {
          await requirePrincipal(req);
          if (!configuration(env).live) return { status: 200, body: { mode: 'demo', adGroups: [] } };
          const campaigns = await listCampaigns(env);
          const lists = await Promise.all(campaigns.slice(0, 20).map((c) => listAdGroups(env, c.id).catch(() => [])));
          const adGroups = lists.flat().map((g) => ({
            id: String(g.id),
            campaignId: String(g.campaign_id ?? ''),
            name: String(g.name ?? g.id),
            hints: Array.isArray(g.context_hints) ? g.context_hints : [],
          }));
          return { status: 200, body: { mode: 'live', adGroups } };
        }

        return { status: 404, body: { error: { code: 'not_found', message: `No route for ${method} ${path}` } } };
      } catch (error) {
        const e = error instanceof ApiError ? error : new ApiError(500, 'internal_error', String(error));
        const status = e.status >= 400 && e.status < 600 ? e.status : 500;
        if (status >= 500) logger.error?.(`[api] ${e.code}: ${e.message}`);
        return { status, body: { error: { code: e.code, message: e.message } } };
      }
    },
  };
}
