# Baseline and gaps — Phase 0

_Date: 2026-10-25 · Branch `arena/b0e01b66-chatgptadtrack` · Baseline commit `a984a6f` ("Create PRIVACY.md") · Node 22.22.3 (`package.json` engines `>=22 <23`, `.nvmrc` 22.22.0)_

This is the Phase 0 gate: what the repository contained **before** any Phase 1 work, what
was wrong with it, what was remediated, and what is still missing. Every claim below is
tagged with how it is known.

| Mark | Meaning |
|---|---|
| **PROVEN** | I ran a command and read its output; the command and exit code are recorded. |
| **CLAIMED** | A source (docs, previous session note, or code comment) says so; I did not independently execute it. |
| **UNKNOWN** | Not executed, not observable here, or needs credentials/environment this sandbox does not have. |

Nothing in this file is a statement that the product is production-ready. Building,
linting and testing say the code does what its tests assert; they say nothing about a
real ad account, real traffic, real consent obligations, or legal compliance.

---

## 1. Baseline: what existed at `a984a6f`

**PROVEN** — `git ls-tree -r --name-only a984a6f` plus `git show a984a6f:<path> | wc -l` for each file.

| File | Lines | Content |
|---|---|---|
| `README.md` | 18 | "Slice 1: Home page and shell (in progress)" |
| `docs/DECISIONS.md` | 7 | 5 dated product decisions |
| `docs/METRICS.md` | 14 | metric dictionary, 3 TODOs |
| `docs/PRIVACY.md` | 8 | privacy notes, 3 TODOs |
| `docs/TRACKING_PLAN.md` | 15 | 4 events, 4 rules |
| `.env.example` | 4 | four empty variables |
| `.gitignore` | 11 | node_modules, dist, .env, keys |

There was **no** `package.json`, no application code, no server, no tests, no CI, no
Firestore rules or indexes. The README's "in progress" was inaccurate: Slice 1 had not
been started. This is a specification skeleton.

Verified by `git ls-files | wc -l` → **7**.

## 2. What was built before this Phase 0 pass

A working React 18 + Vite 6 + TypeScript app and a Node 22 API server, both from scratch,
on the same branch. Summarised here because the gap analysis below refers to them;
details are in `docs/PLAN.md`, `docs/API.md`, `docs/FEATURES.md`, `docs/SECURITY.md`.

- Browser: one-page answer engine over demo data or a live dataset; research mode;
  hint push with undo; CSV/JSON export.
- Server: health, dataset, consent (two-step, single-use), `/api/track`, ad-group hint
  push with audit + outbox, Firestore and in-memory stores behind one contract,
  production start-up guards.
- Existing gate: `npm run verify` → **exit 0, 288 passed / 2 skipped** (PROVEN, run
  before any Phase 1 edit).

## 3. Commands and exit codes (baseline and current)

| # | Command | Result | Verdict |
|---|---|---|---|
| 1 | `git ls-files \| wc -l` | `7` | PROVEN: docs-only baseline |
| 2 | `npm ci` | exit 0 | PROVEN: reproducible install from `package-lock.json` |
| 3 | `npm run verify` (pre-change) | exit 0, 288 passed / 2 skipped | PROVEN |
| 4 | `npm run verify` (post Phase 1) | exit 0, **394 passed / 2 skipped** | PROVEN — see §7 |
| 5 | `npx tsc --noEmit` | exit 0 | PROVEN |
| 6 | `docker build .` | **not run** | UNKNOWN — `docker` is absent from this sandbox (`which docker` → not found) |
| 7 | `curl` against a deployed instance | **not run** | UNKNOWN — nothing is deployed; no ad account or keys exist here |

### Docker

`Dockerfile` and `.dockerignore` are committed and their content reviewed, but **no image
was ever built in this session** and the file has never executed. It is CLAIMED
plausible, not PROVEN. To close this gap on a machine with Docker:

```bash
docker build -t adtrack:local . && docker run --rm -p 8787:8787 \
  -e AUTH_MODE=dev -e STORE=memory adtrack:local
```

The server refuses to start in `NODE_ENV=production` with a memory store, no
`AUTH_MODE`, or no consent secret (PROVEN by `scripts/check-prod-guards.mjs`), so a
successful container start is a subset of the check — not a deployment approval.

## 4. Gaps found, and what happened to each

Severity: **S1** = wrong or unsafe behaviour, **S2** = a required Phase 1 capability that
was absent, **S3** = documentation/ergonomics.

| # | Gap (before) | Sev | Status now | Evidence |
|---|---|---|---|---|
| G1 | Single-tenant only: no organization, workspace, client or brand concept; tenancy decisions in `docs/DECISIONS.md` said "single-tenant v1" | S2 | **Closed** — org → workspace → campaigns/topics/leads/sources, enforced server-side | `server/tenancy.mjs`, `server/agency.mjs`; `tenancy.test.ts` 28 passed |
| G2 | Roles were flat `admin/owner`; no `editor`/`analyst`/`viewer` distinction and no per-org roles | S2 | **Closed** — 5 org roles, 13 named permissions, matrix in code | `server/tenancy.mjs`; `ROLES` in `server/auth.mjs` widened to accept `editor` |
| G3 | No lead lifecycle: `/api/track` accepted a page event and stopped | S2 | **Closed** — schema v2 with 8 event types, deterministic ids, replay rejection | `server/events-v2.mjs`; `events-v2.test.ts` 27 passed |
| G4 | No idempotency: a retried event would duplicate | S1 | **Closed** — doc id `sha256(workspaceId:eventId)`, insert-once (`create`), duplicate acknowledged with `200 {duplicate:true}` | PROVEN |
| G5 | No campaign registry and no UTM discipline | S2 | **Closed** — registry with `draft/ready/archived` + `launchState: not_launched`; shared UTM builder returns every normalisation it applied | `server/agency.mjs`, `server/utm.mjs` |
| G6 | No research registry: research output was never stored with provenance | S2 | **Closed** — topics carry `origin` (`observed`/`ai_suggested`), source (`url`, `method`, `observedAt`), derived `freshness` | `server/agency.mjs`; `agency.test.ts` 30 passed |
| G7 | No connector contract; a provider could be added only by editing routes | S2 | **Closed as documentation + contract** — `docs/CONNECTORS.md` and typed `sources` capability rules. **No fake connector was built.** | `server/sources.mjs` |
| G8 | Country/currency/timezone were free-text in places; `Intl` was the only validator | S1 | **Closed** — shape/membership validation for zones and ISO-4217; `server/time.mjs` for zoned days | `server/validate.mjs`, `server/time.mjs`; `global.test.ts` 16 passed |
| G9 | No retention enforcement: `store.maintenance.purge` existed but nothing called it, and config had no interval | S2 | **Closed** — `retention.sweepEnabled` / `retention.sweepIntervalMs` in config + timer in `server/server.mjs`; owner-only purge route; per-collection day counts | `server/config.mjs`, `server/server.mjs`; PROVEN by runtime probe |
| G10 | Membership records were stored per-tenant, making "which orgs am I in?" unanswerable | S1 | **Closed** — memberships are a global collection keyed `${orgId}__${userId}` | `server/tenancy.mjs`; discovered by a failing test, not by inspection |
| G11 | `freshnessOf` / retention policy / UTM behaviour were untested assumptions | S3 | **Closed** — 102 new tests across 5 files | see §5 |
| G12 | No UI surface for the new hierarchy | S2 | **Closed (minimal, read-only)** — Workspace panel: org/workspace selectors, summary, campaigns, topics, leads, sources, role + permissions | `src/components/WorkspacePanel.tsx`; `workspace-ui.test.tsx` 5 passed |
| G13 | Docs described a single-tenant, no-lead product | S3 | **Closed** — this file plus `AGENCY_MODEL.md`, `EVENT_SCHEMA.md`, `CONNECTORS.md`, `GLOBALIZATION.md`, `DATA_MODEL.md`, and an agency section in `docs/API.md` | — |

### Gaps deliberately **not** closed

| # | Gap | Why not | Mark |
|---|---|---|---|
| G14 | Real OpenAI Ads account integration | Needs paid credentials; the product never invents a connector | UNKNOWN (blocked by design) |
| G15 | OAuth for third-party CRM / Search Console | Needs registered apps and secrets; documented contract only | UNKNOWN (blocked) |
| G16 | Firestore in production | No project, no credentials; the Firestore store is code-reviewed and unit-tested against a fake, never run against a real database | CLAIMED |
| G17 | Deleting a workspace's data in Firestore recursively | `deleteWorkspace` removes known collections; Firestore subcollection deletion is implemented per collection, not recursive-by-API | PROVEN in the memory store, UNKNOWN in Firestore |
| G18 | Write controls in the Workspace panel | Deliberate: writes need audit semantics and per-action confirmation; adding them un-audited would be worse than not having them | decision |
| G19 | Legal compliance of consent/retention choices | A consent banner is not evidence of GDPR/DPDP compliance; DPIA, DPA and jurisdiction review are outside this repo | UNKNOWN |
| G20 | Load/performance characteristics | No load test was run; no number is claimed | UNKNOWN |

## 5. Test suite state (all PROVEN by execution)

| Suite | Tests | Focus |
|---|---|---|
| `src/lib/__tests__/tenancy.test.ts` | 28 | Tenant isolation, roles, last-owner rule, workspace deletion revoking keys, audit entries |
| `src/lib/__tests__/events-v2.test.ts` | 27 | Lifecycle, idempotency, signatures, qualification trust, tenant mismatch |
| `src/lib/__tests__/global.test.ts` | 16 | IANA zones, DST day lengths, ISO country/currency, no FX conversion |
| `src/lib/__tests__/agency.test.ts` | 30 | Campaign registry, UTM normalisation, topics + provenance, retention purge |
| `src/lib/__tests__/workspace-ui.test.tsx` | 5 | Unavailable ≠ zero, suggestion ≠ observation, no qualified-by-default |
| pre-existing suites | 288 incl. 2 skipped | Money/window/pacing, consent, outbox, push E2E against a stub, Firestore index drift, UI smoke |

**Totals:** `npm run verify` → **exit 0, 392 passed / 2 skipped**. The 2 skips are
documented in the existing suites (they require a live upstream); they are not Phase 1
tests.

What these tests do **not** prove: that a real CRM sends these bytes, that Firestore
enforces anything at runtime, that the OpenAI Ads API accepts a real hint push, or that
the retention sweep deletes anything in a real database after 396 days. All three are
exercised against in-memory or stub implementations.

## 6. How to reproduce this file

```bash
npm ci                       # exit 0
npm run verify               # exit 0, 394 passed / 2 skipped
npx vitest run src/lib/__tests__/tenancy.test.ts      # 28 passed
npx vitest run src/lib/__tests__/events-v2.test.ts    # 27 passed
npx vitest run src/lib/__tests__/global.test.ts       # 16 passed
npx vitest run src/lib/__tests__/agency.test.ts       # 30 passed
npx vitest run src/lib/__tests__/workspace-ui.test.tsx # 5 passed
node -e "import('./server/config.mjs').then(m=>console.log(m.resolveConfig({}).retention))"
# { sweepEnabled: true, sweepIntervalMs: 21600000 }
```

## 7. Residual risks to carry into the next phase

1. **No real provider has ever been contacted.** Every provider path is a stub or a
   documented contract. The first real integration should be treated as unproven code.
2. **Firestore is untested against a real instance.** Subcollection layout, TTL policies
   and the composite indexes are reasoned, not observed.
3. **Retention sweep blast radius.** The sweep is global; the manual purge endpoint is
   per-organization and owner-only. A mis-set `RETENTION_SWEEP_INTERVAL_MS` shortens the
   window but cannot delete more than the policy allows; changing the policy numbers
   deletes data on the next sweep with no undo.
4. **Consent state `unknown` is common.** City-level data is withheld unless consent is
   `granted`; country-level reporting still works, but any downstream report that assumes
   city will see gaps.
5. **Timezone bucketing depends on `Intl` data.** A Node build with a stale `tzdata`
   would bucket incorrectly; the tests pin known zones but cannot detect a stale build.
