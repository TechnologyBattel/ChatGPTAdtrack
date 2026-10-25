# Connector contract

_Date: 2026-10-25 · Code: `server/sources.mjs`, `server/ingest.mjs`, `server/app.mjs`_

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
| OAuth/credential storage | *does not exist* — deliberately, see `BASELINE_AND_GAPS.md` G14–G15 |

## 6. Explicit non-goals

- No scraping of restricted results.
- No ad launching or budget changes from this repository in this phase.
- No fabricated sample data standing in for a provider response in production paths; the
  demo dataset is clearly labelled demo and never written into tenant collections.
