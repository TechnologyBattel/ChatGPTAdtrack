# Private Research Mode — implementation plan (rev. 2, slice 1)

**Status:** revised proposal, awaiting explicit approval. **No application code, configuration,
dependency or test file has been written or modified.**
**Date:** 2026-10-26 · **Branch:** `arena/b0e01b66-chatgptadtrack`
**Design:** `docs/PRIVATE_RESEARCH_MODE.md` (rev. 2). §10 below is the agreement cross-check.

---

## 1. Decisions carried into slice 1

| # | Decision |
|---|---|
| **Scope** | **Limited beta.** Server-wide feature flag, **disabled by default**. No per-workspace settings, no workspace enablement UI — **deferred**. |
| **AI role** | **Optional cluster naming only.** The deterministic pipeline (`src/lib/research.ts`) remains the source of truth for clustering, membership, scoring, validators and hints. |
| **Key** | **Per-run, in memory.** Never persisted, never logged, never echoed. No sealed-at-rest storage. |
| **Disclosure** | Verbatim: *"your key and seeds pass through our server process in memory, never persisted, never logged."* Plus the provider-retention statement; no claim that the provider keeps nothing. |
| **Gating** | **None.** Not plan-gated, no billing, no quota. Flag only. |
| **Providers** | Named hosts only — `api.openai.com`, `api.anthropic.com`. **No custom base URLs.** |
| **Persistence** | **Nothing.** Not the key, seeds, prompt, response or generated names. One metadata-only audit line per attempt. |
| **Excluded** | Embeddings, model-generated hints, research-run persistence, streaming, billing. |

---

## 2. Files

### 2.1 New (5)

| File | Purpose | Est. |
|---|---|---|
| `server/private-research.mjs` | The only module that sees a key: strict body schema, key shape check, provider adapters (fixed hosts), egress through `core.request` semantics, response validation, caps, audit payload construction. | ~240 lines |
| `server/private-research.d.mts` | Declarations — required, every `server/*.mjs` in this repo has one. | ~30 |
| `src/lib/private-research.ts` | Client wrapper: `getPrivateStatus()` and `runPrivateNaming()`. The key is a function argument; it never enters React state or storage. | ~70 |
| `src/components/PrivateResearchPanel.tsx` | Disclosure block, key field, provider/model select, run, result/failure states, dismiss overlay. | ~140 |
| `src/lib/__tests__/private-research.test.ts` | The acceptance tests for AC1–AC9 (§4). | ~300 |

### 2.2 Modified (10)

| File | Change |
|---|---|
| `server/config.mjs` + `.d.mts` | `privateResearch: { enabled, providers[], models{}, timeoutMs, maxClusters, maxResponseBytes, perMinute }`, parsed with the existing `int()`/string helpers so bad values fail at boot. |
| `server/tenancy.mjs` + `.d.mts` | Add `research.private` to `PERMISSIONS`; grant to `editor`, `admin`, `owner` in `MATRIX`. `owner: [...PERMISSIONS]` picks it up automatically. |
| `server/agency.mjs` + `.d.mts` | Two org-scoped routes (§3); factory accepts `privateResearch` (nullable, like `sources`). |
| `server/server.mjs` | Construct the module only when the flag is on; one boot line stating enabled/disabled and the provider list. |
| `server/log.mjs` | Extend `FORBIDDEN_KEYS` with `prompt`, `prompts`, `messages`, `seeds`, `api-key`, `x-api-key`. |
| `src/components/Research.tsx` | Render the panel when status is `200`; keep deterministic result and the `namesById` overlay in **separate** state. |
| `.env.example` | The seven variables, documented, all defaulting to off. |
| `docs/PRIVACY.md` | The §4.2 storage table and the disclosure text, verbatim, plus provider retention. |
| `docs/PRICING.md` | Private Mode row → **"Limited beta — server flag, not plan-gated"**. Must not read "available". |
| `docs/OPERATIONS.md` | How to enable/disable the flag; no key material exists to rotate. |

### 2.3 Untouched (and required to stay untouched)

`server/core.mjs` (reused), **`server/csp.mjs` (no CSP change)**, `server/research.mjs` (**no
writes, no new fields**), `firestore.rules`, `firestore.indexes.json`, the deterministic
functions in `src/lib/research.ts`, `src/lib/hints.ts` (the localStorage audit store), and the
ad-push / attribution / connector / consent / tracking paths.

---

## 3. Routes and behaviour

| Method | Path | Flag off (checked first) | Flag on, no principal | Flag on, outsider | Flag on, member without permission | Flag on, permitted |
|---|---|---|---|---|---|---|
| `GET` | `/api/orgs/:orgId/research/private` | `404 not_configured` | `401 unauthorized` | `404 not_found` | `403 forbidden` | `200 {enabled:true, providers:[…]}` |
| `POST` | `/api/orgs/:orgId/research/private/run` | `404 not_configured` | `401 unauthorized` | `404 not_found` | `403 forbidden` | `200 {names:[…]}` or a coded error |

Status-code precedence is mandatory for both routes:

1. **Flag off:** return the fixed `404 not_configured` body without provider details; this check
   happens before authentication.
2. **Flag on:** authenticate. A missing or invalid principal receives `401`.
3. Resolve organization membership. An outsider receives the existing tenancy `404`.
4. Check `research.private`; an authenticated member without permission receives `403`.
5. Only after authorization succeeds may provider status be disclosed or a provider request run.

The no-principal `401` case applies **only when the feature flag is enabled**. The exact
`401` error code/body must follow the repository's existing authentication contract; do not
invent a new public error shape.

- **Organization-scoped**, not workspace-scoped: there is no per-workspace enablement, and an
  org-scoped route does not imply one.
- `404` when off is deliberate — the feature must not advertise its existence or its provider
  configuration. The body is fixed and never lists providers or models.
- Authorization must be checked before any provider details are disclosed or any provider call
  is made.

---

## 4. Acceptance criteria and tests

Legend — **U** unit (vitest, node env, injected `fetchImpl`, existing harness), **C** component
(vitest + RTL, jsdom), **B** browser (Playwright, needs Chromium), **I** integration infra
(real provider or real Firestore — **not available in this environment; must be marked NOT
RUN, never assumed**).

| AC | Requirement | Tests | Layer |
|---|---|---|---|
| **AC1** | Flag off → `404 not_configured`; no provider configuration disclosed | T1a: `GET` returns 404 with exactly `{error:{code:'not_configured'}}`; T1b: `POST` same; T1c: response body contains neither `openai` nor `anthropic` nor any model id | U |
| **AC2** | Explicit status precedence when enabled; editor/admin/owner allowed; viewer/analyst denied — verified **server-side** | T2a: flag enabled, no principal → existing-contract 401 on both routes; T2b: each of the 5 roles against both routes; T2c: outsider org → 404 (not 403), matching existing tenancy semantics; T2d: member without permission → 403; T2e: flag-off + no principal → fixed 404, not 401; no provider call/config disclosure before authorization | U |
| **AC3** | Key redacted across success, timeout, malformed output, upstream 400/401/429/500, internal exception | T3a–T3g: capture the logger sink and the thrown/returned error for each path, assert the key string and its `sk-` fragment appear nowhere; T3h: forced internal exception (adapter throws) → 502/500 with a fixed message containing no key | U |
| **AC4** | Zero research-content persistence on every real storage path | T4a: spy `store.records.put` — exactly **one** write, to `auditLog`; T4b: no write contains a seed string or a generated name; T4c: client — after a run, `localStorage` and `sessionStorage` contain neither seeds nor names; T4d: the URL does not gain `?q=` from a private run | U + C |
| **AC5** | Exact audit-entry shape; `detail` has four mandatory keys and one optional enum key; extra fields rejected | T5a: assert the record's key set equals the allowlist exactly (`id`,`at`,`action`,`organizationId`,`workspaceId`,`actor`,`actorRole`,`target`,`ok`,`detail`); T5b: `detail` contains exactly `provider`, `model`, `clusterCount`, `outcome`, and optionally `errorCode`; T5c: `errorCode` must be from the fixed internal enum and is absent on success; T5d: `workspaceId` and `target` are `null`; T5e: injecting any extra `detail` key or arbitrary error string is rejected by the builder | U |
| **AC6** | Generated names never reach `localStorage`, research history, audit history or push/undo persistence | T6a: after a naming run, `adtrack.audit.v1` is byte-identical to before; T6b: `researchRuns` is not written; T6c: `hints.appendAudit` is not invoked (spy) | U + C |
| **AC7** | Deterministic results remain available when the AI call fails | T7a: provider 500 / timeout / invalid output → component still renders the deterministic clusters and names; T7b: overlay is empty and the UI states the deterministic result is unaffected | C |
| **AC8** | Malformed output rejected safely; cannot corrupt ids or membership | T8a: unknown id → reject whole response; T8b: duplicate id → reject; T8c: missing id → reject; T8d: non-object / prose / fenced JSON → reject; T8e: overlong name → reject; T8f: after every rejection the deterministic cluster array is deep-equal to what it was before | U + C |
| **AC9** | Request, response, timeout, concurrency and rate limits enforced server-side | T9a: body over `maxBodyBytes` → 413/400 before parse; T9b: `clusters.length > maxClusters` → 400; T9c: response over `maxResponseBytes` → rejected before parse; T9d: `timeoutMs` exceeded → `504 provider_timeout`; T9e: two concurrent runs for the same actor → second gets `429 busy`; T9f: `perMinute` exceeded → 429 with `Retry-After` | U |
| **AC10** | Concurrency and failure cannot bypass authorization or cross-expose keys/content | T10a: interleaved runs for two actors — each response contains only its own ids and the logger sees neither key; T10b: actor A's failed run cannot return B's content; T10c: after a rejected run, the in-flight guard is released (no permanent `429 busy`); T10d: authz is re-evaluated per request, not cached | U |
| **AC11** | Existing tests unchanged unless a genuine behaviour change is justified; nothing weakened | T11: full suite (529 passed / 2 skipped today) passes with **zero edits**. Any edit must be listed and justified in the final report | U/C/B |

**Audit `detail` schema (normative):** exactly four mandatory keys — `provider`, `model`,
`clusterCount`, `outcome` — and at most one optional key, `errorCode`. The `errorCode` value,
when present, must be one of the fixed internal enum values `provider_key_rejected`,
`provider_throttled`, `provider_unavailable`, `provider_timeout`, `invalid_provider_output`,
`invalid_request`, `invalid_provider`, `invalid_model`, `busy`, `rate_limited`,
`audit_unavailable`, or `internal_error`; it is omitted on success. Any extra key, arbitrary
string, provider error body or caller-supplied metadata is rejected and never persisted.

### 4.1 Additional tests

| # | Test | Layer |
|---|---|---|
| T12 | Disclosure text renders **above** the key field; key input is `type="password"` | C |
| T13 | Panel hidden entirely when status is `404` (not disabled-with-teaser) | C |
| T14 | E2E against a stub provider: enable flag → run → names applied; **no browser→provider request** in the network log | B |
| T15 | Non-allowlisted provider/model → `400`; a body field named `url`/`baseUrl` → `400` (no such field exists) | U |
| T16 | Seed text supplied via query string → `400 invalid_request` | U |
| T17 | Deterministic-only path: with the flag off, `Research.tsx` behaves byte-identically (snapshot of visible output) | C |

### 4.2 Test expectations that must be written down now

- **No test may be weakened to make the suite pass.** If a slice-1 test and an existing test
  conflict, the conflict is reported, not resolved by deleting assertions.
- **T11 is the backward-compatibility gate**: it is a claim about the *existing* 529 tests, run
  unmodified.
- **AC3 and AC4 are constructor-level.** They assert on the logger sink and on the store spy,
  so a future refactor that starts logging the body fails them.
- **Integration (I) tests for real providers and real Firestore are out of scope** and will be
  reported as **NOT RUN**, never as passing.

---

## 5. Risks

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | Key leaks via `handler.mjs:128`, which logs 5xx `e.message` **unsanitised** | **High** | module catches all; only our coded errors with fixed messages escape; AC3/T3h asserts |
| R2 | Content persisted through an existing writer | **High** | slice 1 performs no store writes except audit; AC4/T4 asserts the exact write set |
| R3 | Keys leak via `scrub()`, which does not recognise `sk-` formats | **High** | `FORBIDDEN_KEYS` extended; the key never enters a log field; AC3 asserts absence |
| R4 | Generated names land in `localStorage['adtrack.audit.v1']` via push/undo | Medium | slice 1 has no push from the panel; AC6/T6 asserts byte-identity |
| R5 | Seeds leak into the URL via `App.tsx` `?q=` | Medium | private seeds never enter `asked.q`; AC4/T4d asserts |
| R6 | Model output corrupts cluster ids/membership | Medium | separate overlay object; all-or-nothing validation; AC8 |
| R7 | Audit failure reported as success | **High** | audit write is last; failure → `503 audit_unavailable`, no names returned; AC7 of the design doc, tested via T5e |
| R8 | Rate limiter is per process (N replicas multiply limits) | Known | documented; same accepted limitation as Phase 4 P4-S3; WAF or shared counter is the real fix |
| R9 | "Private" over-read as "we cannot see it" | Medium | disclosure text is a fixed string, rendered above the input, asserted by T12 |
| R10 | Flag turned on without an operator knowing the consequences | Medium | boot log line; ops doc; default off |

---

## 6. Implementation sequence

Docs and guards first; UI last. Every step leaves the app working.

| Step | Work | Verification |
|---|---|---|
| 1 | `docs/PRIVACY.md` — boundary + disclosure | review only |
| 2 | `server/log.mjs` — `FORBIDDEN_KEYS` | `npx vitest run src/lib/__tests__/observability.test.ts` |
| 3 | `server/config.mjs` + `.d.mts`, `.env.example` | `npx tsc --noEmit`; boot with a bad value fails |
| 4 | `server/tenancy.mjs` + `.d.mts` — `research.private` | `npx vitest run src/lib/__tests__/tenancy.test.ts` |
| 5 | `server/private-research.mjs` + `.d.mts` | `npx tsc --noEmit` |
| 6 | `src/lib/__tests__/private-research.test.ts` (AC1–AC9) | `npx vitest run src/lib/__tests__/private-research.test.ts` |
| 7 | `server/agency.mjs` + `.d.mts`, `server/server.mjs` | same test file (routes exercised through `app.handle`) |
| 8 | `src/lib/private-research.ts` | `npx tsc --noEmit` |
| 9 | `src/components/PrivateResearchPanel.tsx`, `src/components/Research.tsx` | component tests (AC4c, AC6a, AC7, T12, T13, T17) |
| 10 | `docs/PRICING.md`, `docs/OPERATIONS.md` | review only |
| 11 | Full gate | §7 |

---

## 7. Verification commands

```bash
npx tsc --noEmit                     # types, including the .d.mts files
npx eslint .                         # lint
npx prettier --check .               # format
npx vitest run                       # expect 529 → ~549 passed, 2 skipped
npx vite build                       # production build
LD_LIBRARY_PATH=… PLAYWRIGHT_CHROMIUM_EXECUTABLE=… npx playwright test   # 9 → 10 specs
npm run verify                       # the full repo gate
```

Expected results are **stated before running**; the final report will state what actually
happened, including any test that had to change and why. Nothing in this plan is claimed as
passing until it is run.

---

## 8. What slice 1 deliberately does not build

Workspace-level enablement and its UI · Pro/plan gating · sealed keys at rest · embeddings ·
model-generated hints · custom provider URLs · research-run persistence (`mode`/`provider`/
`model` on `researchRuns`) · streaming · cost dashboard · quotas · billing · any push or save
of a model-generated name.

---

## 9. Approval required before implementation

Two points are worth an explicit yes, beyond the plan itself:

1. **`research.private` → editor, admin, owner** (the roles that already hold
   `research.write`). Viewer and analyst are excluded.
2. **Audit-failure behaviour**: a run whose audit entry cannot be written returns
   `503 audit_unavailable` and **no names**, even though the provider call already happened
   and the user's key was already used. This is the "never falsely report success" choice,
   and it is intentionally the strict option.

---

## 10. Document agreement cross-check

Both documents were edited together; this table is the checklist.

| Topic | `PRIVATE_RESEARCH_MODE.md` | `PRIVATE_RESEARCH_MODE_PLAN.md` | Agree |
|---|---|---|---|
| Activation | §2.1 server-wide flag, default off | §1, §2.2 (`config.mjs`), §3 | ✓ |
| Per-workspace settings | §2.1 — withdrawn, deferred (§8) | §1, §2.3 untouched list, §8 | ✓ |
| Workspace enablement UI | §2.1, §7 (no mode control unless status 200) | §8 | ✓ |
| Roles | §2.4 editor/admin/owner | §1, §2.2, §9.1 | ✓ |
| No plan gating | §2.4 | §1, §8 | ✓ |
| Routes | §2.2 (org-scoped, two routes) | §3 (same paths, same status codes) | ✓ |
| Flag-off behaviour | §2.2 `404 not_configured`, no config disclosed | §3 + AC1/T1 | ✓ |
| Providers | §2.3 OpenAI + Anthropic, fixed hosts | §1, AC9/T15 | ✓ |
| Key handling | §3.1–3.3 per-run, memory only | §1, §2.1, T3 | ✓ |
| Disclosure text | §3.3 verbatim | §1 verbatim, T12 | ✓ |
| Provider retention | §3.3, §4.1 step 6 | §1 | ✓ |
| Persistence boundary | §4.2 table, §4.3 rules | §4 AC4, AC6; §2.3 untouched | ✓ |
| Audit contract | §5.1–5.3: four mandatory `detail` keys, optional fixed-enum `errorCode`, reject extras + failure behaviour | §4 AC5; §9.2 | ✓ |
| Status-code precedence | §2.2: flag off → 404; flag on → authenticate → membership → permission → provider status/run | §3 route matrix + explicit order; AC2/T2 | ✓ |
| Response validation | §6.3 | §4 AC8 | ✓ |
| Limits | §6.1, §10 | AC9 | ✓ |
| Deferred list | §8 | §8 | ✓ |
| Existing tests unchanged | §1.1 deterministic pipeline untouched | AC11, T11 | ✓ |

No contradiction between the two files on scope, routes, authorization, configuration, privacy,
audit or persistence as of this revision.
