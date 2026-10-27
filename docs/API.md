# API contract

The browser talks only to our own server. The server holds every key. Nothing in
the browser bundle can reach `api.ads.openai.com` or `bzr.openai.com`.

```
browser ──/api/*──▶ our server (server/dev.mjs locally, Cloud Run in prod) ──▶ OpenAI Ads
                     OPENAI_ADS_API_KEY
                     OPENAI_CONVERSIONS_API_KEY
                     OPENAI_PIXEL_ID
```

## Running it

```bash
npm run api      # API server on 0.0.0.0:8787  (server/server.mjs)
npm run dev      # web app on 0.0.0.0:5173, proxies /api -> 8787
```

`server/dev.mjs` remains as an alias that imports `server/server.mjs`, so older
scripts and notes keep working.

## Security model

| Route | Auth | Extra guards |
|---|---|---|
| `GET /api/health` | optional | Unauthenticated callers get `{ok, mode}` only |
| `POST /api/consent` | none | Origin allowlist, per-IP rate limit |
| `POST /api/track` | none, but a **consent id** is required | Origin allowlist, per-IP rate limit, body cap; **low-value browser events only** |
| `POST /api/events` | HMAC ingest key (`X-ADTrack-*`) | Replay window ±300 s, per-key rate limit; leads, orders and amounts only |
| `GET /api/dataset` | token | — |
| `GET /api/adgroups` | token | — |
| `POST /api/adgroups/:id/hints` | token, **admin or owner** | Reversible, audited |
| `GET /api/audit?adGroupId=&ok=&limit=` | token | Push history from the server store, failures included (`ok=false`) |
| `POST /api/session` | none (origin allowlist + rate limit) | Starts the consent handshake |
| `POST /api/consent` | session id | Records the grant, returns a single-use id |
| `POST /api/dev/session` | none | Dev mode only; 404 in production |

Auth is pluggable:

```js
createAuth({ mode: 'dev', devToken, devRole })            // shared token, local/dev
createAuth({ mode: 'firebase', verifyToken })             // Firebase ID tokens
createAuth({ mode: 'firebase', verifyToken: fakeVerifier })// tests, no network
```

`AUTH_MODE=firebase` uses `firebase-admin` (an **optionalDependency**, imported lazily)
to verify the ID token, including revocation, and reads the role from the `role` custom
claim. An unknown or missing role becomes `viewer`, never a write role. Production refuses
to start with `AUTH_MODE=dev` or with no `AUTH_MODE` at all, and `AUTH_MODE=dev` refuses to
start at all when any ad account key is set. Roles, first-admin bootstrap, token storage
and the CSP live in [SECURITY.md](SECURITY.md).

Writes are gated **before** any upstream call: an unauthenticated or under-privileged
push returns 401/403 and the OpenAI API is never contacted. Both the unit tests and
`scripts/e2e-push.mjs` assert this.

### Deployment shape: same origin, no CORS

The app is served from the **same origin** as its API. `vite.config.ts` proxies `/api`
in development and preview, and in production both are fronted by one host with an
`/api` prefix (reverse proxy rewrite); the browser only ever calls relative URLs.

That is a decision, not an accident: no CORS headers are sent, so a browser on another
origin cannot read a response even for the public routes, and the page never needs to
resolve `localhost` (which would be the *user's* machine, not ours). Adding CORS later
means also widening the CSP `connect-src` in `server/csp.mjs` to name the API host —
both, at once, or the browser blocks the call after the server allowed it. The
`TRACK_ORIGINS` allowlist stays either way; it answers "which sites may report events",
not "which origins may call the API".

## Modes

| Mode | When | Behaviour |
|---|---|---|
| `demo` | no keys on the server | deterministic 90-day dataset; page still works |
| `live` | Advertiser key + Pixel ID present, `/ad_account` verifies | real campaigns, insights, hint sets |
| `error` | keys present but rejected | the reason from OpenAI is surfaced verbatim; UI stays usable |

The UI never guesses: `GET /api/health` reports `mode`, which keys are configured
(presence only — never values), and the account name/currency/timezone.

## Endpoints

### `GET /api/health`

```json
{
  "ok": true,
  "mode": "live",
  "configuration": { "adsKey": true, "capiKey": true, "pixelId": true, "adsKeyHint": "ak_…23", "live": true },
  "account": { "id": "adacct_123", "name": "Acme Ads", "currency": "INR", "timezone": "Asia/Kolkata", "status": "active", "review": "approved" },
  "auth": { "mode": "firebase", "role": "analyst", "canWrite": false },
  "storage": { "ok": true, "kind": "firestore" },
  "outbox": { "pending": 0, "dead": 0, "delivered": 41 }
}
```

`auth.canWrite` is the server's own role check (`admin`/`owner`), not something the UI
recomputes: the push button is disabled from it, so a client-side role bug cannot turn
into a write. `outbox` reports queue depth and dead letters, and is `null` when no
outbox is wired up. Unauthenticated callers still get `{ok, mode}` only.

The key hint is 3 characters, an ellipsis and the last 2 — enough to tell *which*
key is loaded, not enough to use it. Tests assert no key material appears in any response.

### `GET /api/dataset?days=90`

Returns `{ mode: 'live', dataset }` or `{ mode: 'demo', reason }`. Cached for 5
minutes so a page refresh cannot burn the rate limit.

Live mapping rules:

- `spend` (major units, decimal string) → `spendMinor` integer paise. Never floats in the browser.
- Three reports are fetched, each at the aggregation its view needs: `country` and
  `device` (a single request carries one segment only, so they stay in separate arrays
  and device rows are excluded from every total) and a separate `ad_group` report whose
  rows arrive as `adGroupRows`. Ad-group views read only `adGroupRows`, because an
  ad-group number derived from campaign rows is a different measurement.
- Each report asks for its own id field (`campaign_id` at campaign aggregation,
  `ad_group_id` at ad_group aggregation). There is deliberately **no** ad-group-id
  fallback to the campaign id: a fabricated ad group would map real spend onto the
  wrong entity, so a report that omits `ad_group_id` yields no ad-group rows.
- `firstPartyAvailable: false` whenever no first-party source is configured. The UI
  masks lead, customer, CPL, CAC, ROAS and revenue with `—` rather than showing a
  confident ₹0. A fake zero is worse than an em dash.
- `conversionsNative` includes 1-day view-through; `viewThrough` is kept separately
  so the native/internal comparison stays legible.

### `POST /api/session`

Step 1 of two. Returns a short-lived session id bound to the caller's IP and user agent
(30 minutes by default). Required before any consent can be recorded.

```json
{ "sessionId": "sess_…", "expiresAt": "2026-10-25T06:45:00.000Z", "ttlSeconds": 1800 }
```

### `POST /api/consent`

Step 2. Records a grant against a session and returns a signed, **single-use** id.

```json
{ "granted": true, "sessionId": "sess_…", "scopes": ["measurement"], "subjectHash": "optional" }
```

```json
{ "consentId": "eyJ2Ijox….Xk3…", "scopes": ["measurement"], "expiresAt": "2026-10-25T06:30:00.000Z", "ttlSeconds": 900 }
```

Refuses `granted: false` with `400 consent_not_granted`, a missing session with
`403 session_required`, and a request with no supported scope with `400 no_valid_scope`.
The id is an HMAC-SHA256 signature over a base64url payload
(`{v, kv, sid, scopes, sub, iat, exp, jti}`), recorded in the store so the first
`/api/track` can burn it. Who can obtain one, and what stops abuse, is in
[SECURITY.md §3](SECURITY.md).

### `POST /api/track` — browser events

Event intake for signals a browser is allowed to report. The Pixel's browser copy and
this call must share `eventId`, otherwise the conversion is counted twice.

Accepted names are exactly `page_viewed`, `contents_viewed`, `checkout_started` and
`items_added`. Anything else is refused: a browser cannot be trusted to say a lead
exists or what an order was worth, so those go through `/api/events`.

```json
{
  "eventName": "page_viewed",
  "eventId": "evt_9f3c",
  "sourceUrl": "https://shop.example.com/thanks",
  "sessionId": "sess_…",
  "consentId": "eyJ2Ijox….Xk3…",
  "oppref": "gAAAA…",
  "obref": "8f1c…"
}
```

A response is either a delivery or a queue:

```json
{ "ok": true, "eventId": "evt_9f3c", "queued": false, "consent": { "consumedAt": "…", "expiresAt": "…" } }
{ "accepted": true, "queued": true, "outboxId": "ob_…", "eventId": "evt_9f3c", "reason": "upstream_unavailable" }
```

`queued: true` means the upstream was down in a retryable way (5xx/429/network). The
event is in the outbox and the consent id is **not** consumed, so the retry can use it;
the id is only marked used when the upstream accepts. See "Delivery and retry" below.

`consent: true` is **rejected**: a boolean is not consent, because the client can
always send `true`. Send a bootstrapped session and a server-issued, single-use id:

Rules enforced server-side, not trusted from the client:

| Check | Failure |
|---|---|
| An existing session | `403 session_required` / `session_invalid` |
| Consent id signature, scope, lifetime, session binding, not already used | `403 consent_required` / `consent_invalid` / `consent_expired` / `consent_scope_missing` / `consent_session_mismatch` / `consent_replayed` |
| Origin in `TRACK_ORIGINS` | `403 origin_not_allowed` |
| Per-IP rate limit (`RATE_LIMIT_PER_MINUTE`, default 60/min) | `429 rate_limited` |
| Body under `MAX_BODY_BYTES` (default 256 KB), enforced while streaming | `413 payload_too_large` |
| `eventId` present | `400 missing_event_id` |
| event name in the supported list | `400 unsupported_event` |
| Event is a browser event | `403 server_event_required` (money/identity) or `400 unsupported_browser_event` |
| No `amountMinor`/`currency` from a browser | `400 amount_not_allowed` |
| `oppref` passed through unmodified | never rewritten |
| `obref` goes inside `user`, unhashed | never hashed |
| `data.type` matches the event family | set from `EVENT_DATA_TYPE` |

`5xx` and `429` are retried three times with exponential backoff before failing; after
that the event is queued (above) rather than dropped.

### `POST /api/events` — server events

The route for anything that reports money or identity: `lead_created`, `order_created`,
`registration_completed`, `trial_started`, `subscription_created`,
`appointment_scheduled`, `custom`. It is authenticated with a shared HMAC key, so the
server that recorded the order — not the browser — vouches for the amount.

```
X-ADTrack-Key: v2                     key version, rotatable
X-ADTrack-Timestamp: 1761283200       unix seconds, ±INGEST_MAX_SKEW_SECONDS (default 300)
X-ADTrack-Signature: <hex hmac>       HMAC-SHA256 over `${timestamp}.${rawBody}`
```

```json
{
  "eventName": "order_created",
  "eventId": "order_8817",
  "sourceUrl": "https://shop.example.com/thanks",
  "amountMinor": 149900,
  "currency": "INR",
  "consentBasis": "first_party_record"
}
```

`consentBasis` is mandatory and must be one of:

| Basis | Meaning | Requires |
|---|---|---|
| `granted` | the visitor consented in the browser | `consentId` + `sessionId` from `/api/consent` |
| `first_party_record` | the sender's own record is the lawful basis | `eventId` for deduplication |

The signature covers the **raw bytes** received, and the route parses those bytes rather
than a second copy, so a body that changed after signing is refused
(`401 ingest_signature_invalid`) — reversing JSON key order or editing the amount both
break it. Keys are versioned: during a rotation both the new and the old version are
accepted, and a retired version returns `401 ingest_key_unknown`. No key configured
means `503 ingest_not_configured`, so an unconfigured deployment cannot be used as an
anonymous conversion pump.

Browser events posted here get `400 event_requires_browser`; the browser route is the
only place they belong.

### Delivery and retry (outbox)

Consent is consumed **after** the upstream accepts, never before:

1. claim the consent id (a second concurrent attempt gets `403 consent_in_flight`)
2. forward to OpenAI
3. on success: mark the id used and return `queued: false`
4. on a retryable failure (5xx/429/network): enqueue in the outbox, keep the claim, return
   `queued: true` — a background drain retries with exponential backoff
   (`OUTBOX_BASE_DELAY_MS`, doubling to `OUTBOX_MAX_DELAY_MS`)
5. on a non-retryable failure (4xx): release the claim and surface the upstream error

After `OUTBOX_MAX_ATTEMPTS` the entry is dead-lettered: the consent id is released (the
visitor is not silently burned) and the give-up is written to the audit log. Failures
are visible at `GET /api/audit?ok=false`; the outbox counters are in `/api/health`.

### `POST /api/adgroups/:id/hints`

```json
{ "hints": ["a business owner asking how to reconcile invoices before the filing deadline"] }
```

Returns the **previous** hint set so the caller can offer a one-click rollback:

```json
{ "adGroupId": "adgrp_301", "previousHints": ["..."], "pushedHints": ["..."], "versionedAt": "2026-10-24T…" }
```

Refuses an empty set, more than 2,000 hints, non-strings, and any hint containing
an email address. Upstream status codes are preserved (a 403 stays a 403) and the
upstream `error.message` is passed through unmodified.

The UI wraps this in a confirm gate: a diff of current vs proposed hints, then an
explicit push, then an Undo button that re-pushes `previousHints`. Every attempt —
successful or not — is appended to a local audit log (`adtrack.audit.v1`,
100 entries, `{ at, action, adGroupId, before, after, ok, error }`).

Because OpenAI stores no hint history, `previousHints` in the response is the only
rollback copy that exists. It lives in the browser's audit log, so it survives a
page reload but not a cleared profile — worth knowing before a bulk change.

## Agency routes (Phase 1)

Organizations, workspaces, campaigns, topics, leads and sources are mounted under
`/api/orgs`. They require a bearer token, and every decision uses the caller's **membership**
role for the organization in the path — a global token role proves nothing about a tenant.
Full semantics, the permission matrix and the rationale are in
[`AGENCY_MODEL.md`](./AGENCY_MODEL.md); this is the route index.

| Group | Routes |
|---|---|
| Organizations | `GET/POST /api/orgs`, `GET/PUT /api/orgs/:org/members`, `DELETE /api/orgs/:org/members/:userId`, `GET /api/orgs/:org/permissions` |
| Workspaces | `GET/POST /api/orgs/:org/workspaces`, `DELETE /api/orgs/:org/workspaces/:ws`, `GET .../:ws/summary` |
| Campaigns | `GET/POST .../:ws/campaigns`, `PATCH .../:ws/campaigns/:id`, `POST .../:ws/utm` |
| Topics | `GET/POST .../:ws/topics`, `PATCH .../:ws/topics/:id` |
| Leads | `GET .../:ws/leads`, `POST .../:ws/leads/:leadId/qualification`, `GET .../:ws/leads/:leadId/attribution` |
| Sources | `GET/POST .../:ws/sources`, `POST .../:ws/sources/:id/rotations`, `POST .../:ws/sources/:id/revocations`, `DELETE .../:ws/sources/:id` |
| Data ops | `POST /api/orgs/:org/retention/purge` (owner only) |

Status codes: `201` on creation, `200` otherwise; `404 not_found` for an organization,
workspace, campaign, topic, lead or source you are not a member of (identical for
nonexistent ids — a `403` would confirm existence); `403 forbidden` when your role lacks
the named permission; `409 last_owner` when the change would leave an organization without
an owner.

`.../:ws/summary` never invents numbers. It returns `unavailable: ['search_volume', 'cpc',
'competitor_ad_spend', 'trend_growth']`, a `missing` list, and `freshness.lastEventAt: null`
when nothing has arrived — "not measured" and "zero" are different facts.

### `POST /api/events` (schema v2)

Tenant-scoped ingest for the eight-step lead lifecycle. The key names the source
connection, and that record decides the organization and workspace; a body claiming another
tenant is `403 tenant_mismatch`. Signed with `X-ADTrack-Key`, `X-ADTrack-Timestamp` and
`X-ADTrack-Signature` (hex HMAC-SHA256 over `${timestamp}.${rawBody}`).

```json
{
  "schema_version": 2,
  "event_id": "evt_01J9Z8Q1",
  "event_type": "lead_created",
  "occurred_at": "2025-10-09T14:03:00+05:30",
  "event_source": "crm",
  "consent_state": "granted",
  "country_code": "IN",
  "crm_record_reference": "deal_8842"
}
```

`201` for a new event, `200 { duplicate: true }` for a replay of the same
`(workspace, event_id)` — the sender's retry worked and nothing was counted twice.
`amount_minor` is only valid on `order_created` / `refund_or_cancellation`, and revenue is
derived from it rather than asserted. Full envelope, rejection codes and qualification
rules are in [`EVENT_SCHEMA.md`](./EVENT_SCHEMA.md).

## Research and connector routes (Phase 2)

Both families live under the same organization/workspace path as every other agency route,
so the tenant check is the same code (`tenancy.context`), not a parallel implementation.

| Route | Auth | What it does |
|---|---|---|
| `GET .../:ws/research/plan` | bearer, `data.read` | Goals and the server's own list of steps |
| `POST .../:ws/research/runs` | bearer, `research.write` | Computes the report from stored records, saves it, audits `research.run`. Body: `{goal, note?}`; anything else in the body is ignored |
| `GET .../:ws/research/runs` | bearer, `research.read` | Saved runs, newest first (summaries), `?limit=` ≤ 50 |
| `GET .../:ws/research/runs/:runId` | bearer, `research.read` | One saved report, exactly as computed |
| `DELETE .../:ws/research/runs/:runId` | bearer, `research.write` | Deletes a run; audits `research.delete` |
| `GET .../:ws/connectors/hubspot` | bearer, `data.read` | Connection status, scopes, `lastSyncAt`, `lastSyncStatus`, `lastError`, `nextAction` |
| `POST .../:ws/connectors/hubspot/connect` | bearer, `source.manage` | Returns `{authorizationUrl, state}`. `503 connector_not_configured` when the server has no OAuth client |
| `POST .../:ws/connectors/hubspot/connect/complete` | bearer, `source.manage` | Body `{code, state}`; exchanges the code and seals the tokens |
| `POST .../:ws/connectors/hubspot/sync` | bearer, `source.manage` | One bounded import; returns counts and an honest `lastSyncStatus` |
| `POST .../:ws/connectors/hubspot/disconnect` | bearer, `source.manage` | Clears `auth` and the checkpoint; historical events stay |
| `POST /api/connectors/hubspot/webhook/:org/:sourceConnectionId` | **HubSpot v3 signature** | Public by necessity: no bearer token. Verified against the raw body, the full URL and a 5-minute window. `503 webhook_not_configured` without `PUBLIC_BASE_URL` |

A sync response is a report, not a success message:

```json
{
  "status": "degraded",
  "lastSyncStatus": "partial",
  "partial": true,
  "trigger": "manual",
  "imported": 200,
  "duplicates": 0,
  "skipped": 0,
  "pages": 2,
  "countsSemantics": "unique events stored; a duplicate is one the server already had",
  "error": { "code": "sync_incomplete", "message": "Pagination stopped at the configured page limit…" },
  "connection": { "status": "degraded", "nextAction": "run_sync" }
}
```

`imported` counts events this run actually created. Re-running an import is safe: the event
ids are deterministic, so a second pass reports `duplicates` and stores nothing new.

## Production

The API is stateless, so it deploys as a container:

```bash
gcloud run deploy adtrack-api \
  --source . \
  --region asia-south1 \
  --set-secrets OPENAI_ADS_API_KEY=ads-key:latest,OPENAI_CONVERSIONS_API_KEY=capi-key:latest,OPENAI_PIXEL_ID=pixel-id:latest,CONSENT_SECRETS=consent-secrets:latest,INGEST_KEYS=ingest-keys:latest \
  --set-env-vars AUTH_MODE=firebase,FIREBASE_PROJECT_ID=your-project,STORAGE=firestore,TRUST_PROXY=1,TRACK_ORIGINS=https://app.example.com,INGEST_KEY_VERSION=v1,OUTBOX_ENABLED=true \
  --allow-unauthenticated
```

`--allow-unauthenticated` is required for the public `/api/track`, `/api/events` and
`/api/health` routes (the ingest route authenticates with its HMAC key, not the platform).
Everything else is protected by the app's own auth gate, which is why the production
start-up guards matter: the container refuses to boot with dev auth.

The image runs as the unprivileged `node` user, uses `tini` as PID 1, and carries a
`HEALTHCHECK` that probes `GET /api/health`.

> **Rate limiting is per instance.** It is an in-memory fixed window, so with N
> replicas the effective limit is N × the configured value. Use a shared store before
> relying on it for anything that matters.

## Deployment notes

- `TRACK_ORIGINS` empty means **no** cross-origin tracking. Set it explicitly.
- `TRACK_REQUIRE_ORIGIN=true` also refuses server-to-server calls that send no Origin.
- Leave `ADS_API_BASE` / `EVENTS_API_BASE` unset in production; they exist only so the
  e2e stub can stand in for OpenAI.

Serve the web build from the same origin as the API and reverse-proxy `/api` to it
(keep the prefix). `VITE_API_BASE` still exists for special cases, but pointing the
browser at another origin only works if CORS and the CSP `connect-src` are widened
together — so the supported deployment is one domain, no CORS (see "Deployment shape"). Cloud Functions are the
alternative once Firestore writes and the scheduler land (PLAN.md slices 2–3); the
handlers in `server/core.mjs` are already pure and env-injected so they port as-is.

## Tests

| Layer | Where | Covers |
|---|---|---|
| Security rules | `src/lib/__tests__/security.test.ts` | 83 cases: auth modes, role gate, unauthenticated push never reaching upstream, consent ids (claim/consume/release, session binding, rotation), browser-vs-server events, HMAC ingest (tampering, staleness, rotation), outbox queue/retry/dead-letter, failed-push audit, rate limit, origin allowlist, body cap, health disclosure, cache invalidation |
| Firestore artefacts | `src/lib/__tests__/firestore.test.ts` | deny-all rules, every composite index the store's queries need; adapter tests run only when an emulator + `firebase-admin` are present, and skip loudly otherwise |
| Handler units | `src/lib/__tests__/server.test.ts` | fake `fetch`: auth, mapping, consent gate, retries, push guards |
| Component | `src/lib/__tests__/push.test.tsx` | demo-mode disabled state, diff modal, confirm gate, undo, verbatim errors, audit log |
| Server smoke | `scripts/check-server.mjs` | boots the real server in demo mode; auth, consent, origin, size limits, no key echoed |
| Production guards | `scripts/check-prod-guards.mjs` | refuses to start with dev auth in production, dev auth plus ad account keys, no `AUTH_MODE`, no `CONSENT_SECRETS`, `STORAGE=memory`, no `TRACK_ORIGINS`, a bad `TRUST_PROXY`, or an unknown mode |
| Transport rules | `src/lib/__tests__/transport.test.ts` | streaming body cap, spoofed `X-Forwarded-For`, API headers — over a real socket |
| End-to-end | `scripts/e2e-push.mjs` | real HTTP server against a **stub** of api.ads.openai.com: live health, minor-unit mapping, push → previous set, local guard rails, undo, 403 pass-through, no key leakage |

All of them run in `npm run verify`. `ADS_API_BASE` / `EVENTS_API_BASE` exist only for
that stub; production never sets them.

**Not verified:** that the real OpenAI Ads API accepts these payloads, returns the
field names assumed here, or that `context_hints` round-trips exactly as sent. That
needs a real ad account and key, which by design are not in this repository.
