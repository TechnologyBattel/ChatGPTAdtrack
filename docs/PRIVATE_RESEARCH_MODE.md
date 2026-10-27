# Private Research Mode — technical design (rev. 2)

**Status:** revised proposal, awaiting explicit approval. **No application code written or modified.**
**Date:** 2026-10-26 · **Branch:** `arena/b0e01b66-chatgptadtrack`
**Companion:** `docs/PRIVATE_RESEARCH_MODE_PLAN.md` (implementation plan). Both documents must
agree; §9 states how.

**Revision note.** Rev. 1 proposed per-workspace enablement and a Pro plan gate. Both are
withdrawn. Slice 1 is a **server-wide flag, off by default**, and **nothing is gated by
plan**. Workspace-level enablement is deferred. Every claim below about storage was checked
against the code; §4.2 cites the file and line for each path examined.

---

## 0. Scope of slice 1, in one paragraph

When, and only when, an operator sets `PRIVATE_RESEARCH_ENABLED=true`, an editor, admin or
owner may send the clusters our existing deterministic pipeline has already computed to
OpenAI or Anthropic **using their own API key**, and receive **model-generated names** for
those clusters. Nothing is stored: not the key, not the seeds, not the prompt, not the
response, not the names. One metadata-only audit line is written per attempt. If the flag is
off, the feature does not exist from the client's point of view. If anything about the AI
call fails, the deterministic result the user already has is unaffected.

**The deterministic pipeline remains the source of truth.** The model may only *name*
clusters it is given; it cannot add, remove, merge, reorder or re-scope them, cannot change
membership, and cannot produce hints. If the model is unavailable, the product still works
exactly as it does today.

---

## 1. Current state assessment

### 1.1 There is no model call anywhere in this repository

Verified by grep across `server/` and `src/` for `chat/completions`, `messages.create`,
`anthropic`, `embeddings`, `gpt-4*`, `openai` provider calls: **no matches**. Both features
called "research" are deterministic:

| | **A. Seed → hint research** | **B. Guided research report** |
|---|---|---|
| Code | `src/lib/research.ts` (628 lines), `src/components/Research.tsx` | `server/research.mjs` (609 lines), `src/components/GuidedResearch.tsx` |
| Runs | entirely in the browser | server, over stored tenant records |
| Network | none | none (store reads only) |
| Model | none | none |

Pipeline A, unchanged by this work:

```
raw text → normalizeSeeds()  → cleanText (PII flag, length) → tokenize → classify(intent)
         → clusterSeeds()    → Jaccard similarity against a granularity threshold
         → clusterName()     → deterministic label (template + dominant intent)
         → buildHints()      → template expansion
         → validateHint()    → length, duplicate, generic-phrase, safety checks
         → scoreOf()         → relevance / intent / size / coverageGap / risk
```

**Private Research Mode inserts exactly one optional step**: `clusterName()` may be replaced
by a model for the duration of one request. Everything else — including the IDs, membership,
scores, validators and hints — stays deterministic and local.

### 1.2 Server-side storage points

| Store | Content | Touched in slice 1? |
|---|---|---|
| `researchRuns` (org-scoped) | `goal`, `note`, **full report snapshot**, `createdBy`, `createdAt` | **No.** Slice 1 never writes here. |
| `auditLog` (org-scoped) | `id`, `at`, `action`, `org`, `workspaceId`, `actor`, `actorRole`, `target`, `ok`, **`detail` (free-form)** | **Yes** — one line per attempt, `detail` restricted to an allowlist (§5). |
| `organizations` / `workspaces` | tenancy, settings, `plan` | Read only (authorization). No new fields. |

### 1.3 Client-side storage points (the part rev. 1 got wrong)

Rev. 1 asserted the browser stores nothing relevant. That is **false**, and the three real
paths are now design constraints:

1. **The user's question is written into the URL.** `src/App.tsx:142-148` builds
   `?q=<question>&m=<mode>` and calls `history.replaceState`. The same query string is read
   back on mount (`App.tsx:132`) and restored. For a Track-mode question this is the intended
   shareable-state behaviour. **For private seeds it would be a leak** into the address bar,
   browser history, and anything that reads the URL (bookmarks, screen shares, extensions).
   → Constraint: private seeds must never become `asked.q`. (AC4/T7)
2. **`localStorage['adtrack.audit.v1']` holds hint text.** `src/lib/hints.ts:51-60` defines
   `AuditEntry` with `before: string[]` and `after: string[]`; `createLocalStore()` writes
   them (`hints.ts:103`). A push or undo would persist **model-generated names** verbatim.
   → Constraint: slice 1 does not push, and a private name must never reach this store. (AC6/T8)
3. **The auth token lives in `sessionStorage`** (`src/lib/token-store.ts:46`), by deliberate
   design (`hints.ts` aside, the code comments explain why not `localStorage`). This is the
   *session*, not the provider key — but it means the tab already holds a credential and the
   CSP/XSS reasoning in §3.3 applies.

Confirmed **absent** by inspection, not assumption: no `indexedDB` / `idb` usage anywhere; no
service worker, no `caches` / cache storage, no web manifest; no analytics, error-reporting or
diagnostic SDK (no `sentry`, `gtag`, `posthog`, `mixpanel`, `bugsnag`, `datadog` in `src/`,
`server/` or `package.json` — the only grep hit is a comment in `server/utm.mjs` about UTM
attribution, unrelated); no `window.onerror` / `unhandledrejection` / React error boundary
that could ship payloads anywhere.

### 1.4 Server-side logging and error handling (verified)

- `server/handler.mjs:51` logs `route: routeOf(url)` — **query strings are stripped**
  (`server/log.mjs::routeOf`). A seed in a query string would not reach the log line, but it
  would still be a bad place for it; seeds are refused in the query (§6).
- `server/log.mjs` `FORBIDDEN_KEYS` currently covers `authorization`, `cookie`, `set-cookie`,
  `token`, `access_token`, `refresh_token`, `client_secret`, `secret`, `password`, `body`,
  `rawbody`, `apikey`, `api_key`. It does **not** cover `prompt`, `seeds`, `messages`,
  `api-key`, `x-api-key`.
- `scrub()` additionally masks `Bearer …` and `access_token=…` inside strings. It does **not**
  know about `sk-…` or `sk-ant-…` key formats.
- **`server/handler.mjs:128` logs the exception message for 5xx**: `logger.error(\`[api] ${e.code}: ${e.message}\`)`.
  This bypasses `scrub()` because it receives a string, not fields. Any exception whose
  `message` embeds the key or the provider body would be written to logs.
  → Constraint: the private module must catch everything and re-throw **only** our own coded
  errors with **fixed** messages. (AC3/T3)

### 1.5 Existing primitives to reuse (not rebuild)

| Need | Existing thing |
|---|---|
| Keyed egress with `redirect:'error'`, bounded retries, 502 mapping | `server/core.mjs::request()` |
| Tenant-bound sealing (if option B is ever chosen) | `server/connectors/crypto.mjs` |
| Closed permission list | `server/tenancy.mjs::PERMISSIONS` / `MATRIX` |
| Rate limiting primitive | `server/limits.mjs::createRateLimiter` (per process; **agency routes are not rate-limited today**, so the private route would be the first) |
| Body cap | `config.track.maxBodyBytes` (default 256 KB) |
| Audit contract | `server/tenancy.mjs::audit()` |

### 1.6 Constraint that decides the architecture

`server/csp.mjs` sets `default-src 'self'` and `connect-src 'self'` plus Firebase auth hosts.
A browser→provider call is therefore **blocked by policy today**. Slice 1 does not change
that: the call is proxied by our server. Widening `connect-src` to provider hosts would let
any injected script use the tab's key, which is precisely the failure mode this feature must
avoid.

---

## 2. Activation

### 2.1 Server-wide flag, default off

| Variable | Type | Default | Meaning |
|---|---|---|---|
| `PRIVATE_RESEARCH_ENABLED` | `'true' \| 'false'` | **`false`** | The feature exists at all |
| `PRIVATE_RESEARCH_PROVIDERS` | csv | `openai` | Allowlist subset of `openai,anthropic` |
| `PRIVATE_RESEARCH_MODELS` | csv | see §2.3 | Model ids accepted, per provider |
| `PRIVATE_RESEARCH_TIMEOUT_MS` | int | `20000` | Wall-clock cap per call |
| `PRIVATE_RESEARCH_MAX_CLUSTERS` | int | `40` | Clusters per request |
| `PRIVATE_RESEARCH_MAX_RESPONSE_BYTES` | int | `262144` | Response cap before parse |
| `PRIVATE_RESEARCH_PER_MINUTE` | int | `20` | Per-process rate limit, per actor |

Parsed with the existing `int()` / string helpers in `server/config.mjs`, so a bad value is a
`ConfigError` at boot, not at request time.

**No per-workspace setting, no per-organization setting, no workspace enablement UI.** Rev. 1
proposed a `privateResearch` object on orgs and workspaces and a precedence chain; that is
**withdrawn** because a server-wide flag is simpler, cannot be mis-set per tenant, and keeps
slice 1 small. Workspace-level enablement is **deferred** (§8) and no data-model field is
added for it now, so nothing has to be migrated later.

### 2.2 Routes

The private run is **organization-scoped**, not workspace-scoped, precisely because there is
no workspace-level enablement:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/orgs/:orgId/research/private` | `{ enabled: true, providers: [...] }` when the flag is on and the caller is permitted |
| `POST` | `/api/orgs/:orgId/research/private/run` | One naming run |

**Status-code precedence is explicit and identical for both routes:**

1. **Flag off:** return `404 not_configured` with the fixed body
   `{"error":{"code":"not_configured","message":"Private research is not configured on this server."}}`.
   Do not disclose provider details. This check precedes authentication.
2. **Flag on:** authenticate the caller. A missing or invalid principal returns `401`.
3. Resolve organization membership and the `research.private` permission. An organization
   outsider follows the existing tenancy contract (`404`); an authenticated member without
   permission receives `403`.
4. **Only after authorization succeeds** may the route disclose provider status or execute a
   provider request.

The no-principal `401` case therefore applies **only while the feature flag is enabled**.
The flag-off response is deliberately indistinguishable from a route that does not exist and
never reveals which providers or models would have been available. (AC1/T1, AC2/T2)

### 2.3 Providers and models (v1)

Hard-coded hosts only. **No client-supplied URL, ever.** (AC9/T10)

| Provider | Host | Default model |
|---|---|---|
| `openai` | `https://api.openai.com` | `gpt-4o-mini` |
| `anthropic` | `https://api.anthropic.com` | `claude-3-5-haiku-latest` |

The client may choose a provider **from the enabled list** and a model **from that provider's
allowlisted set**. Anything else is `400 invalid_model` / `400 invalid_provider`. A request
that names a host is rejected; no field for one exists in the schema.

### 2.4 Authorization

`research.private` is added to `PERMISSIONS` and granted to **editor, admin, owner** — the
three roles that already hold `research.write`. `viewer` and `analyst` do **not** get it (they
cannot change research output, and a model-named hint set is research output).

Every route resolves `tenancy.context(principal, orgId, 'research.private')` **first**, which
reuses the existing authentication and authorization path: signature verification, membership
lookup, role check, and the 404-vs-403 distinction the codebase already applies to other
tenants. There is no second authorization code path to keep in sync. (AC2/T2)

**No plan check.** A Free organization gets exactly the same behaviour as a Pro one while the
flag is on. This is intentional: `plan: 'pro'` cannot be set by any endpoint or script today
(only `'free'` is ever written), so a Pro gate would make the feature unreachable.

---

## 3. Key handling

### 3.1 Decision

**Per-run key, nothing at rest (Q2 = A).** The key arrives in the request body, is used inside
one request, and goes out of scope at return. There is no key storage, no key cache, no
module-level map, no sealed record. Consequently there is no rotation, no revocation endpoint
and no "stored keys" surface to compromise.

### 3.2 Handling rules

- The key is a **local `const`** inside the handler, passed as an argument. It is never
  attached to `req`, never placed on a long-lived object, never stored in `Map`/`WeakMap`
  keyed by org or user.
- It is **never** written to the audit entry, the response, a header we emit, or a log field.
- Shape is validated before use (`sk-…` for OpenAI, `sk-ant-…` for Anthropic) so an obviously
  wrong value is **our** `400`, with no request to the provider. This is not authentication.
- Provider failures are mapped to our own codes: `401 provider_key_rejected`,
  `429 provider_throttled`, `502 provider_unavailable`, `504 provider_timeout`,
  `502 invalid_provider_output`. **The upstream body is never forwarded, echoed or logged** —
  provider error bodies routinely contain fragments of the request.
- The module catches everything. It must never let an exception escape whose `message`
  contains the key, a seed, or provider text, because `handler.mjs:128` logs 5xx messages
  verbatim (§1.4).
- Errors returned to the browser carry a fixed `message` per code and nothing else.

### 3.3 What this design does **not** promise

The honest statement, approved as Q3 and used verbatim in the UI and in `PRIVACY.md`:

> **"your key and seeds pass through our server process in memory, never persisted, never logged."**

It does **not** claim:

- that the operator cannot read process memory while a request is in flight;
- that the selected provider does not retain the content we send it — **it may**, under its
  own policy, which we do not control and cannot audit;
- that the request is end-to-end encrypted, anonymous, or "zero knowledge".

`PRIVACY.md` and the UI must carry the provider-retention sentence explicitly.

---

## 4. Privacy boundary

### 4.1 The complete flow

```
┌──────────┐   1. seeds + clusters + key     ┌──────────────────┐
│ Browser  │ ──────────────────────────────► │ Application      │
│          │      (HTTPS, in memory)         │ server           │
│          │                                 │                  │
│          │                                 │ 2. authn/authz   │
│          │                                 │ 3. flag + allow- │
│          │                                 │    list checks   │
│          │                                 │ 4. key in memory │
└──────────┘                                 └────────┬─────────┘
     ▲                                                │ 5. POST with key
     │ 8. names (ephemeral)                           ▼
     │                                       ┌──────────────────┐
     └────────────────────────────────────── │ Selected         │
                                             │ provider         │
                                             │ (OpenAI/Anthropic)│
                                             └──────────────────┘
                                             6. provider returns; it MAY
                                                retain what we sent under
                                                its own policy
                                             7. our server parses, validates,
                                                discards key + prompt + body
```

Steps 1 and 8 are the only points where content exists on our side. Step 5 is where content
leaves our control; step 6 is the fact we must state rather than hide.

### 4.2 What may be stored, by exact location

| Location | API key | Raw seeds | Prompt | Provider response | Model-generated names | Notes |
|---|:--:|:--:|:--:|:--:|:--:|---|
| Application memory (in request) | transient | transient | transient | transient | transient | freed at return |
| `researchRuns` store | never | never | never | never | never | **not written by slice 1** |
| `auditLog` `detail` | never | never | never | never | never | allowlist, §5 |
| Request logs | never | never | never | never | never | route/status/duration only |
| Exception path (`handler.mjs:128`) | never | never | never | never | never | fixed messages only (§3.2) |
| `localStorage['adtrack.audit.v1']` | never | never | never | never | **never** | holds `before`/`after` hint arrays; slice 1 never pushes (AC6) |
| `sessionStorage` (auth token) | never | never | never | never | never | holds our session token only |
| URL query (`?q=`) | never | **never** | never | never | never | written by `App.tsx:142`; seeds must not enter `asked.q` (AC4) |
| IndexedDB | — | — | — | — | — | **not used** (verified) |
| Service worker / cache storage / manifest | — | — | — | — | — | **not used** (verified) |
| Analytics / error reporting | — | — | — | — | — | **no SDK present** (verified) |

### 4.3 The boundaries, stated as rules a test can check

1. No store write other than the single `auditLog` record.
2. No representation of the key outside the request scope, in any store, log, audit record or
   response body.
3. No seed text or generated name in `localStorage`, `sessionStorage`, the URL, IndexedDB, or
   any cache.
4. A generated name lives only in React component state until the user discards it (or, after
   slice 1, explicitly saves it — a deferred step).

---

## 5. The audit entry

Exactly **one** record per attempted run, written through the existing `tenancy.audit()` so it
lands in the same `auditLog` collection with the same contract: `id` and `at` are assigned by
the contract itself (`tenancy.mjs:140-155`).

### 5.1 Allowlist (all other keys must be rejected by test)

| Key | Type | Permitted values | Required |
|---|---|---|---|
| `action` | const | `'research.private.run'` | yes |
| `organizationId` | string | resolved org id | yes |
| `workspaceId` | null | **always null** (route is org-scoped) | yes |
| `actor` | string | `principal.uid` | yes |
| `actorRole` | enum | one of `ORG_ROLES` | yes |
| `target` | null | **always null** | yes |
| `ok` | boolean | `true` on success, `false` on failure | yes |
| `detail.provider` | enum | `'openai' \| 'anthropic'` | yes |
| `detail.model` | enum | configured allowlisted id | yes |
| `detail.clusterCount` | integer | `1 … PRIVATE_RESEARCH_MAX_CLUSTERS` | yes |
| `detail.outcome` | enum | `'ok' \| 'provider_error' \| 'invalid_output' \| 'timeout' \| 'rejected'` | yes |
| `detail.errorCode` | enum | one of the fixed internal codes listed below | optional; only when `ok: false` |

`detail` has **exactly four mandatory keys** — `provider`, `model`, `clusterCount`, `outcome` —
and at most one optional key, `errorCode`. The permitted `errorCode` values are the fixed
internal enum `provider_key_rejected`, `provider_throttled`, `provider_unavailable`,
`provider_timeout`, `invalid_provider_output`, `invalid_request`, `invalid_provider`,
`invalid_model`, `busy`, `rate_limited`, `audit_unavailable`, and `internal_error`.
The implementation must reject any additional `detail` key; it must not spread caller or
provider objects into the audit entry. No arbitrary string is accepted for `errorCode`.

### 5.2 Never in the audit entry

API keys and authorization headers; raw seeds or prompts; generated names; provider response
text; provider error bodies; any free-form user string (goal text, notes, cluster labels,
workspace names). `detail` is an object with exactly the four mandatory keys and optional
`errorCode` described above — no additional fields or arbitrary strings. The existing contract
permits arbitrary `detail`, which is exactly why the allowlist is enforced by construction
**and** by test (AC5/T5).

### 5.3 If audit recording fails

The write is the **last** step before responding. If it throws:

- the run is **not** reported as successful — the response is
  `503 {"error":{"code":"audit_unavailable","message":"The run could not be recorded and was discarded."}}`,
- **no names are returned**, so nothing derived from the request survives anywhere,
- the failure is logged as `audit_unavailable` (no content),
- and the deterministic result the user already has in the panel is untouched.

We accept that the provider call has already happened and the user's key was already used when
this failure occurs; that cost cannot be undone. What we refuse to do is **report a successful
run that our audit policy could not record**. (AC7/T6)

---

## 6. Request and response contract

### 6.1 Request (POST, JSON, `application/json`)

```jsonc
{
  "provider": "openai",          // enum from enabled list
  "model": "gpt-4o-mini",        // enum from that provider's allowlist
  "apiKey": "sk-…",              // never logged, never stored, never echoed
  "clusters": [                  // 1..PRIVATE_RESEARCH_MAX_CLUSTERS
    { "id": "c_1", "label": "broad · gst filing", "seeds": ["…", "…"] }
  ]
}
```

Rules enforced server-side:

- **Body cap** — the existing `maxBodyBytes` (256 KB default) applies; a larger body is
  rejected before parsing.
- **Seeds refused in the query string.** `/research/private/run?seeds=…` is `400
  invalid_request` regardless of body, so a seed can never reach `req.query`.
- `clusters` must be an array of the declared shape; `id` must be a non-empty string; `seeds`
  an array of strings within a per-cluster cap; unknown keys in the body or in a cluster are
  rejected (strict schema, no silent ignore).
- **Concurrency** — a per-actor in-flight guard rejects a second simultaneous run with
  `429 busy` (per process; documented limitation, same as the rate limiter).
- **Rate limit** — `PRIVATE_RESEARCH_PER_MINUTE` per actor, per process.

### 6.2 Response (200)

```jsonc
{
  "names": [{ "id": "c_1", "name": "GST filing deadlines for small business" }],
  "provider": "openai",
  "model": "gpt-4o-mini"
}
```

The response contains **only** ids that were sent. The model cannot introduce an id.

### 6.3 Model-output validation (the part that protects cluster integrity)

1. Response bytes capped **before** JSON parse.
2. Must parse as JSON; must match the provider's expected envelope; the names array must be
   the only thing extracted. Prose, markdown fences or extra fields are rejected as
   `invalid_provider_output` — not "best-effort repaired".
3. Every returned `id` must be **exactly one of the ids sent**, with no duplicates and no
   missing ids. Any unknown id, duplicate or omission rejects the **whole** response.
4. Each `name` must be a string within length bounds; control characters stripped; names are
   rendered as **text**, never as HTML.
5. Nothing from the response is merged into the deterministic result. The client keeps two
   separate objects — deterministic clusters (source of truth) and an optional
   `namesById` overlay — so a rejected or partial naming run cannot corrupt cluster IDs,
   membership, scores or seeding. (AC8/T9)

---

## 7. UI

- The mode control renders **only** when `GET /api/orgs/:orgId/research/private` answers
  `200`; a `404` means the control is absent, not disabled-with-a-teaser.
- The disclosure block, above the key field and always visible when the panel is open:
  - *"your key and seeds pass through our server process in memory, never persisted, never logged"*
  - *"the request is sent to {provider}; {provider} may retain it under its own policy"*
  - *"nothing is saved: not the key, not the seeds, not the names"*
- Key field is `type="password"`, `autocomplete="off"`, `name` chosen to avoid password-manager
  heuristics, and cleared from component state after the request resolves.
- Results are labelled **"model-named"** per cluster so a generated name is never mistaken for
  a deterministic one, and the overlay can be dismissed to return to deterministic names.
- On failure the panel states the code and that **the deterministic result is unaffected**.
- No push/undo, no save, no copy-to-clipboard-into-an-audited-field action in slice 1.

---

## 8. Deferred explicitly

| Deferred | Why |
|---|---|
| Workspace- or org-level enablement and its UI | Slice 1 is a server-wide flag; adds schema + UI + precedence for no slice-1 benefit |
| Pro / plan gating | No way to set `plan: 'pro'`; also a commercial decision |
| Key sealed at rest (design option B) | Q2 decision; needs a second encryption key and a revoke path |
| Research-run persistence (`mode`/`provider`/`model`/`usage` on `researchRuns`) | Slice 1 persists nothing |
| Embeddings / semantic clustering | Different pipeline; Q1 = naming only |
| Model-generated hints | Prompt surface grows; naming must be proven first |
| Custom / OpenAI-compatible base URLs | SSRF surface; Q5 = named providers only |
| Streaming, cost dashboard, quotas, billing | Out of scope for this phase |

---

## 9. Document agreement

This document and `docs/PRIVATE_RESEARCH_MODE_PLAN.md` are required to agree on: scope,
routes, authorization, configuration, privacy boundary, audit contract, persistence and test
expectations. The plan file carries the corresponding statements and the same AC/T identifiers;
where a detail appears in one it appears in the other. §10 of the plan file is the
cross-check list.

---

## 10. Open questions and residual risk

**Unresolved ambiguity (needs a decision, none blocks the plan review):**

1. **Provider retention wording** — the disclosure says the provider *may* retain content.
   Legal may want the provider's exact retention link shown. Nothing in the code depends on it.
2. **`actorRole` in the audit entry** — the role at the time of the run is recorded. If roles
   change later, the entry still shows the historical role; that is intended but worth
   confirming with whoever reads the audit trail.
3. **Is `clusterCount` alone enough** for cost/abuse analysis? Token counts would be more
   useful but constitute usage data; excluded from slice 1 for minimality.
4. **Rate limiter is per process**, so N replicas multiply the effective limit. Accepted
   (same known limitation as Phase 4 P4-S3); a WAF or shared counter is the real fix.

**Residual risks:** see §5 of the plan file (R1–R9). The two high ones are key leakage
through a log/exception path and unintended content persistence; both are addressed by
construction plus explicit tests, not by convention.
