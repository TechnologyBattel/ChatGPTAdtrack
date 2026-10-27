# Data model, migrations and rollback

_Date: 2026-10-25 · Code: `server/store.mjs`, `server/tenancy.mjs`, `server/agency.mjs`, `server/events-v2.mjs`_

## 1. Layout

Two storage shapes, one contract (`Store.records`). Both behave the same way, so a route
cannot accidentally depend on which is deployed.

```
GLOBAL (no tenant prefix)
  organizations/{orgId}                 the org itself
  memberships/{orgId}__{userId}         one row per (org, user) — global on purpose
  ingestKeys/{sourceConnectionId}.{keyVersion}   global, so a header resolves to a tenant
  sessions/{id}  consents/{id}  audit/{id}  outbox/{id}    (pre-existing product surface)

TENANT (under adtrack_orgs/{orgId}/{collection} in Firestore)
  workspaces/{wsId}
  campaigns/{campaignId}    topics/{topicId}
  leads/{leadId}            events/{evt_sha256(workspaceId:eventId)}
  sources/{sourceConnectionId}
  auditLog/{id}
```

Two deliberate exceptions to tenant-scoping, both because *the lookup itself* is the
question being asked:

| Collection | Why global |
|---|---|
| `memberships` | "Which organizations am I in?" cannot be answered from rows addressed by organization. |
| `ingestKeys` | A request arrives with a key and no tenant; the key must answer "whose is this?" |

Both are written with no `orgId` prefix, and both re-verify tenancy on use: a membership
row names its organization, and an ingest key's stored `organizationId`/`workspaceId`
override anything in the request body.

In the memory store, tenant-scoping is a key prefix (`{orgId}|{id}`), which is why a
foreign-tenant `get`/`list` returns nothing rather than being filtered afterwards.

## 2. Document shapes that matter

Interfaces are declared in `server/*.d.mts`; these are the fields whose semantics are load
bearing:

| Collection | Key fields | Invariants |
|---|---|---|
| `organizations` | `organizationId`, `name`, `slug`, `createdBy` | `slug` is a label, never an identifier; ids are opaque and unguessable |
| `memberships` | `organizationId`, `userId`, `role`, `createdAt`, `invitedBy` | one row per pair; role ∈ 5 org roles; at least one owner always remains |
| `workspaces` | `currency`, `timeZone`, `defaultLanguage`, `targetMarkets[]`, `domains[]` | currency ISO-4217; zone IANA-shaped; markets ISO-3166 |
| `campaigns` | `status`, `launchState`, `utm`, `trackingUrl`, `primaryConversion` | `launchState: 'not_launched'` unless a real push happened; UTM values normalised |
| `topics` | `seed`, `origin`, `source{url,method,observedAt,observedAtRaw}`, `intent`, `funnelStage`, `status` | `origin: observed` requires a source; `ai_suggested` may not carry one; `freshness` computed, never accepted |
| `leads` | `anonymousSessionId`, `eventIds[]`, `stage`, `qualification` | first touch wins; `qualification: null` until a human or trusted CRM decides |
| `events` | `schemaVersion`, `eventId`, `eventType`, `occurredAt` (+`occurredAtRaw`), `utm`, `consentState` | immutable after insert; document id is deterministic |
| `sources` | `provider`, `capability`, `status`, `trustedForQualification`, `lastSyncAt` | `write` only for `openai_ads`; trust only for `crm` |
| `sources` (OAuth connector) | `connector`, `connectionStatus`, `auth.sealedAccessToken`, `auth.sealedRefreshToken`, `auth.expiresAt`, `auth.scopes`, `auth.portalId`, `checkpoint`, `lastSyncStatus`, `lastError`, `qualifiedStages` | tokens exist only in sealed form (AES-256-GCM, AAD = org:workspace:source); `checkpoint` is per object type; `lastSyncAt` is the last *success*, never overwritten by a failure |
| `researchRuns` | `runId`, `workspaceId`, `goal`, `report`, `note`, `createdBy`, `createdAt` | an immutable snapshot: recomputing later does not alter a saved run; retention `null` (kept with the evidence it cites) |
| `ingestKeys` | `sourceConnectionId`, `keyVersion`, `secret`, `status` | never returned after issue; revoked ≠ deleted (audit needs the trail) |
| `auditLog` | `action`, `actor`, `actorRole`, `target`, `ok`, `detail` | append-only through the API; purged only by retention policy |

Money is an integer count of minor units plus an ISO-4217 code. Instants are epoch
milliseconds; `occurredAtRaw` keeps the sender's original offset string.

## 3. Indexes and rules

`firestore.indexes.json` declares a composite index for **each** query that would otherwise
fail with `FAILED_PRECONDITION`, and `firestore.test.ts` asserts the file matches the
queries in code (so an index cannot silently drift or be declared unused). The new tenant
reads are single-field (`workspaceId`, `status`, `organizationId`) or whole-collection
reads, which Firestore serves automatically; the per-tenant **subcollection** layout is what
keeps them that way — no cross-tenant composite index is needed, and none exists.

`firestore.rules` is **deny all**. The browser never talks to Firestore; every access goes
through the API with the Admin SDK, which bypasses rules. A deny-all rule cannot be widened
by a later query-building bug.

**UNKNOWN:** none of this has been executed against a real Firestore project. The layout,
the indexes and the TTL advice are reasoned and unit-tested against a fake, not observed.

## 4. Migrations

There is no migration framework, and this phase needs none:

- Every collection is schemaless with **defaults applied on read** (`qualification: null`,
  `freshness` recomputed, `launchState` present).
- Adding a field is additive; no backfill is required for correctness because readers treat
  an absent field as "unknown", not as a default value that means something else.
- `schema_version` exists **on events only**, because an event is a contract with an
  external sender. Everything else is internal and read with defaults.

When a field's *meaning* changes (not just its presence), the procedure is:

1. Bump `EVENT_SCHEMA_VERSION`; keep v2 validation until every source reports the new
   version.
2. Write the new field alongside the old one; read the new, fall back to the old.
3. Only after a full retention window (396 days) drop the old field.

### This phase's deploy

```
add collections: organizations, memberships, workspaces, campaigns, topics, leads,
                 events, sources, ingestKeys, auditLog
add indexes:     none new required (single-field / whole-collection reads)
add TTL:         none (retention is an application sweep, not a TTL policy)
```

Deploy is **additive**: an existing deployment keeps its `sessions`, `consents`, `audit`
and `outbox` collections untouched, and `server/app.mjs` serves the old routes exactly as
before. If `agency`/`sources`/`ingestV2` are not wired, the new routes return `404` and
`/api/events` with `schema_version: 2` returns `503 ingest_not_configured` — a deployment
that half-wires the feature says so instead of pretending.

## 5. Rollback

| Situation | Rollback | Data consequence |
|---|---|---|
| New routes misbehave | Stop wiring `agency`/`sources`/`ingestV2` in `server/server.mjs`; redeploy | New collections remain, unread. Old routes unaffected. No data loss. |
| A bad campaign/topic record | `PATCH` it back; every write is audited with actor and before/after | none |
| A bad membership change | `PUT` the previous role back (owner/admin) | audit keeps both entries |
| Events arriving from a compromised key | `POST .../sources/:id/revocations` with that `keyVersion` | other key versions keep working |
| A workspace created by mistake | `DELETE .../workspaces/:id` (owner) → revokes its ingest keys, purges campaigns/topics/events/leads/sources/auditLog for that workspace | **irreversible**; counts returned, audit entry written |
| Retention purge run by mistake | **no application rollback** | restore from the database backup taken before the change; the purge is owner-only for this reason |
| Event schema v2 reverted | reject v2 by config, but **stored v2 events stay** | senders must be migrated, not the data |

The only truly irreversible operations are the retention purge and workspace deletion,
both owner-gated and both returning exactly what they removed.

## 6. Backup and restore

- Firestore: rely on the project's scheduled backups / PITR. **UNKNOWN** whether any backup
  policy is enabled — this repo declares none, and a policy that exists only in a console
  is not evidence.
- Memory store: nothing to back up. It is a development and test store, and the server
  refuses to start in production with it (`STORE=memory` guard, PROVEN by
  `scripts/check-prod-guards.mjs`).

Before any retention-policy change or manual purge, take a backup and record where it is.
