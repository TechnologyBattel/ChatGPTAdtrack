# Privacy

Not legal advice. Have counsel review the DPDP Act and GDPR positions before launch.

## Data collected

| Data | Purpose | Storage |
|---|---|---|
| Session id, UTMs, `oppref` / `obref` | Attribute a lead to an ad click | 13 months |
| Device type, country / region / city | Aggregate performance geography | 13 months (raw), indefinite (aggregated) |
| Lead form fields | Contact the person about their request | 25 months |
| Order id, amount, currency | Revenue attribution | 25 months |
| Consent record (id, scopes, timestamp, version) | Prove consent; answer deletion requests | 25 months after the last event |
| Outbox entry (event, consent id, attempts, last error) | Retry a delivery the upstream refused | Until delivered, or dead-lettered + 30 days |

Never collected: precise location, IP beyond the event that carries it, chat or
conversation content, special-category data.

## Consent (decided)

- Consent is **required before any tracking event is sent** and before any cookie
  (`__oppref`, `__obref`) is written.
- A boolean is not consent. The browser starts a **session** (`POST /api/session`) and
  then records the grant (`POST /api/consent`), receiving an **HMAC-signed consent id**.
  `POST /api/track` verifies signature, scope, lifetime, session binding (user agent;
  IP change is logged, not enforced) and that the id has not been used before. Forged,
  expired, replayed or cross-session ids are refused with `403`.
- The id is consumed **only after** the upstream accepts the event. A retryable upstream
  failure queues the event for retry and keeps the grant; a permanent failure releases it.
  A dead-lettered event releases the grant and is recorded in the audit log.
- Consent TTL: **15 minutes**, single use — the id authorises one event, not a visitor
  forever. Sessions last 30 minutes. The mechanism is in
  [SECURITY.md §3](SECURITY.md).
- Withdrawal stops future events immediately. Because ids are single use and short lived,
  nothing outlives a withdrawal: the client stops asking for new ones, and an unused id
  expires on its own.
- We store the fact of the grant (session, scopes, key version, issued/expiry/consumed
  times), not the visitor's identity.
- Server-to-server events (`lead_created`, `order_created`, amounts) never rely on the
  browser. They are sent by our own server, signed with a rotating ingest key, and must
  declare a basis: `granted` (using the same consent id) or `first_party_record` (our
  own record of the transaction is the basis — an order we fulfilled does not need a
  browser's permission to be reported).

## Retention (decided)

| Data | Retention | Enforcement |
|---|---|---|
| Raw events | 396 days (13 months) | Application sweep every `RETENTION_SWEEP_INTERVAL_MS` (default 6 h), plus an owner-only manual purge that returns per-collection counts |
| Lead and order records | 760 days (25 months) | Same sweep |
| Research topics | Kept (not personal data) | `topics: null` in the policy |
| Saved research runs | Kept (a business record the agency chose to save) | `researchRuns: null` in the policy |
| One-shot OAuth states | 1 day | Same sweep; kept a day so a late callback gets `state_expired` rather than an indistinguishable 404 |
| Webhook rate-limit windows | 1 day | Same sweep; contains a counter and a window start, no personal data |
| Audit log (tenancy + push/undo) | 396 days | Same sweep; in-memory cap of 500 entries in dev, Firestore in production |

The purge deletes exactly what the policy lists, per organization, and writes a
`retention.purge` audit entry with the counts. A test asserts that the collections the
policy marks `null` (topics, saved research) survive a purge, so a future policy edit
cannot quietly delete an agency's own history. There is **no undo**, so the manual
endpoint is owner-only. Changing a day count deletes data on the next sweep.

## Deletion and export (decided)

- Self-serve from `/privacy`.
- Deletion zeroes PII, keeps the aggregate counts, and records an audit entry.
- Honoured within **30 days**; the requester is told when it completes.

## Roles and access (decided)

| Role | Can see | Can change |
|---|---|---|
| viewer | Reports, topics, campaigns, leads | Nothing |
| analyst | The same, plus exports | Nothing (no ad-account writes) |
| editor | The same | Campaigns, research topics, lead qualification |
| admin | Everything except ownership transfer | Also workspaces, members, source credentials, ad-account pushes |
| owner | Everything | Everything, including workspace deletion and the retention purge |

The API enforces this server-side with thirteen named permissions
([AGENCY_MODEL.md §2](AGENCY_MODEL.md)); `POST /api/adgroups/:id/hints` requires
`adaccount.push` (admin/owner) and refuses before any upstream call. Data is scoped to
an organization: a non-member gets `404`, identical to a nonexistent id.

## Subprocessors

| Processor | Purpose | Region |
|---|---|---|
| Google Cloud / Firebase | Hosting, Firestore, Cloud Run | `asia-south1` where available |
| OpenAI | Ads delivery, measurement, Conversions API | Per OpenAI's terms |

## Reporting

- When no first-party source is connected (`firstPartyAvailable: false`), lead, customer,
  revenue, CPL, CAC and ROAS figures are **masked** (`—`) — in tiles, charts, tables and in
  the written headline and subline. We do not render a ₹0 we cannot substantiate.
- The server asks OpenAI for reports at the aggregation each view needs; ad-group views
  use an `ad_group` report rather than re-attributing campaign rows to ad groups.

## Known gaps before launch

- Retention is implemented as an application sweep and a manual purge; Firestore TTL
  policies for sessions and consent ids are documented but not enabled by this repo.
- Ingest keys are per **source connection**, rotatable and revocable; the older
  deployment-wide key path (`schema_version: 1`) still exists for page events only.
- Self-serve deletion and export at `/privacy` are **not built**. Deletion today is a
  workspace delete or an owner-run purge, both of which are all-or-nothing and audited.
- `TRACK_ORIGINS` must be set in production or cross-origin tracking is refused (by design).
- City-level data is only stored when `consent_state` is `granted`; country/region
  reporting works without it.
- A DPA with OpenAI, a records-of-processing register, and a DPIA for the retention
  numbers are outstanding. The day counts here are a product policy, not a legal opinion.

## 7. What a CRM import does and does not bring in (2026-10-26)

An imported HubSpot contact creates a lead with a **provider record reference** and an
`occurred_at`. It does not copy the contact's name, email, phone number or any custom
property: those values are not read into events, and the adapter's tests assert that no
event or lead contains them. The qualification of a lead records *who decided* (a person,
or `crm:<source>`), never the deal's notes.

Consequences worth stating plainly:

- Imported leads carry `consent_state: 'unknown'`. A CRM record is not evidence that the
  person consented to measurement in this product, and the report says so.
- Research reports over imported data describe counts of records. They are not a legal
  basis for contacting anyone, and nothing in the product sends a message.
- Disconnecting a CRM clears the sealed credentials and the sync checkpoint immediately.
  Events that already arrived stay, because they are history; they are subject to the same
  retention policy as any other event.

## Private Research Mode (slice 1)

Optional, server-wide, off by default (`PRIVATE_RESEARCH_ENABLED`). When on, an editor, admin
or owner can ask OpenAI or Anthropic — **using their own API key** — to name clusters that our
deterministic pipeline already computed in the browser.

### What we promise

> **Your key and seeds pass through our server process in memory, never persisted, never
> logged.**

- The key arrives in one request, is used for that request, and is dropped. It is not written
  to any store, log, audit record, URL or error message.
- Seeds, prompts, provider responses and generated names are **not stored** anywhere: not in
  our database, not in the browser's local or session storage, not in the URL, not in research
  history, not in the push/undo audit log.
- The generated names exist only in the page, until you discard them or reload.

### What we cannot promise

- **The provider sees your content.** The request is sent to OpenAI or Anthropic, which may
  retain it under its own policy. We neither control nor audit that. Private Research Mode
  does not make you anonymous to the provider.
- **Operators can read process memory.** While a request is in flight, our server holds the
  key and the seeds in memory. "Never persisted" is not "never seen".
- The cluster names are not end-to-end encrypted, and this is not a zero-knowledge design.

### What is recorded

Exactly one audit entry per attempt, with metadata only: provider, model, cluster count,
outcome, and — on failure — one fixed internal error code. Never the key, the seeds, the
names, or anything the provider said.

If that audit entry cannot be written, the run is **discarded**: you get an error and no
names, rather than a success we could not record.

### What does not change

The deterministic research pipeline — clustering, scoring, validators, hints — is untouched
and remains the source of truth. If a private run fails, times out or returns something
malformed, you keep exactly the result you already had.
