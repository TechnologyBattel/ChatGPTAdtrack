# Connector contract

_Date: 2026-10-26 · Code: `server/sources.mjs`, `server/ingest.mjs`, `server/app.mjs`, `server/connectors/*.mjs`_

This document defines how a data source connects to AdTrack. It is a **contract**, and
that is all: every provider that exists in code today is a *category*, not an integration.
There is no OpenAI Ads client, no HubSpot client, no Google Search Console client, and no
sample payload that pretends to be one.

## 1. What a connector is (and is not)

A connector is a **named, tenant-scoped credential plus a capability declaration**. It is
not an SDK, not an OAuth flow, and not a background poller.

| The connector **is** | The connector **is not** |
|---|---|
| A row in `sources` (`provider`, `capability`, `status`, `trustedForQualification`) | A promise that the upstream API works |
| One or more rotating ingest keys, returned once and never readable again | A shared global password |
| A permission boundary: its key decides the organization and workspace of every event it sends | A sender that chooses its own tenant |
| An explicit trust decision for lead qualification | Something inferred from the provider name |

Four provider *categories* exist (`PROVIDERS` in `server/sources.mjs`):

| `provider` | Direction | Can be trusted to qualify leads | Notes |
|---|---|---|---|
| `openai_ads` | read; **write** only here | no | The only write-capable provider (hint push, an existing admin-only action) |
| `crm` | read | **yes, if explicitly flagged** | The only category that may send `lead_qualified` |
| `search_console` | read | no | Supplies observed research topics |
| `generic` | read | no | A customer's own backend, sending signed events |

Asking for `capability: 'write'` on anything except `openai_ads` returns
`400 write_not_supported` with the reason. Asking for `trustedForQualification: true` on
anything except `crm` returns `400 trusted_source_must_be_crm`. Both are refused
rather than downgraded silently.

## 2. Lifecycle

```
create → issue key v1 ──▶ events ──▶ rotate → key v2 (v1 still valid)
                                   └─▶ revoke(v1) → v1 refused, v2 unaffected
                                   └─▶ disconnect → every version revoked, status=disconnected
```

- **Create** returns the secret **once**: `{ source, key: { keyId, keyVersion, secret } }`.
- **Rotate** issues the next key version; the previous version keeps working until it is
  revoked. This is what makes rotation possible without a gap.
- **Revoke** targets one `keyVersion`, so retiring a leaked key does not break the
  integration that moved on.
- **Disconnect** revokes every version and marks the source `disconnected`. Historical
  events stay (they happened); a disconnected source simply cannot send more.
- A revoked, unknown or malformed key is indistinguishable (`401 ingest_unauthenticated`):
  the response must not confirm that a key id exists.
- Listings never include secrets or fingerprints. Tests assert no key material appears in
  any response body.

## 3. Transport

All connectors use the same transport, whether the sender is a CRM's webhook relay, a
serverless function, or a script:

```
POST /api/events
X-ADTrack-Key: <sourceConnectionId>.<keyVersion>
X-ADTrack-Timestamp: <unix seconds>
X-ADTrack-Signature: hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
```

- The signature covers the raw body bytes, so the sender must not re-encode the JSON after
  signing.
- Clock skew beyond ±300 s is rejected (`ingest_timestamp_stale`); the window is
  deliberate — it bounds replay without demanding perfect clocks.
- Per-source rate limiting is applied per source connection, so one noisy integration
  cannot exhaust another tenant's budget.
- The secret is stored to be compared, never logged, never returned.

### Minimum viable sender (pseudocode, provider-free)

```js
const body = JSON.stringify({
  schema_version: 2,
  event_id: idempotencyKey,          // stable across retries — this is what makes retry safe
  event_type: 'lead_created',
  occurred_at: new Date().toISOString(),
  event_source: 'crm',
  crm_record_reference: 'deal_8842',
  anonymous_session_id: sessionId,   // optional; required for touch attribution
  consent_state: 'granted',
  country_code: 'IN',
});
const ts = Math.floor(Date.now() / 1000);
const signature = hmacSha256Hex(secret, `${ts}.${body}`);
await fetch(`${API}/api/events`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-adtrack-key': `${sourceConnectionId}.${keyVersion}`,
    'x-adtrack-timestamp': String(ts),
    'x-adtrack-signature': signature,
  },
  body,
});
// 201 = stored; 200 with duplicate:true = your retry landed twice, that is fine
```

That snippet is a *description of the wire format*, not a shipped connector. It has not
been run against any vendor.

## 4. Contract for a future real provider

Before a provider can be called "integrated", it must satisfy all of:

1. **Credential handling** — OAuth or API key stored server-side only; nothing in
   `VITE_*`; secrets redacted from logs; a rotation path that does not require downtime.
2. **Provenance** — every imported observation records `{ kind, reference, observedAt }`
   so it can be distinguished from an AI suggestion and can go stale.
3. **Idempotency** — the upstream natural key maps to a stable `event_id`; re-sync must be
   a no-op (`duplicate: true`), never a double count.
4. **Failure behaviour** — a provider outage leaves the last known state and reports
   `unavailable`; it must not fabricate a zero, and must not silently retry a write.
5. **Read-only by default** — a connector may only write to an advertising account if the
   provider category allows it (`openai_ads`) and the caller holds `adaccount.push`.
6. **Tenant scoping** — the connection belongs to exactly one workspace; there is no
   "global" connector that can read two clients.
7. **Documented uncertainty** — anything the provider does not return (search volume, CPC,
   competitor spend) stays in the `unavailable` list. It is never inferred from a
   different signal and labelled as measured.

Anything that cannot meet these conditions should ship as a CSV import with explicit
provenance, not as a live connector.

## 5. Where a connector plugs in

| Concern | Location |
|---|---|
| Category list, capability rules, key lifecycle | `server/sources.mjs` |
| Signature verification, skew window, key resolution | `server/ingest.mjs` |
| Route wiring, tenant resolution from the key | `server/app.mjs` (`POST /api/events`) |
| Event validation and effects | `server/events-v2.mjs` |
| OAuth flow, sealed token storage, provider adapter | `server/connectors/hubspot.mjs`, `server/connectors/crypto.mjs` |
| Connector HTTP routes + public webhook | `server/connectors/router.mjs`, wired in `server/app.mjs` |
| Provider SDK behind the adapter | `server/connectors/hubspot-sdk.mjs` (optional dependency) |

## 6. Explicit non-goals

- No scraping of restricted results.
- No ad launching or budget changes from this repository in this phase.
- No fabricated sample data standing in for a provider response in production paths; the
  demo dataset is clearly labelled demo and never written into tenant collections.

## 7. The HubSpot CRM connector (read-only)

This is the first connector that is an **integration** rather than a category: an OAuth
app, a provider adapter, a sync that writes leads, and a public webhook.

### 7.1 What it is allowed to do

| Allowed | Not allowed |
|---|---|
| Read contacts and deals (`crm.objects.contacts.read`, `crm.objects.deals.read`) | Any write scope — the connector never mutates the customer's CRM |
| Create `lead_created` events from contacts | Invent consent: imported leads carry `consent_state: 'unknown'` |
| Import `lead_qualified` **only** when the source is flagged `trustedForQualification` **and** the deal stage is one an operator listed | Treat a deal stage as qualification by default |
| Store provider ids and provenance in event metadata | Store names, emails or phone numbers in events |

Requested scopes are exactly those two. HubSpot subscriptions map one-to-one onto read
scopes, so a webhook cannot ask for more than the app already has.

### 7.2 OAuth

1. An operator creates a HubSpot app with redirect URL `HUBSPOT_REDIRECT_URI` and sets
   `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `CONNECTOR_ENCRYPTION_KEY`.
2. `POST …/connectors/hubspot/connect` returns an authorization URL and a single-use
   `state`. The state is tenant-scoped, user-bound, expires in 10 minutes, and is spent
   **before** the code exchange (a replayed callback therefore cannot re-run it).
3. The browser goes to HubSpot; the redirect URI sends `code` + `state` back;
   `POST …/connect/complete` exchanges it. Tokens never reach the browser.
4. Access and refresh tokens are sealed with **AES-256-GCM**, bound by additional
   authenticated data to `organizationId:workspaceId:sourceConnectionId`. A sealed value
   copied to another tenant cannot be opened, and tampering yields `null` rather than a
   partial token. Nothing re-reads the plaintext except the adapter, before a provider
   call.

Token endpoint: the adapter defaults to the date-based `/oauth/2026-09/token` (overridable
with `HUBSPOT_TOKEN_PATH`). HubSpot is retiring `/oauth/v1/token` (sunset 2027-02-16); the
newer path is the default so a migration is not needed later.

### 7.3 Sync semantics

- One `sources` row per workspace, `connector: 'hubspot'`, `capability: 'read'`.
- Contacts → `hs.contact.{id}` → `lead_created`. Deals → `hs.deal.{id}.{stage}` →
  `lead_qualified` (gated as above). Event ids are deterministic, so re-importing the
  same 1,000 records twice produces 1,000 leads and zero duplicates (tested).
- Timestamps come from the provider (`createdate` / `hs_lastmodifieddate`) and are stored
  in UTC; a record with no provider timestamp is counted as `missing_timestamp` and
  skipped rather than dated "now".
- Pagination is bounded (`maxPages`, default 20 × 100 records). If the bound is reached
  the run reports `degraded` + `lastSyncStatus: 'partial'` with a resumable checkpoint —
  never success. A failed run keeps the previous `lastSyncAt`: "last success" and "last
  attempt" are different facts.
- Retries: bounded exponential backoff for `429`/`5xx`/network; `401`/`403`/`477` are
  terminal and mark the connection `failed` with `nextAction: 'reconnect'`. The SDK's own
  retry is disabled so there is exactly one retry policy.

### 7.4 Webhook

`POST /api/connectors/hubspot/webhook/:organizationId/:sourceConnectionId` is public
because HubSpot cannot present our bearer token. It is authenticated by HubSpot's v3
signature: `Base64(HMAC-SHA256(clientSecret, method + fullUrl + rawBody + timestamp))`
with a 5-minute window, a 50-event cap and per-record re-reads. The tenant comes from the
path **and** the stored source row; the body is never trusted for identity. Deliveries are
idempotent, so a retried webhook is counted as a duplicate.

`PUBLIC_BASE_URL` must be set for the signature to be checkable; without it the route
answers `503 webhook_not_configured` instead of guessing the URL HubSpot signed.

### 7.5 Verification status

| Claim | Status |
|---|---|
| Sealing/opening, AAD binding, tamper rejection | **PROVEN** (`src/lib/__tests__/hubspot.test.ts`) |
| OAuth state single-use, tenant-bound, expiry; token exchange failure state | **PROVEN** (same suite, fake token endpoint) |
| Contact/deal → lead mapping, qualification gating, 1,000-record double import → zero duplicates | **PROVEN** (fake provider client with synthetic fixtures) |
| 429 retry, attempt budget, 401 → reconnect, partial pagination, missing timestamp | **PROVEN** (same suite) |
| Webhook signature accept/reject/stale/oversized/disconnected; route reachable without a bearer token; `503` without `PUBLIC_BASE_URL` | **PROVEN** (`hubspot.test.ts` + `connector-routes.test.ts`) |
| Cross-organization isolation for connector and research routes | **PROVEN** (`connector-routes.test.ts`) |
| Real HubSpot OAuth app, real contacts/deals, real webhook deliveries | **UNKNOWN — not live-verified.** No HubSpot app or account exists in this environment. Remaining step: create the app, set the four variables above, complete one connect, run one sync, and confirm one webhook arrives |
| Browser-level flow (Playwright) | **UNKNOWN — Chromium could not be downloaded here.** `npm run e2e` runs the specs where a browser is available |

A mock provider proves our code. It never proves HubSpot's contract, and this document
does not claim it does.
