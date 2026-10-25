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

Never collected: precise location, IP beyond the event that carries it, chat or
conversation content, special-category data.

## Consent (decided)

- Consent is **required before any tracking event is sent** and before any cookie
  (`__oppref`, `__obref`) is written.
- A boolean is not consent. The browser starts a **session** (`POST /api/session`) and
  then records the grant (`POST /api/consent`), receiving an **HMAC-signed consent id**.
  `POST /api/track` verifies signature, scope, lifetime, session binding and that the id
  has not been used before. Forged, expired, replayed or cross-session ids are refused
  with `403`.
- Consent TTL: **15 minutes**, single use — the id authorises one event, not a visitor
  forever. Sessions last 30 minutes. The mechanism is in
  [SECURITY.md §3](SECURITY.md).
- Withdrawal stops future events immediately. Because ids are single use and short lived,
  nothing outlives a withdrawal: the client stops asking for new ones, and an unused id
  expires on its own.
- We store the fact of the grant (session, scopes, key version, issued/expiry/consumed
  times), not the visitor's identity.

## Retention (decided)

| Data | Retention | Enforcement |
|---|---|---|
| Raw events | 13 months | Scheduled job, with a dry-run report before each purge |
| Lead and order records | 25 months | Same job |
| Aggregates | Indefinite | Already anonymised |
| Audit log (push/undo) | 13 months, or the life of the ad group | `GET /api/audit` from the store; in-memory cap of 500 entries in dev, Firestore in production |

## Deletion and export (decided)

- Self-serve from `/privacy`.
- Deletion zeroes PII, keeps the aggregate counts, and records an audit entry.
- Honoured within **30 days**; the requester is told when it completes.

## Roles and access (decided)

| Role | Can see | Can change |
|---|---|---|
| viewer | Reports | Nothing |
| analyst | Reports | Nothing (no ad-account writes) |
| admin | Reports | Push/undo hint sets |
| owner | Everything | Everything, including roles |

The API enforces this server-side: `POST /api/adgroups/:id/hints` requires `admin`
or `owner`, and refuses before any upstream call.

## Subprocessors

| Processor | Purpose | Region |
|---|---|---|
| Google Cloud / Firebase | Hosting, Firestore, Cloud Run | `asia-south1` where available |
| OpenAI | Ads delivery, measurement, Conversions API | Per OpenAI's terms |

## Known gaps before launch

- Consent records are currently signed but not persisted; an audit trail needs Firestore.
- `TRACK_ORIGINS` must be set in production or cross-origin tracking is refused (by design).
- The retention job is specified, not built.
- A DPA with OpenAI and a records-of-processing register are outstanding.
