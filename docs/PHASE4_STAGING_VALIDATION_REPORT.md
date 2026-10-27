# Phase 4 — Staging Validation and Controlled-Beta Gate

**Product:** AI Ads Tracker (agency-first ad tracking, guided research, read-only HubSpot connector)
**Branch:** `arena/b0e01b66-chatgptadtrack` · **Baseline commit:** `b9de15b` · **Final commit:** `c8795e8`
**Date:** 2026-10-26 · **Role:** release owner (single agent, see §3)

**Decision: STAGING ONLY.**

Gates A and B pass with executed evidence, including a browser suite that genuinely runs in
CI and a container that is built, started, probed and shut down there. Gate C is **half
closed**: the container half is proven in CI; the persistence/recovery and provider halves
are **UNKNOWN** because this environment has no Firestore project and no HubSpot portal.
Gate D is documented but unexercised. Controlled beta therefore is not approved — the
remaining unknowns are exactly the ones a beta would expose to a client.

---

## 1. Baseline (verified, not assumed)

| Item | Value |
|---|---|
| Branch | `arena/b0e01b66-chatgptadtrack` |
| HEAD at start | `b9de15b` (Phase 3 report) — the two commits named in the brief were present |
| Working tree | clean |
| Node / npm | v22.22.3 / 10.9.8 (`.nvmrc` 22.22.0) |
| Docker in this sandbox | **absent** |
| Chromium in this sandbox | **absent** from the Playwright cache |
| Firestore / GCP project | **absent** |
| HubSpot portal / OAuth app | **absent** |

**The first thing the baseline revealed was a failing release gate.** The CI run for
`b9de15b` (run `40304143531`) failed: the `verify`, `supply-chain` and `docker-lint` jobs
passed, and **Browser end-to-end failed**. The Phase 3 report had recorded browser E2E as
UNKNOWN; in fact it had run and failed. That correction drives most of this phase.

## 2. Environment and infrastructure actually tested

| Environment | What it is | Used for |
|---|---|---|
| This sandbox (linux/x64, 2 vCPU) | Node 22.22.3, no Docker, no cloud | Gate A, security review, logging, load probes, staging harness dry run |
| This sandbox + a pinned Chromium | `@sparticuz/chromium` 141 + its AL2023 shared libraries, wired through `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Reproducing and fixing the browser failure locally |
| GitHub Actions (`ubuntu-latest`, run `40308258446`) | Real runners with Docker and Playwright's own Chromium | **Gate B**: browser suite, supply chain, and the container build/run |

The local Chromium is a *verification aid*, not a product dependency: it lives in `/tmp`,
nothing was added to `package.json`, and CI uses Playwright's own pinned browser.

## 3. Workstream ownership, and the subagent limitation

The brief asked for one subagent per workstream and an independent final review.

**No subagent tooling exists in this environment.** All six workstreams were executed by
one agent, sequentially, and **no independent review by another party took place**. That is
a real weakening of the evidence and is recorded as a finding (P2-R1) rather than papered
over. Two mitigations were applied instead:

1. **Adversarial, from-the-outside test authorship.** The security suite
   (`security-review.test.ts`) was written to attack the system (forge tenants, replay
   states, tamper signatures, split limits across instances) rather than to confirm the
   implementation's own narrative. It found a real defect (§4), which is the property that
   matters.
2. **Gates that fail on their own.** The supply-chain gate has a self-test proving it can
   fail; the staging harness exits 3 rather than 0 when it cannot run; the E2E preflight
   exits 2 when no browser exists.

An independent reviewer should still be appointed before any beta; the checklist in §10 is
the handover.

## 4. Findings

| ID | Sev | Workstream | Finding | Evidence | Status |
|---|---|---|---|---|---|
| P4-E1 | **P1** | Browser E2E | The browser gate was failing in CI and had not been reported as failing. Four of six specs failed. | CI run `40304143531`, job `121509080503`; reproduced locally | **FIXED** |
| P4-E2 | **P1** | Responsive / a11y | The Track/Research mode toggle was `hidden … sm:flex`: on a phone, research mode was unreachable and the control was absent from the accessibility tree. | `SearchBar.tsx`; the 390×844 viewport test failed with the toggle missing | **FIXED** |
| P4-E3 | P2 | a11y | The full-screen workspace overlay had no `role="dialog"`, no `aria-modal`, no Escape handler and did not move focus. | `WorkspacePanel.tsx`; new dialog test | **FIXED** |
| P4-E4 | P2 | Test infrastructure | The browser suite assumed an agency existed. Nothing created one, so the tests could not pass on a fresh install. | error-context snapshot: "You are not a member of any agency yet" | **FIXED** (`e2e/fixtures/staging.ts`) |
| P4-S1 | **P1** | Security | Outbound provider calls followed redirects. The HubSpot token request body contains `client_secret` and the refresh token, so a 3xx would re-send them to whichever host answered. | `server/connectors/hubspot.mjs`, `server/core.mjs` had no `redirect` policy | **FIXED** (`redirect: 'error'` + tests) |
| P4-S2 | P2 | Observability | No request correlation and no structured logs: an incident could not be traced across a request, and log-based alerting was impossible. | `server/handler.mjs` logged only 5xx text | **FIXED** (`server/log.mjs`, `X-Request-Id`, 5 tests) |
| P4-S3 | Observation | Security | Per-process rate limiting on `/api/track`, `/api/session` and ingest means N replicas give N× the intended limit. | `security-review.test.ts` asserts two limiters do not share a budget | **ACCEPTED** (P2, documented in `OPERATIONS.md` §3) |
| P4-P1 | **P1** | Persistence | No evidence from a real Firestore project: transactions, indexes, rules, retention, backup/restore, checkpoint recovery, database-outage behaviour. | — | **UNKNOWN** |
| P4-P2 | **P1** | Provider | No evidence from a real HubSpot portal: OAuth, scopes, refresh, pagination, throttling, webhook, revocation. | — | **UNKNOWN** |
| P4-O1 | **P1** | Operations | No metrics, tracing, pager delivery or uptime probe. Alerts are a definition, not a running system. | `OPERATIONS.md` §2/§7 | **OPEN** |
| P4-O2 | P2 | Operations | Backup/restore documented but never executed; no measured RPO/RTO. | `OPERATIONS.md` §4 | **OPEN** |
| P4-R1 | P2 | Process | No independent reviewer: every workstream was executed by one agent. | This section | **OPEN** |
| P4-D1 | P3 | Supply chain | 11 moderate advisories remain, all behind major upgrades (`firebase-admin` 14, `tailwindcss` 4). | `artifacts/vulnerabilities.json` | **ACCEPTED**, see §7 |
| P4-D2 | P3 | Container | The base image is `node:22-alpine` without a digest pin, so two builds can differ. | `Dockerfile` line 3 | **ACCEPTED** for staging; pin before production |

No P0 findings were open at the end of this phase.

## 5. Gate A — local verification: **PASS**

```
$ npm run verify
EXIT 0
  lint            ok
  format:check    ok
  tsc --noEmit    ok
  vitest run      25 files, 525 passed | 2 skipped (527)
  vite build      ok
  check-server.mjs, check-prod-guards.mjs, e2e-push.mjs   ok
  check-dockerfile.mjs                                    15/15 ok
  supply-chain.mjs self-test                              4/4 ok
```

The 2 skips are unchanged from Phase 3 and conditional on `FIRESTORE_EMULATOR_HOST`; they
are the emulator suite, and they are open evidence for P4-P1. No test was weakened,
skipped or deleted in this phase; net change is +33 tests.

## 6. Gate B — CI: **PASS**

Run `40308258446` on `c8795e8`, `completed / success`, four jobs:

| Job | Duration | Result | Key steps |
|---|---|---|---|
| Lint, typecheck, test, build, server checks | 51 s | ✓ | includes the Dockerfile static check and the supply-chain self-test |
| **Browser end-to-end (Chromium)** | 51 s | ✓ | Install Chromium ✓ → Preflight ✓ → **Playwright ✓** → artifacts uploaded ✓ |
| Licences, vulnerabilities and SBOM | 22 s | ✓ | `all --check` ✓, notices freshness diff ✓, self-test ✓, SBOM uploaded ✓ |
| **Container runs unprivileged** | 32 s | ✓ | Build image ✓ → non-root + healthcheck assertion ✓ → **container smoke ✓** (uid 1000, `/api/health` 200, `docker stop` exit 0, drain log line) |

The prior run on `b9de15b` failed. The delta between the two runs is this phase's E2E and
container work, so Gate B is closed by a controlled before/after, not by a single green run.

### Browser suite: 9/9 locally, 9/9 in CI

```
LD_LIBRARY_PATH=/tmp/al2023/lib PLAYWRIGHT_CHROMIUM_EXECUTABLE=/tmp/chromium npx playwright test
  9 passed (6.6s)
```

Covered: guided-research journey and honest empty states; saved report reopen with identical
figures; unconfigured-connector honesty; a real authorization refusal; 390×844 viewport with
no horizontal overflow; accessible names for every interactive control; keyboard-only run
(arrow keys in the radio group, Enter on the button); workspace overlay dialog semantics and
Escape; zero uncaught console errors during a run.

## 7. Workstream 6 — supply chain (re-run from the committed lockfile)

```
$ npm run supply-chain      # license | audit | notices | sbom, with --check
  license: 516 packages — 187 production, 329 dev, 195 optional
    MIT 402, Apache-2.0 57, ISC 30, BSD-3-Clause 14, BSD-2-Clause 9, MIT-0 1, 0BSD 1,
    Python-2.0 1 (argparse, dev), CC-BY-4.0 1 (caniuse-lite, dev)
    not allowlisted: 0        unknown: 0
  audit: 0 critical / 0 high / 0 low, 11 moderate
  accepted (documented): 2
EXIT 0
```

Artefacts (uploaded by CI, regenerated here): `artifacts/sbom.cdx.json` (CycloneDX 1.5,
516 components), `artifacts/license-report.json`, `artifacts/vulnerabilities.json`,
`artifacts/third-party-notices.md` → committed as `docs/THIRD_PARTY_NOTICES.md`.

**Review of every accepted moderate-or-higher advisory:**

| Chain | Why it cannot be fixed compatibly | Exposure | Decision |
|---|---|---|---|
| `firebase-admin` → `@google-cloud/firestore`, `@google-cloud/storage`, `google-gax`, `gaxios`, `retry-request`, `teeny-request`, `uuid` (7 advisories) | Fixed only in `firebase-admin` 14 (major). | Optional dependency, server-only, loaded only when `AUTH_MODE=firebase`; no user-controlled path into the affected helpers. | Accept, review by 2027-01-31, upgrade in a dedicated change with an emulator run |
| `tailwindcss` → `postcss-selector-parser`, `postcss-nested` (3 advisories) | Fixed only in `tailwindcss` 4 (major, different config format). | Build-time CSS tooling; not present in the runtime image. | Accept, review by 2027-01-31 |
| `uuid < 11.1.1` via `teeny-request` | Same Admin SDK chain. | As above. | Accept |

**Proof that the gate blocks:** `node scripts/supply-chain.mjs self-test` asserts a
critical in an unaccepted package blocks, an accepted high does not, and moderates never
block. It runs in the `verify` job and the `supply-chain` job.

Licence note: `caniuse-lite` is CC-BY-4.0 **data**, dev-only, attribution recorded in the
notices file. This is an engineering assessment, not a legal opinion; consequential licence
questions belong with counsel.

## 8. Gate C — staging: **PARTIAL**

### 8a. Container: PROVEN (CI)

Build, non-root runtime (uid 1000 checked inside the running container), `/api/health` 200,
`docker stop --time 30` returning exit code 0, and the `drained: all connections closed`
line — all in CI job `121522677066`. Locally Docker is unavailable, so the *local* claim
remains UNKNOWN and the static check (`scripts/check-dockerfile.mjs`, 15 assertions) is the
only local evidence. Secrets: the image copies only `package.json`, the lockfile and
`server/`; `.dockerignore` excludes `.env*`; a static check asserts no secret-bearing `ENV`.

### 8b. Persistence and recovery: UNKNOWN

No Firestore project and no emulator (no Java) exist here, so transactions, indexes, rules,
retention, restore, checkpoint recovery, cross-instance idempotency and database-outage
behaviour are **not tested against the real store**. What exists instead:

- Unit-level confidence: both adapters implement the same primitives; the Firestore path
  uses `runTransaction` for `consumeOnce`, leases and counters, and a fake-Firestore suite
  covers the code path. That is *not* evidence about Firestore itself.
- An executable harness: `scripts/staging-check.mjs` runs the persistent-write,
  concurrency and isolation checks against a deployed instance and **exits 3 NOT RUN** when
  staging is not configured. Dry-run here against a local server: `4 passed, 1 failed
  (storage=memory — correct), 5 not run`.
- Checklists for the manual items: `docs/STAGING.md` §3–§6.

### 8c. HubSpot sandbox: UNKNOWN

No portal, app or credentials exist. The connector is proven against a fake client for
signature, timestamp window, replay/idempotency, scope honesty, throttling/backoff, partial
sync, disconnect and lease behaviour — and the review *found and fixed* a redirect
credential-exposure bug in that path. None of that is a live integration result. Setup
checklist: `docs/STAGING.md` §4, including the sanitised evidence table to fill in.

## 9. Workstream 7 — bounded performance (measured, no capacity claim)

Method: `scripts/load-smoke.mjs`, a dependency-free closed-loop probe; one API process
(Node 22, 2 vCPU, **in-memory store**, demo mode), no reverse proxy, 10 s per profile at
concurrency 10 (write profile: 5 s at concurrency 5). Success = 2xx for reads, 201 for
writes. Percentiles are computed from every completed request; sample counts are reported
because low counts make p99 indicative only.

| Profile | Requests | Throughput | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|
| `GET /api/health` (liveness) | 60,846 | 6,080 req/s | 1.0 ms | 5.3 ms | 10.5 ms | 0 |
| `GET /api/orgs` (authenticated read) | 61,746 | 6,175 req/s | 1.0 ms | 5.5 ms | 9.8 ms | 0 |
| `GET …/research/plan` (tenant-scoped read) | 61,663 | 6,166 req/s | 1.0 ms | 5.5 ms | 9.9 ms | 0 |
| `POST …/research/runs` (write) | 30,915 | 6,183 req/s | 0.5 ms | 2.3 ms | — | 0 |
| `GET /api/does-not-exist` (error path) | 26,562 | — | 1.1 ms | 6.1 ms | — | 0 (404 as expected) |

Interpretation, deliberately narrow:

- Health-endpoint numbers are **not** application throughput; they skip auth, storage and
  rendering. They are reported separately for that reason.
- These results say the request path is not accidentally serialised and that the in-memory
  store is not the bottleneck at 2 vCPU. They say **nothing** about Firestore latency,
  multi-instance behaviour, provider calls, or sustained load. **No capacity claim is made
  and no SLO is defined.**
- Webhook and sync throughput are **UNKNOWN**: measuring them requires a provider.

Correctness under concurrency (the part that matters more than latency) is covered by tests,
not by this probe: two concurrent OAuth callbacks exchange the code exactly once; two
concurrent syncs yield one `409`; a webhook delivery limit is shared by two connector
instances.

## 10. Gate D — controlled beta: **NOT MET**

| Requirement | State |
|---|---|
| Monitoring and alerting | Defined in `OPERATIONS.md` §2; **nothing wired** (P4-O1) |
| Rollback | Documented (traffic switch, no data migrations); never exercised |
| Backup and restore | Documented (export/import); **never executed** (P4-O2) |
| Support model | Not defined (no on-call, no escalation path, no response window) |
| Data handling for beta customers | `PRIVACY.md` covers retention/roles; a beta DPA/DPIA is not drafted |
| Customer-facing limitations | Not drafted |
| Independent review | Not performed (P4-R1) |

## 11. PROVEN / CLAIMED / UNKNOWN

| Area | Status | Basis |
|---|---|---|
| Unit/type/lint/build gates | **PROVEN** | `npm run verify` exit 0, 525 passed |
| Browser E2E (local + CI) | **PROVEN** | 9/9 here; CI job ✓ on `c8795e8`; previously failing on `b9de15b` |
| Container build/run/unprivileged/drain | **PROVEN (CI)** | job `121522677066`; UNKNOWN locally (no Docker) |
| Supply chain gate + SBOM | **PROVEN** | `all --check` exit 0; self-test proves blocking; artefacts uploaded |
| Authorization, tenancy, OAuth state, webhook signature, redirect policy | **PROVEN at unit level; UNKNOWN end-to-end** | `security-review.test.ts` (27), `hubspot.test.ts`, `connector-routes.test.ts` |
| Structured logging / request correlation | **PROVEN** | 5 tests + live JSON lines; no pager wired |
| Real Firestore persistence/recovery | **UNKNOWN** | no project, no emulator |
| HubSpot live integration | **UNKNOWN** | no portal/credentials |
| Performance / load capacity | **MEASURED (bounded), capacity UNKNOWN** | §9 |
| Monitoring, backup/restore, rollback | **CLAIMED (documented), not exercised** | §10 |

## 12. Staging setup, rollback, backup — where to look

- **Staging bring-up, restart/multi-instance checks, HubSpot sandbox, datastore outage:**
  `docs/STAGING.md` §1–§5.
- **Rollback, backup/restore, incident response, limits, alerts:** `docs/OPERATIONS.md`
  §2–§6.
- **Automated staging harness:** `scripts/staging-check.mjs` (exit 0 pass / 1 fail / 3 not run).

## 13. Decision

### STAGING ONLY

- **Gate A — local verification: PASS.** 25 files / 525 tests, lint, types, build, static
  checks; no test weakened.
- **Gate B — CI: PASS.** Browser suite and supply chain execute and are required, with a
  demonstrated failure→fix transition.
- **Gate C — staging: PARTIAL.** Container proven in CI. Persistence/recovery and provider
  integration are UNKNOWN, and security-critical unknowns cannot be waived by wording.
- **Gate D — controlled beta: NOT MET.** No monitoring, no exercised backup/restore, no
  support model, no independent review.

**Approved now:** an internal staging deployment with synthetic data, a single client of our
own, and no external users.

**Required before controlled beta:**

1. Run `scripts/staging-check.mjs` green against a real Firestore staging project (exit 0,
   not 3), including the restart and datastore-outage steps.
2. Complete the HubSpot sandbox table in `docs/STAGING.md` §4 with sanitised evidence.
3. Wire at least three alerts from `OPERATIONS.md` §2 to a real destination, and perform one
   backup/restore exercise with recorded duration.
4. Commission the independent review (P4-R1) — a second party reading
   `security-review.test.ts` and the connector code.
5. Pin the base image digest and upgrade `firebase-admin` to 14 with an emulator run.
