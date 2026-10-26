# Phase 3 — Production Readiness Report

**Product:** AI Ads Tracker (agency-first ad tracking + guided research + read-only HubSpot CRM connector)
**Branch:** `arena/b0e01b66-chatgptadtrack` · **Baseline commit:** `ac153e5` · **Hardening commit:** `e00bb95` (+ `docs/PHASE3_PRODUCTION_READINESS_REPORT.md`)
**Date:** 2026-10-26 · **Role assumed:** Staff/Principal release owner
**Decision:** **BLOCKED** for production release. Suitable for **internal staging/demo only, with no client data**, until the three blocked gates below clear.

---

## 1. What this report is, and what it is not

This is a release audit of the code in this repository, carried out against a written
matrix of six workstreams. Every claim below is tagged:

- **PROVEN** — a command ran in this environment and its exit status is recorded.
- **CLAIMED** — supported by code reading and unit tests, but not exercised end to end.
- **UNKNOWN** — deliberately not measured here. Never to be read as a pass.

**Delegation limitation (stated plainly).** The brief asked for six parallel subagents.
No subagent tooling exists in this environment, so the six workstreams were emulated
**sequentially by one agent**. Two consequences are visible in the result and should be
accounted for in review: there was no independent second pair of eyes on the fixes, and
workstream isolation was maintained by convention (each change stayed within one area's
files) rather than enforced by separate workspaces.

## 2. Environment (this is the limit of the evidence)

| Item | Value |
|---|---|
| Node / npm | v22.22.3 / 10.9.8 |
| OS / CPU | linux/x64, 2 vCPU |
| Docker | **not installed** → image build, container user, healthcheck: **UNKNOWN** |
| Chromium / Playwright browser | **not downloadable here** (egress blocked) → browser E2E: **UNKNOWN** |
| Firestore emulator / project | **not available** → real-Firestore behaviour: **UNKNOWN** |
| HubSpot account, OAuth app | **none** → live connector behaviour: **UNKNOWN** |

## 3. Gates actually run (PROVEN)

| Gate | Command | Result |
|---|---|---|
| Full verification | `npm run verify` | **exit 0** — ESLint, Prettier, `tsc --noEmit`, 23 test files **492 passed / 2 skipped**, `vite build`, `check-server.mjs`, `check-prod-guards.mjs`, `e2e-push.mjs` |
| Unit + component tests | `npx vitest run` | 23 files, **492 passed**, 2 skipped (see §7) |
| Supply chain | `node scripts/supply-chain.mjs all --check` | **exit 0** — 0 critical / 0 high / 0 low, 11 moderate (all accepted, §5), 0 licences outside the allowlist |
| Licence inventory | same | 516 packages; MIT 402, Apache-2.0 57, ISC 30, BSD-3 14, BSD-2 9, MIT-0 1, 0BSD 1, Python-2.0 1 (`argparse`, dev), CC-BY-4.0 1 (`caniuse-lite`, dev, acknowledged) |
| SBOM | same | `artifacts/sbom.cdx.json`, CycloneDX 1.5, 516 components, uploaded by CI |
| Browser gate preflight | `node scripts/check-e2e-browser.mjs` | **exit 2 — BLOCKED** (Chromium absent). Correct behaviour: a missing browser fails the gate |
| Shutdown drain, live process | SIGTERM with an idle keep-alive socket open | **PROVEN** — `[api] drained: all connections closed`, process gone in **0.10 s**, exit 0 |
| Load smoke (health) | `node scripts/load-smoke.mjs --duration 5 --concurrency 8` | 27,077 req, 5,415 req/s, p50 0.9 ms, p95 4.6 ms, p99 9.9 ms, **0 failures** |
| Load smoke (authenticated read) | same, `--path /api/orgs` with a dev session | 24,706 req, 4,938 req/s, p95 4.9 ms, p99 9.9 ms, **0 failures** |

**On the load numbers.** They are a *single-process smoke probe on a 2-vCPU sandbox with
the in-memory store*, recorded in `scripts/load-smoke.mjs` (the artefact labels itself
"not a capacity or soak test"). They prove the request path is not accidentally
serialising; they prove nothing about Firestore latency, multi-instance behaviour, provider
latency, or sustained load. **No capacity claim is made.**

## 4. Findings matrix

Severity is the release impact, not the effort. "FIXED" means the change is in `e00bb95`
and a named test fails if it regresses.

| ID | Sev | Area | Evidence | Reproduction | Owner | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|---|
| P3-A1 | **P0** | OAuth concurrency | Two concurrent `connectComplete` calls both passed the `usedAt` check-then-write | Call `connectComplete` twice with one state, concurrently | Connectors | State spent with `records.consumeOnce` (atomic in both adapters) before any token exchange | `connector-concurrency.test.ts` (memory + fake-Firestore) | **FIXED** |
| P3-B1 | **P0** | Sync concurrency | Two concurrent syncs both saw `connected` and both imported | Start two `sync` calls for one connection | Connectors | 2-minute renewable lease; loser gets `409 sync_in_progress`; lease loss aborts mid-sync | `connector-concurrency.test.ts` | **FIXED** |
| P3-B2 | **P0** | Post-disconnect resurrection | A sync finishing after `disconnect` wrote its result over the disconnected record | Start sync, disconnect, let sync finish | Connectors | `releaseLease({unless})` guard evaluated atomically; takeover audited as `connector.sync_takeover` | `connector-concurrency.test.ts` | **FIXED** |
| P3-B3 | **P1** | Stale locks | A crashed sync left `syncing` with only a 10-minute heuristic | Kill a sync, wait, retry | Connectors | Lease expiry + `syncStale` + `nextAction: 'run_sync'`; renewal via `renewOrAbort` | `connector-concurrency.test.ts`, `hubspot.test.ts` | **FIXED** |
| P3-B4 | P1 | Aggregation honesty | Totals presented as exact when the read stopped at the 1,000-row store cap | Seed >1000 rows, run research | Research | `countsAreLowerBound` + `data.truncated` finding; UI renders `≥ N` | `research-server.test.ts`, `guided-research.test.tsx` | **FIXED** |
| P3-C1 | **P1** | Scope honesty | Granted scopes fell back to the *requested* scopes | Connect with a narrower grant | Connectors | Scopes only ever as reported; `scopesVerified:false` when unreported; narrower grant → `hubspot_scope_rejected` | `hubspot.test.ts` | **FIXED** |
| P3-C2 | P1 | Status integrity | Refresh during sync wrote `connectionStatus:'connected'` | Sync + token refresh together | Connectors | Refresh never writes connection status; status writes are lease-guarded | `hubspot.test.ts` | **FIXED** |
| P3-C3 | P1 | Webhook correctness | Retryable provider failure counted as `skipped`, answered 200 → record lost | Webhook during provider outage | Connectors | Retryable failures → `502 webhook_partial_failure`; permanent 404 → 200 `skipped:1` | `hubspot.test.ts` | **FIXED** |
| P3-C4 | P1 | Timeouts | Token request had no timeout | Block the token endpoint | Connectors | `AbortSignal` timeout → `504 hubspot_token_timeout` | `hubspot.test.ts` | **FIXED** |
| P3-D1 | **P1** | Supply chain | No licence/SBOM/vulnerability gate; 2 critical + 4 high advisories | `npm audit` | Platform | `scripts/supply-chain.mjs` + `security/*-allowlist.json` + CI job + artefact upload | The CI job itself; `npm run supply-chain` locally | **FIXED** |
| P3-E1 | **P1** | Release gate | No browser E2E in CI | Read `ci.yml` | QA | `e2e` job installs Chromium, runs a preflight that exits 2 when the browser is missing, then Playwright, uploading report/traces | `scripts/check-e2e-browser.mjs`; the job | **FIXED (gate exists / run UNKNOWN)** |
| P3-F1 | P1 | Release evidence | Nothing measured, no machine-readable artefact | — | Platform | `scripts/load-smoke.mjs` (dependency-free, labelled non-capacity) + recorded numbers in §3 | Script exercises itself; numbers above | **FIXED (evidence recorded, capacity UNKNOWN)** |
| P3-F2 | P2 | Ops | `server.close()` had no deadline | SIGTERM with an idle socket | Platform | Drain: `503 shutting_down` + `Connection: close`, idle sockets closed, `SHUTDOWN_TIMEOUT_MS` deadline, non-zero exit if exceeded | `transport.test.ts` (2 tests) + live measurement §3 | **FIXED** |
| P3-A2 | P2 | Retention hygiene | `oauthStates` grew forever | Inspect `RETENTION_DAYS` | Platform | `oauthStates: 1` and `rateLimits: 1` swept; test proves saved research/topics survive | `agency.test.ts` ("sweeps spent OAuth states…") | **FIXED** |
| P3-A3 | P2 | DoS surface | Public webhook did up to 50 provider reads with no limit | Loop deliveries | Connectors | `bumpCounter` per connection per minute (store-backed, so cross-instance) → `429 webhook_rate_limited` + `Retry-After` + audit | `hubspot.test.ts` (3 tests), `connector-concurrency.test.ts` (3), `transport.test.ts` (4: 2 drain, 2 Retry-After) | **FIXED** |
| P3-E2 | P2 | Accessibility coverage | No a11y assertions at all; overlays' keyboard behaviour unproven | — | QA | `e2e/accessibility.e2e.ts` (names, keyboard-only run, Escape, no console errors) + jsdom accessible-name test that runs in CI today | `guided-research.test.tsx` a11y test; e2e spec **UNKNOWN** here | **FIXED (partly UNKNOWN)** |
| P3-A4 | P3 | Client contract | A 429 could not tell a caller how long to wait; a malformed 200 body could blank the screen | Stub a 429 / a `200 {report:null}` | Client | `Retry-After` propagated from route → response; `asResearchRun` rejects malformed bodies with a named error | `transport.test.ts`, `guided-research.test.tsx` | **FIXED** |

**Open findings: none at P0/P1.** The residual risks in §6 are not "fix later" items; they
are blocks on the production claim and are tracked as gates.

## 5. Accepted residual risk (signed, dated, revisited)

| Item | Severity | Why accepted | Review by |
|---|---|---|---|
| 11 moderate advisories, all behind major upgrades (`firebase-admin` 14, `tailwindcss` 4) | moderate | Affected code is dev-build tooling (`postcss-*` via Tailwind) and an **optional** Admin SDK chain loaded only when `AUTH_MODE=firebase`; no user-controlled path into the affected helpers. `npm audit fix --force` would break the build and is forbidden by policy. | 2027-01-31 |
| `caniuse-lite` CC-BY-4.0 | low | Browser-support **data**, dev-only, not redistributed in the app bundle; attribution recorded in `docs/THIRD_PARTY_NOTICES.md`. | 2027-01-31 |

This section is an engineering assessment, **not a legal opinion**. Licence questions with
commercial consequences must go to legal review before any distribution of the built assets.

## 6. Residual risk and unknowns (do not read as passes)

1. **HubSpot has never been contacted.** The connector, OAuth state machine and webhook are
   proven against a fake provider client and a locally reproduced v3 signature. A real
   install — credentials, one consent, one sync, one delivery — is **UNKNOWN**. Exact
   remaining step: create a HubSpot OAuth app with the read scopes, set
   `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` / `HUBSPOT_REDIRECT_URI` /
   `CONNECTOR_ENCRYPTION_KEY` / `PUBLIC_BASE_URL`, connect one portal, run one sync, send
   one test webhook.
2. **The container has never been built here.** Docker is unavailable; `Dockerfile`,
   non-root user and healthcheck are asserted only by the CI job. Image = **UNKNOWN**.
3. **The browser flow has never executed.** Chromium cannot be downloaded in this
   environment; `npm run e2e:preflight` exits 2 by design. E2E = **UNKNOWN**, and the CI job
   is the only path to clearing it.
4. **Real Firestore is unproven.** The atomic primitives are tested against the in-memory
   adapter and a conservative fake-Firestore that serialises transactions. Emulator-backed
   verification is still missing; the 2 skipped tests are exactly that suite.
5. **Not penetration-tested.** Auth, tenancy and webhook paths have adversarial unit tests
   (cross-agency isolation, forged signatures, replayed states), but no external assessment.
6. **No observability or alerting.** Structured logs and audit records exist; there is no
   metric, dashboard, alert or SLO. A silent failure would be found by a customer first.
7. **No backup/restore exercise** for the production datastore, and no documented RPO/RTO.
8. **Request rate limiting for `/api/track`, `/api/session` and ingest is per process.**
   Behind N replicas the effective limit is N×. Only the HubSpot webhook limit is shared.
9. **`firebase-admin` optionality** is asserted structurally (package.json + injected import
   failure), not by uninstalling it in a real image.
10. **Retention purge is a bulk delete with no undo and no dry-run**; it is owner-only and
    audited, but a mis-set day count deletes on the next sweep.

## 7. The two skipped tests (explained, not hidden)

`src/lib/__tests__/firestore.test.ts` skips its emulator suite unless
`FIRESTORE_EMULATOR_HOST` is set:

> "Emulator suite: needs FIRESTORE_EMULATOR_HOST (none in this environment)"

They are skipped **conditionally**, not disabled, and they are the only evidence path for
real-Firestore semantics. Until a CI job runs
`firebase emulators:exec --only firestore "npm test"`, item 6.4 stays open.

## 8. Sub-ratings (0–10)

| Area | Rating | Justification |
|---|---|---|
| Security & multi-tenancy | **8** | Server-derived authorization everywhere, sealed tokens with tenant-bound AAD, atomic one-shot state, fail-closed config guards (11 negative start-up checks), cross-agency isolation tests. Held below 9 by: no pen test, per-process limiter on public routes. |
| Persistence & concurrency | **7** | Genuine atomic primitives and leases in both adapters, crash recovery, guarded writes, lower-bound honesty. Held by: real Firestore UNKNOWN, 2 emulator tests skipped. |
| HubSpot provider contract | **6** | Signature, timestamp window, size, idempotency, scope honesty, timeouts, rate limits all match the current docs and are tested against a fake. Held by: **never contacted a real portal**; token endpoint path is a documented-but-unverified choice. |
| OSS / licence / SBOM / vulnerabilities | **8** | Reproducible SBOM (CycloneDX 1.5), full inventory with zero unknowns, permissive-only policy with dated acceptances, 0 critical/high. Held by: not a legal opinion, `caniuse-lite` attribution obligation, advisories pending major upgrades. |
| Browser, accessibility, E2E | **3** | Specs exist and are honest (no fabricated progress, `≥ N` counts, disabled controls), and jsdom a11y/behaviour tests run. But the browser suite has **never executed** — that is a 3, not a 7. |
| Release engineering, CI, ops | **6** | Four CI jobs (verify, supply-chain, e2e, docker-lint), drain with a deadline, load probe, documented env. Held by: container UNKNOWN, no staging deploy, no observability/SLO/backup. |
| **Overall** | **5 / 10** | A well-instrumented staging build, not a production release. |

## 9. Decision

### BLOCKED — production release is not approved.

Three gates are **UNKNOWN**, not failed, and none of them can be closed from this
environment. A release owner cannot sign an approval on evidence that does not exist:

| Blocking gate | Unblocked by | Owner |
|---|---|---|
| Browser E2E never executed | Merge `e00bb95`; the new `e2e` CI job installs Chromium, runs the preflight, then `e2e/guided-research.e2e.ts` + `e2e/accessibility.e2e.ts` | QA |
| Container never built | The existing `docker-lint` job on a Docker-capable runner, plus a smoke start of the image | Platform |
| Provider never contacted | One real HubSpot OAuth install: consent, sync, webhook delivery (§6.1) | Integrations |

**Permitted now:** internal staging / demo use with synthetic or first-party demo data, no
client PII, single instance, no external traffic. In that mode the P0/P1 fixes in this
report are strictly an improvement on `ac153e5`.

**Not permitted:** any statement that the product is "secure", "compliant", "zero
copyright risk" or "production-ready"; any customer data; any capacity commitment.

## 10. Reproduction

```bash
npm ci
npm run verify                                     # lint, format, tsc, 492 tests, build, server checks
npm run supply-chain                               # licence + advisory + SBOM gate (exit 0 = pass)
npm run e2e:preflight                              # exit 2 = BLOCKED (no browser in this environment)
node scripts/load-smoke.mjs --duration 5 --concurrency 8 --json artifacts/load-smoke.json
node scripts/supply-chain.mjs notices && diff docs/THIRD_PARTY_NOTICES.md artifacts/third-party-notices.md
```

Sign-off requires, in order: the three §9 gates green in CI, a real HubSpot install
recorded in `docs/CONNECTORS.md`, and the emulator suite running instead of skipping.
