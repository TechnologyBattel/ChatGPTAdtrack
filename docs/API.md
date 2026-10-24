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
| `POST /api/track` | none, but a **consent id** is required | Origin allowlist, per-IP rate limit, body cap |
| `GET /api/dataset` | token | — |
| `GET /api/adgroups` | token | — |
| `POST /api/adgroups/:id/hints` | token, **admin or owner** | Reversible, audited |
| `POST /api/dev/session` | none | Dev mode only; 404 in production |

Auth is pluggable:

```js
createAuth({ mode: 'dev', devToken, devRole })            // shared token, local/dev
createAuth({ mode: 'firebase', verifyToken })             // Firebase ID tokens
createAuth({ mode: 'firebase', verifyToken: fakeVerifier })// tests, no network
```

`AUTH_MODE=firebase` uses `firebase-admin` (lazily imported) to verify the ID token,
including revocation, and reads the role from the `role` custom claim. An unknown or
missing role becomes `viewer`, never a write role. Production refuses to start with
`AUTH_MODE=dev` or with no `AUTH_MODE` at all.

Writes are gated **before** any upstream call: an unauthenticated or under-privileged
push returns 401/403 and the OpenAI API is never contacted. Both the unit tests and
`scripts/e2e-push.mjs` assert this.

`vite.config.ts` proxies `/api`, so the preview URL works without CORS and the
browser never needs to resolve `localhost`.

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
  "account": { "id": "adacct_123", "name": "Acme Ads", "currency": "INR", "timezone": "Asia/Kolkata", "status": "active", "review": "approved" }
}
```

The key hint is 3 characters, an ellipsis and the last 2 — enough to tell *which*
key is loaded, not enough to use it. Tests assert no key material appears in any response.

### `GET /api/dataset?days=90`

Returns `{ mode: 'live', dataset }` or `{ mode: 'demo', reason }`. Cached for 5
minutes so a page refresh cannot burn the rate limit.

Live mapping rules:

- `spend` (major units, decimal string) → `spendMinor` integer paise. Never floats in the browser.
- Two reports are fetched: one `country`-segmented, one `device`-segmented. A single
  request carries one segment only, so they are kept in separate arrays and device
  rows are excluded from every total. Country rows stay in `rows`.
- `firstPartyAvailable: false` whenever no first-party source is configured. The UI
  masks lead, customer, CPL, CAC, ROAS and revenue with `—` rather than showing a
  confident ₹0. A fake zero is worse than an em dash.
- `conversionsNative` includes 1-day view-through; `viewThrough` is kept separately
  so the native/internal comparison stays legible.

### `POST /api/consent`

Records a grant and returns a signed id. The browser must call this *before* any
event, and store the id with the session.

```json
{ "granted": true, "scopes": ["measurement"], "subjectHash": "optional" }
```

```json
{ "consentId": "eyJ2Ijox….Xk3…", "scopes": ["measurement"], "expiresAt": "2027-04-22T…" }
```

Refuses `granted: false` with `400 consent_not_granted`, and refuses a request with no
supported scope. The id is an HMAC-SHA256 signature over a base64url payload
(`{v, jti, scopes, sub, iat, exp}`); verification is stateless, so no database is
needed to demo it. **Production still needs to persist the grant** for the audit trail.

### `POST /api/track`

Server-side event intake. The Pixel's browser copy and this call must share
`eventId`, otherwise the conversion is counted twice.

```json
{
  "eventName": "lead_created",
  "eventId": "evt_9f3c",
  "sourceUrl": "https://shop.example.com/thanks",
  "consentId": "eyJ2Ijox….Xk3…",
  "oppref": "gAAAA…",
  "obref": "8f1c…",
  "amountMinor": 149900,
  "currency": "INR"
}
```

`consent: true` is **rejected**: a boolean is not consent, because the client can
always send `true`. Send the signed id instead.

Rules enforced server-side, not trusted from the client:

| Check | Failure |
|---|---|
| A server-issued consent id, valid signature, unexpired, right scope | `403 consent_required` / `consent_invalid` / `consent_expired` / `consent_scope_missing` |
| Origin in `TRACK_ORIGINS` | `403 origin_not_allowed` |
| Per-IP rate limit (`RATE_LIMIT_PER_MINUTE`, default 60/min) | `429 rate_limited` |
| Body under `MAX_BODY_BYTES` (default 256 KB) | `413 payload_too_large` |
| `eventId` present | `400 missing_event_id` |
| event name in the supported list | `400 unsupported_event` |
| `amount` always has a currency | `400 missing_currency` |
| `oppref` passed through unmodified | never rewritten |
| `obref` goes inside `user`, unhashed | never hashed |
| `data.type` matches the event family | set from `EVENT_DATA_TYPE` |

`5xx` and `429` are retried three times with exponential backoff before failing.

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

## Production

The API is stateless, so it deploys as a container:

```bash
gcloud run deploy adtrack-api \
  --source . \
  --region asia-south1 \
  --set-secrets OPENAI_ADS_API_KEY=ads-key:latest,OPENAI_CONVERSIONS_API_KEY=capi-key:latest,OPENAI_PIXEL_ID=pixel-id:latest,CONSENT_SECRET=consent-secret:latest \
  --set-env-vars AUTH_MODE=firebase,FIREBASE_PROJECT_ID=your-project,TRACK_ORIGINS=https://app.example.com \
  --allow-unauthenticated
```

`--allow-unauthenticated` is required for the public `/api/track` and `/api/health`
routes. Everything else is protected by the app's own auth gate, which is why the
production start-up guards matter: the container refuses to boot with dev auth.

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

Then set `VITE_API_BASE=https://adtrack-api-…run.app` for the web build, or front
both behind one domain and keep the `/api` prefix. Cloud Functions are the
alternative once Firestore writes and the scheduler land (PLAN.md slices 2–3); the
handlers in `server/core.mjs` are already pure and env-injected so they port as-is.

## Tests

| Layer | Where | Covers |
|---|---|---|
| Security rules | `src/lib/__tests__/security.test.ts` | 47 cases: auth modes, role gate, unauthenticated push never reaching upstream, consent ids, rate limit, origin allowlist, body cap, health disclosure, cache invalidation |
| Handler units | `src/lib/__tests__/server.test.ts` | fake `fetch`: auth, mapping, consent gate, retries, push guards |
| Component | `src/lib/__tests__/push.test.tsx` | demo-mode disabled state, diff modal, confirm gate, undo, verbatim errors, audit log |
| Server smoke | `scripts/check-server.mjs` | boots the real server in demo mode; auth, consent, origin, size limits, no key echoed |
| Production guards | `scripts/check-prod-guards.mjs` | refuses to start with dev auth in production, no `AUTH_MODE`, no `CONSENT_SECRET`, or an unknown mode |
| End-to-end | `scripts/e2e-push.mjs` | real HTTP server against a **stub** of api.ads.openai.com: live health, minor-unit mapping, push → previous set, local guard rails, undo, 403 pass-through, no key leakage |

All four run in `npm run verify`. `ADS_API_BASE` / `EVENTS_API_BASE` exist only for
that stub; production never sets them.

**Not verified:** that the real OpenAI Ads API accepts these payloads, returns the
field names assumed here, or that `context_hints` round-trips exactly as sent. That
needs a real ad account and key, which by design are not in this repository.
