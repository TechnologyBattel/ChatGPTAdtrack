# Lead event schema v2

_Date: 2026-10-25 · Code: `server/events-v2.mjs`, `server/app.mjs`, `server/ingest.mjs`_

One signed request carries one event. The server normalises it, decides the tenant from
the key (never from the body), stores it once, and then applies its effect on a lead if the
event has one.

```
POST /api/events
Content-Type: application/json
X-ADTrack-Key: src_abc.v1
X-ADTrack-Timestamp: 1760000000
X-ADTrack-Signature: <hex HMAC-SHA256 of `${timestamp}.${rawBody}`>
```

`X-ADTrack-Key` is `<sourceConnectionId>.<keyVersion>`. The signature covers the **exact
bytes** received, not a re-serialised object, so key order and unicode escapes cannot make
a correct signature fail. Tolerance is ±300 s by default (`INGEST_TOLERANCE_SECONDS`).

## 1. The eight lifecycle steps

| # | `event_type` | Who may send it | Creates/updates a lead | Money |
|---|---|---|---|---|
| 1 | `landing_visit` | browser (consent-gated) or server | — | no |
| 2 | `campaign_attributed_visit` | browser or server | — | no |
| 3 | `enquiry_submitted` | browser or server | **yes** | no |
| 4 | `lead_created` | server / CRM only | **yes** | no |
| 5 | `lead_qualified` | CRM only, and only when the source is `trustedForQualification` | **yes** (stamps qualification) | no |
| 6 | `appointment_scheduled` | server / CRM only | — | no |
| 7 | `order_created` | server / CRM only | — | **yes** |
| 8 | `refund_or_cancellation` | server / CRM only | — | **yes** (the event type, never a negative amount, says it is a refund) |

Not every customer emits every step. A missing step means **unavailable**, not zero: the
workspace summary lists the absent areas in `missing` (`events`, `leads`, …) and reports
`freshness.lastEventAt: null`, rather than inventing numbers.

## 2. Envelope

| Field | Required | Rule |
|---|---|---|
| `schema_version` | yes | must be `2` (number or string) — otherwise `400 unsupported_schema_version` |
| `event_id` | yes | id-token shape; identity is `(workspace, event_id)` |
| `event_type` | yes | one of the eight above |
| `occurred_at` | yes | ISO-8601 with an offset, e.g. `2025-10-09T14:03:00+05:30`; stored as epoch ms **plus** the raw string |
| `event_source` | yes | `server` \| `crm` \| `browser` |
| `workspace_id`, `source_connection_id` | no | if present, must match the key's record — otherwise `403 tenant_mismatch` |
| `campaign_id` | no | id-token |
| `anonymous_session_id` | no | links touchpoints to a lead without identifying a person |
| `landing_url`, `referrer` | no | URLs |
| `utm_source` … `utm_term` | no | ≤256 chars each |
| `country_code` | no | ISO-3166 alpha-2 |
| `region`, `city` | no | `city` is only accepted when `consent_state === 'granted'` (`400 city_requires_consent`) |
| `consent_state` | no | `granted` \| `denied` \| `unknown` (default `unknown`) |
| `crm_record_reference` | no | provenance pointer for CRM-originated events |
| `currency`, `amount_minor` | no | currency ISO-4217; amount a non-negative safe integer in **minor units**; both or neither; money types only |
| `metadata` | no | object, < 4 KB, not for PII |

Unknown keys are rejected (`assertKnownKeys`), not silently dropped — a typo in
`event_type` must not become a silent no-op.

### Fields a sender may **not** set

`qualification`, `qualified`, `qualified_at`, `revenue`, `revenue_minor`,
`organization_id`, `received_at`, `ingested_at`. Each is refused by name with
`400 forbidden_field` and a sentence saying why. The two product rules behind this:

- **The tenant comes from the key.** A body that claims an organization is a confused
  deputy waiting to happen.
- **Revenue comes from `amount_minor` on a money event**, and qualification is a separate,
  attributed decision — a sender cannot assert either.

## 3. Idempotency and replay

```
docId = 'evt_' + sha256(`${workspaceId}:${eventId}`).slice(0, 40)
```

- Insert-once (`records.create`), so idempotency is a database property, not a
  read-then-write race.
- A replay returns **`200 { accepted: true, duplicate: true }`** and does **not** append the
  event id to the lead a second time. The sender's retry succeeded; nothing was counted
  twice.
- The same `event_id` in a *different* workspace is a different event (`201`), because the
  workspace is part of the identity.
- A fresh event returns `201`, including the `leadId` it touched (or `null`).

## 4. Failure modes

| Condition | Status | `code` |
|---|---|---|
| Unknown, malformed or revoked ingest key | 401 | `ingest_unauthenticated` (all three are indistinguishable on purpose) |
| Missing headers | 401 | `ingest_unauthenticated` |
| Timestamp outside ±300 s | 401 | `ingest_timestamp_stale` |
| Bad timestamp format | 401 | `ingest_timestamp_invalid` |
| Signature mismatch | 401 | `ingest_signature_invalid` |
| Body claims another workspace/source | 403 | `tenant_mismatch` |
| Browser posts a v2 event, or any server-only type | 403 | `browser_event_not_allowed` |
| `lead_qualified` from an untrusted source | 403 | `qualification_not_trusted` |
| Malformed JSON | 400 | `malformed_json` (no stack trace, no echo of the payload) |
| Unknown event type / forbidden field / bad money | 400 | `unsupported_event_type` / `forbidden_field` / `amount_not_allowed` |
| Ingest not configured on this deployment | 503 | `ingest_not_configured` |

The signature check happens **before** the body is interpreted, and the tenant is resolved
**before** validation, so a caller cannot learn a workspace's existence from a validation
error.

## 5. Leads

An `enquiry_submitted` / `lead_created` event upserts a lead:

- **First touch wins.** A later enquiry from the same session does not overwrite the
  campaign that originally found them.
- `stage` moves through the lifecycle; `qualification` stays `null` until a human or a
  trusted CRM decides.
- `eventIds[]` accumulates the events that belong to the lead — for observability and for
  attribution, not as a score.
- `qualificationState` is `qualified` or `not_qualified`; it is never `unqualified` when
  nothing was decided.

**Qualification paths**

| Path | Trusted by | Recorded as |
|---|---|---|
| `POST .../leads/:id/qualification` | a member with `lead.qualify` | `{ status, source: 'user:<uid>', actor, actorRole, at, definitionVersion, note }` + a `lead.qualify` audit entry |
| `lead_qualified` event | only a source created with `trustedForQualification: true` (CRM) | `{ status: 'qualified', source: 'crm:<sourceConnectionId>', at }` |

There is no third path. A browser cannot qualify a lead, and neither can a marketing
integration key.

## 6. Attribution

`GET /api/orgs/:org/workspaces/:ws/leads/:leadId/attribution?windowDays=30`

- Basis is `observed_touchpoints` only: `landing_visit` and `campaign_attributed_visit`
  events from the lead's `anonymous_session_id` (or its recorded `eventIds`) inside the
  window.
- Returns first-touch and last-touch models, each `{ campaignId, utm, landingUrl,
  occurredAt }`, plus the window in both epoch millis and the workspace's zone.
- No touchpoints → `{ available: false, reason: 'no_touchpoints_in_window', models: null }`.
  Never a zero-filled attribution.
- No incrementality, no view-through, no modelled conversions. Those would require
  experiment design or a data clean room; claiming them from click data is exactly the
  error this product exists to avoid.
- Window is clamped to 1–90 days; the default is 30.

## 7. Schema versioning and migration

- `schema_version: 1` is the older consent-gated `/api/track` envelope and still works; it
  is a page-event path, not a lead lifecycle path.
- v2 is additive by design: unknown keys are rejected, so adding a field means a new
  accepted key plus a version bump only if the meaning changes. A field that changes
  meaning (rather than being added) requires `schema_version: 3`, with v2 validation kept
  until every source is migrated.
- Stored events keep `schemaVersion` and the raw `occurredAtRaw` string, so an event can be
  re-read after a timezone rule change without re-deriving its original local time.

See `DATA_MODEL.md` for storage layout and the rollback procedure.
