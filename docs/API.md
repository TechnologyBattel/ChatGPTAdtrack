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
npm run api      # API server on 0.0.0.0:8787
npm run dev      # web app on 0.0.0.0:5173, proxies /api -> 8787
```

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

### `POST /api/track`

Server-side event intake. The Pixel's browser copy and this call must share
`eventId`, otherwise the conversion is counted twice.

```json
{
  "eventName": "lead_created",
  "eventId": "evt_9f3c",
  "sourceUrl": "https://shop.example.com/thanks",
  "consent": true,
  "oppref": "gAAAA…",
  "obref": "8f1c…",
  "amountMinor": 149900,
  "currency": "INR"
}
```

Rules enforced server-side, not trusted from the client:

| Check | Failure |
|---|---|
| `consent === true` | `403 consent_required` — no request is made upstream |
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
an email address.

## Production

The API is stateless, so it deploys as a container:

```bash
gcloud run deploy adtrack-api \
  --source . \
  --region asia-south1 \
  --set-secrets OPENAI_ADS_API_KEY=ads-key:latest,OPENAI_CONVERSIONS_API_KEY=capi-key:latest,OPENAI_PIXEL_ID=pixel-id:latest \
  --allow-unauthenticated
```

Then set `VITE_API_BASE=https://adtrack-api-…run.app` for the web build, or front
both behind one domain and keep the `/api` prefix. Cloud Functions are the
alternative once Firestore writes and the scheduler land (PLAN.md slices 2–3); the
handlers in `server/core.mjs` are already pure and env-injected so they port as-is.

## Tests

`src/lib/__tests__/server.test.ts` covers the contract with a fake `fetch`:
no network, no keys required. `scripts/check-server.mjs` boots the real server in
demo mode, asserts the consent gate rejects, and asserts no key material is echoed.
Both run in `npm run verify`.
