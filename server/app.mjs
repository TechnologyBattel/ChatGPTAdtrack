// The router. Transport-free on purpose: `handle()` takes a plain request
// description and returns a status + body, so every rule can be tested without
// opening a socket or touching a real ad account.

import { ApiError } from './errors.mjs';
import { configuration, health, listAdGroups, listCampaigns, pushHintSet, track } from './core.mjs';
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
 *   store      — storage interface (audit log)
 *   rateLimit  — createRateLimiter(...)
 *   dataset    — async (days) => dataset  (injected so tests skip the network)
 *   logger     — optional
 */
export function createApp({
  env = {},
  auth,
  consent,
  store,
  rateLimit,
  dataset,
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
              auth: { mode: auth.mode, role: principal.role },
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
        if (path === '/api/track' && method === 'POST') {
          // Track is the one public write path, so it carries every other guard.
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
          // Session first: it is cheap to check and gives a clearer error than a
          // signature failure when the client forgot to start one.
          await consent.requireSession(body.sessionId);
          const grant = await consent.consume({
            consentId: body.consentId,
            sessionId: body.sessionId,
            scope: 'measurement',
          });

          const result = await track(
            {
              eventName: body.eventName,
              eventId: body.eventId,
              sourceUrl: body.sourceUrl,
              timestampMs: body.timestampMs,
              oppref: body.oppref,
              obref: body.obref,
              amountMinor: body.amountMinor,
              currency: body.currency,
              consent: true, // verified above
              user: body.user,
            },
            env,
          );
          return {
            status: 202,
            body: { ...result, consent: { expiresAt: grant.expiresAt, consumedAt: grant.consumedAt } },
          };
        }

        // ------------------------------------------------------------ hint push
        const push = /^\/api\/adgroups\/([^/]+)\/hints$/.exec(path);
        if (push && method === 'POST') {
          // Authenticate first: an unauthenticated caller must never reach the
          // upstream API, and must not learn whether the ad group exists.
          const principal = await requirePrincipal(req);
          auth.requireWrite(principal);
          const adGroupId = decodeURIComponent(push[1]);
          const hints = Array.isArray(req.body?.hints) ? req.body.hints : [];
          const previous = await pushHintSet(adGroupId, hints, env);

          // Push history now lives server-side, so it survives a cleared browser and
          // is visible to every admin rather than only the one who clicked.
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
          const entries = await store.audit.list({ adGroupId, limit });
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
