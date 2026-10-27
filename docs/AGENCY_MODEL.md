# Agency model — organizations, workspaces, roles

_Date: 2026-10-25 · Code: `server/tenancy.mjs`, `server/agency.mjs`, `server/sources.mjs`_

The hierarchy this product stores, top to bottom:

```
organization (the agency or the in-house team)
  └── workspace (a client account: currency, time zone, markets, language)
        ├── source     (a connected data source, with rotating ingest keys)
        ├── campaign   (registry entry + tracking link; never "live" unless a real push happened)
        │     └── topic        (research question, with provenance)
        └── lead       (created by a trusted source; qualification is a separate decision)
              └── events   (the eight lifecycle steps that led to it)
```

`brand` is a workspace field (`clientName` + `domains`), not a separate level. A brand per
client was the original proposal; one workspace per client is strictly less to get wrong
and is enough for the MVP. Splitting a workspace later is a data migration, not a schema
change (see `DATA_MODEL.md`).

## 1. The rule the module exists to enforce

> The organization an operation touches comes from the authenticated principal's
> membership, **never** from the request.

Consequences, all of them tested:

| Situation | Response | Why |
|---|---|---|
| Not a member of the org in the path | `404 not_found` | A `403` would confirm the id exists. The body is byte-identical to a genuinely nonexistent org. |
| Member, but role lacks the permission | `403 forbidden` | The caller is told what they may not do, not what exists. |
| Removing the last owner | `409 last_owner` | An owner-less org is unrecoverable without a support path. |
| Body contains a different `workspaceId` than the path | Path wins, body field ignored | Prevents a confused-deputy copy of a record into another tenant. |
| A foreign `sourceConnectionId` in a URL | `404` | Same reasoning as orgs. |

A principal is `{ uid, role }`, where `role` is the *token* role from the auth layer.
Token roles and org roles are different things: `auth.mjs` accepts
`viewer | analyst | editor | admin | owner` in a verified token, but every authorization
decision uses the **membership** role for the organization in the path. A global `owner`
token does not make someone an owner of a foreign org.

## 2. Roles and permissions

Five roles, thirteen named permissions. Routes name a permission, never a role, so adding
a role does not mean editing every handler.

| Permission | Meaning | viewer | analyst | editor | admin | owner |
|---|---|:--:|:--:|:--:|:--:|:--:|
| `data.read` | read reports and datasets | ✓ | ✓ | ✓ | ✓ | ✓ |
| `report.export` | export CSV/JSON | | ✓ | ✓ | ✓ | ✓ |
| `research.read` | read topics/questions | ✓ | ✓ | ✓ | ✓ | ✓ |
| `research.write` | create/edit topics | | | ✓ | ✓ | ✓ |
| `campaign.read` | read the campaign registry | ✓ | ✓ | ✓ | ✓ | ✓ |
| `campaign.write` | create/edit campaigns and UTM links | | | ✓ | ✓ | ✓ |
| `lead.read` | read leads | ✓ | ✓ | ✓ | ✓ | ✓ |
| `lead.qualify` | mark a lead qualified | | | ✓ | ✓ | ✓ |
| `workspace.write` | create/edit workspaces, brands, defaults | | | | ✓ | ✓ |
| `workspace.delete` | delete a workspace and its data | | | | | ✓ |
| `member.manage` | invite/remove members, change roles | | | | ✓ | ✓ |
| `source.manage` | connect/disconnect sources, rotate keys | | | | ✓ | ✓ |
| `adaccount.push` | write to a live ad account (hint push) | | | | ✓ | ✓ |

Rules that ride on top of the matrix:

- **No self-promotion.** You may not grant yourself a role at or above your own rank; only
  an owner may create another owner. A role change to a *higher* role by someone who could
  otherwise manage members is rejected with `403 role_escalation`.
- **Permission before escalation.** An editor attempting a member change gets `403
  forbidden` (they lack `member.manage`) rather than `role_escalation`. This ordering is
  intentional: the caller should not learn which escalation rule would have applied.
- **Owner removal is guarded.** `DELETE /members/:id` on the last owner fails `409
  last_owner`; demoting the last owner is refused the same way.
- **Every membership change is audited** as `member.role_change` with
  `{ actor, actorRole, target, detail: { from, to } }`.

`GET /api/orgs/:org/permissions` returns `{ role, permissions }` for the current caller —
the UI renders capability from the server's answer, not from a client-side role guess.

## 3. Workspace: what it means to be global

A workspace fixes the defaults that make a number mean something:

| Field | Example | Rule |
|---|---|---|
| `currency` | `INR` | ISO-4217, validated by membership in `Intl.supportedValuesOf('currency')`. Money is stored in minor units; there is **no** FX conversion anywhere. |
| `timeZone` | `Asia/Kolkata` | IANA zone; validated by shape or `UTC`/`Etc/UTC`, then resolved with `Intl` (see `GLOBALIZATION.md`). |
| `defaultLanguage` | `en-IN` | BCP-47-ish tag, shape-validated. |
| `targetMarkets[]` | `{ countryCode: 'IN', region: null, city: null }` | ISO-3166 alpha-2 per market. |
| `domains[]` | `example.in` | used for attribution sanity checks, not for tracking. |

Campaigns inherit `targetMarkets` and `language` when the request omits them, so a campaign
cannot silently acquire a different market than its workspace.

## 4. Routes

All routes require `Authorization: Bearer <token>`; all return our own error envelope
`{ error: { code, message } }`. Creation is `201`; everything else `200`.

### Organizations and members

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/orgs` | — (lists only orgs you are a member of) |
| `POST` | `/api/orgs` | — (creator becomes `owner`) |
| `GET` | `/api/orgs/:org/members` | `data.read` |
| `PUT` | `/api/orgs/:org/members` | `member.manage` |
| `DELETE` | `/api/orgs/:org/members/:userId` | `member.manage` |
| `GET` | `/api/orgs/:org/permissions` | `data.read` |

### Workspaces

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/orgs/:org/workspaces` | `data.read` |
| `POST` | `/api/orgs/:org/workspaces` | `workspace.write` |
| `DELETE` | `/api/orgs/:org/workspaces/:ws` | `workspace.delete` (revokes the workspace's ingest keys, then removes its rows) |
| `GET` | `/api/orgs/:org/workspaces/:ws/summary` | `data.read` |

```json
{
  "workspace": { "currency": "INR", "timeZone": "Asia/Kolkata", "targetMarkets": [...] },
  "counts": { "campaigns": 1, "topics": 0, "leads": 0, "leadsQualified": 0, "events": 0, "sourceConnections": 0 },
  "freshness": { "lastEventAt": null, "lastSyncAt": null },
  "unavailable": ["search_volume", "cpc", "competitor_ad_spend", "trend_growth"],
  "missing": ["source_connections", "events", "leads"],
  "currency": "INR"
}
```

`counts` are facts about stored records. `missing` names the areas that have no data at
all (`freshness.lastEventAt: null` says "never"), and `unavailable` names the metrics this
product does not collect — search volume, CPC, competitor spend, trend growth. Neither is
rendered as `0`: the UI says "unavailable" / "no data yet", and the panel reports
qualification as unavailable while there are no leads to qualify.

### Campaigns and tracking links

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/orgs/:org/workspaces/:ws/campaigns?status=` | `campaign.read` |
| `POST` | `/api/orgs/:org/workspaces/:ws/campaigns` | `campaign.write` |
| `PATCH` | `/api/orgs/:org/workspaces/:ws/campaigns/:id` | `campaign.write` |
| `POST` | `/api/orgs/:org/workspaces/:ws/utm` | `campaign.write` |

A campaign record carries `status: draft | ready | archived` **and** a separate
`launchState: 'not_launched'`. This product does not launch ads in this phase; a registry
entry is never presented as serving traffic.

The UTM builder normalises values (lower-case, `-` separators, trimmed) and returns the
list of changes it made:

```json
{
  "url": "https://example.in/lp?utm_source=chatgpt-ads&utm_medium=paid&utm_campaign=diwali",
  "params": { "utm_source": "chatgpt-ads", "utm_medium": "paid", "utm_campaign": "diwali" },
  "normalized": [{ "key": "utm_term", "from": "gst filing help", "to": "gst-filing-help" }],
  "preserved": []
}
```

Silent rewriting of a marketer's link would be a bug; showing the diff is the feature.

### Topics (research registry)

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/orgs/:org/workspaces/:ws/topics?status=&intent=` | `research.read` |
| `POST` | `/api/orgs/:org/workspaces/:ws/topics` | `research.write` |
| `PATCH` | `/api/orgs/:org/workspaces/:ws/topics/:id` | `research.write` |

Every topic records **where it came from**:

| Field | Values | Meaning |
|---|---|---|
| `origin` | `observed` \| `ai_suggested` | `observed` requires a source; `ai_suggested` is an AI idea and is labelled as one |
| `source` | `{ url, name, observedAt, observedAtRaw, method }` | required when `origin: observed`; `method` ∈ `manual_review`, `public_content`, `search_console`, `partner_export`; attaching a source to an `ai_suggested` topic is rejected (`400 ai_suggestion_with_source`) |
| `freshness` | `fresh` \| `stale` \| `unknown` | derived from `source.observedAt`, stale after 90 days; `unknown` when there is no observation date |

A topic also carries `seed` (required), an optional `question`, `intent`, `funnelStage`,
`market`, `language`, `status` and `nextAction`. Asking for a metric this product does not
collect (`search_volume`, `cpc`, `trend`, `competitor_spend`, …) is refused with
`400 unsupported_metric` rather than stored as a guess.

`freshness` is computed, never accepted from the client. A 38-day-old observation is
`fresh`; the threshold is 90 days.

### Leads and attribution

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/orgs/:org/workspaces/:ws/leads` | `lead.read` |
| `POST` | `/api/orgs/:org/workspaces/:ws/leads/:leadId/qualification` | `lead.qualify` |
| `GET` | `/api/orgs/:org/workspaces/:ws/leads/:leadId/attribution` | `lead.read` |

Qualification is always attributed: `{ status, source: 'user:<uid>', actor, actorRole, at,
  definitionVersion, note }`, and every decision is audited as `lead.qualify`. A lead with no qualification event reports `qualification: null`, and the UI says
"not qualified by any user or CRM" — not `unqualified`, which would imply the opposite
fact was observed.

Attribution is **touchpoint-based only** (`basis: 'observed_touchpoints'`), first and last
touch over a window (default 30 days, clamped 1–90). It never claims incrementality or
view-through credit, and when there are no touchpoints it returns
`{ available: false, reason, models: null }`.

### Sources

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/orgs/:org/workspaces/:ws/sources` | `data.read` |
| `POST` | `/api/orgs/:org/workspaces/:ws/sources` | `source.manage` |
| `POST` | `/api/orgs/:org/workspaces/:ws/sources/:id/rotations` | `source.manage` |
| `POST` | `/api/orgs/:org/workspaces/:ws/sources/:id/revocations` | `source.manage` |
| `DELETE` | `/api/orgs/:org/workspaces/:ws/sources/:id` | `source.manage` |

The secret is returned **once**, at creation or rotation, and never appears in a listing,
an audit entry or a log. Listings expose `keyId`/`keyVersion` only. Revocation is
per-version, so an old key can be retired without breaking the current one; disconnect
revokes every version and marks the source `disconnected`.

### Data operations

| Method | Path | Permission |
|---|---|---|
| `POST` | `/api/orgs/:org/retention/purge` | `owner` only |

Returns per-collection counts (`{ at, organizationId, removed: { events, leads, … } }`) and
writes a `retention.purge` audit entry. It is scoped to one organization: an owner
purging their own data cannot touch another tenant's.

## 5. Retention

Policy (`server/store.mjs`), per collection, with an explicit age field each:

| Collection | Age field | Days | Rationale |
|---|---|---|---|
| `events` | `occurredAt` | 396 | 13 months covers a year-over-year comparison |
| `leads` | `createdAt` | 760 | 25 months, so annual cohorts stay complete |
| `auditLog` | `at` | 396 | matches events |
| `topics` | `createdAt` | `null` (kept) | research evidence is not personal data and is the basis of later reports |

The sweep runs in the server on `RETENTION_SWEEP_INTERVAL_MS` (default 6 h, clamped
60 s–7 d) when `RETENTION_SWEEP` is on. The numbers are a **policy choice**, not a legal
opinion; see `docs/PRIVACY.md`. Changing a number deletes data on the next sweep with no
undo, so change it in a reviewed commit and take a backup first.

## 6. What the UI surfaces

`src/components/WorkspacePanel.tsx` (read-only) shows: organization and workspace
selectors, currency/time zone/markets, the caller's role and permissions, the summary
tiles (with `unavailable` spelled out), and campaigns, topics, leads and sources. It
labels an `ai_suggested` topic as "AI suggestion — not observed evidence" and an unqualified
lead as "not qualified by any user or CRM".

It deliberately has **no** create/edit controls: writes are audited API actions that need
their own confirmation flow, and adding an un-audited button would be worse than the gap.
Creation and editing are done through the API (documented above). This is the honest
boundary of "minimal UI surfacing" for this phase.
