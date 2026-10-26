# Phase 3 baseline — captured before any Phase 3 change

_2026-10-26 · established independently, not taken from the Phase 2 report_

Legend: **PROVEN** = a command ran here and exited successfully (output quoted). **CLAIMED** = a previous report says so. **UNKNOWN** = could not be established in this environment.

## 1. Repository state (PROVEN)

```
$ git rev-parse --abbrev-ref HEAD
arena/b0e01b66-chatgptadtrack

$ git log --oneline -3
ac153e5 docs: Phase 2 report (guided research + HubSpot connector), proven vs unknown
7f82dac Phase 2: guided research + read-only HubSpot CRM connector
d3875a7 docs: bring PRIVACY in line with the implemented retention, roles and per-source keys

$ git status --short
(empty)

$ node -v ; npm -v
v22.22.3 ; 10.9.8

$ which docker
docker: absent            → Docker build/run: UNKNOWN

$ ls ~/.cache/ms-playwright
(empty)                   → browser E2E: UNKNOWN (Chromium cannot be downloaded here)
```

Baseline commit for Phase 3: **`ac153e5`** (the Phase 2 feature commit is `7f82dac`; `ac153e5` adds only the Phase 2 report).

## 2. Verification suite at baseline (PROVEN)

```
$ npm run verify
EXIT 0
  Test Files  22 passed (22)
  Tests  455 passed | 2 skipped (457)
  ✓ built in 1.95s
  ok  upstream errors surface verbatim with their status
  ok  failed pushes are audited with actor, error and upstream status
```

The 2 skips are the pre-existing Firestore-emulator tests (`src/lib/__tests__/firestore.test.ts`): they require `FIRESTORE_EMULATOR_HOST` **and** `firebase-admin`, and there is no emulator (and no Java/`firebase-tools`) in this environment. They skip with a printed reason; they are not Phase 2 tests and they are not silently skipped.

## 3. Storage adapters (read, PROVEN by code inspection)

| Adapter | Where | Semantics |
|---|---|---|
| `createMemoryStore()` | `server/store.mjs` | Process-local `Map`s. Single process, no durability. Used by dev and by every test. |
| `createFirestoreStore()` | `server/store.mjs` | Org data under `adtrack_orgs/{orgId}/{collection}`; consent claim/consume already use `firestore.runTransaction`. Requires the Admin SDK (optional dependency). |

`STORAGE=memory` is refused when `NODE_ENV=production` (`server/config.mjs`), so production
is Firestore-only by configuration.

## 4. Dependencies at baseline (PROVEN)

```
$ npm audit --json | (metadata.vulnerabilities)
{ low: 2, moderate: 13, high: 4, critical: 2, total: 21 }
```

Split by exposure (detail in `docs/PHASE3_DEPENDENCY_REPORT.md`):

- **critical**: `vitest` + `tinypool` (dev/test tooling only, never shipped).
- **high**: `vite` (dev server tooling), `postcss` (build tooling), `firebase-admin` →
  `node-forge` / `@google-cloud/firestore` (optional **production** dependency).
- **moderate/low**: the remaining dev/build chain, plus `tailwindcss` → `postcss-selector-parser`
  (fixed only by a Tailwind v4 major, so it cannot be taken as a compatible patch).

Baseline lockfile: `package-lock.json`, lockfileVersion 3, 1 dependency tree.

## 5. Highest-risk findings identified before any edit

These were found by reading the code, not by trusting the Phase 2 report. Severity is my
assessment, using the Phase 3 priority definitions (P0 = exploitable correctness/security
or data corruption; P1 = blocks reliable customer use; P2 = operational improvement).

| ID | Sev | Area | Finding | Evidence |
|---|---|---|---|---|
| P3-A1 | **P0** | OAuth concurrency | `connectComplete` reads the state record, checks `usedAt`, then writes `usedAt` in a separate call. Two concurrent callbacks with the same valid state both pass the check and both exchange the authorization code. | `server/connectors/hubspot.mjs` `connectComplete` (`store.records.get` … `store.records.update`) |
| P3-B1 | **P0** | Sync concurrency | `sync` reads the source, checks `connectionStatus === 'syncing'`, then writes `syncing` in a separate call. Two concurrent syncs for one connection both proceed: duplicate provider imports, interleaved checkpoint writes, last-writer-wins status. | `server/connectors/hubspot.mjs` `sync` |
| P3-B2 | **P0** | Data corruption | A sync that finishes after a `disconnect` writes its outcome over the disconnected state, resurrecting a connection whose tokens were erased. | `sync` final `store.records.update`; `disconnect` |
| P3-C1 | **P1** | Token/scope honesty | The granted scopes fall back to the *requested* scopes (`tokens.scopes ?? HUBSPOT_SCOPES`), so a portal that granted fewer scopes is reported as if it granted all of them. Same fallback on refresh. | `connectComplete`, `accessTokenFor` |
| P3-C2 | **P1** | Status integrity | A token refresh during a sync writes `connectionStatus: 'connected'`, clobbering `syncing` (and, if it raced a disconnect, resurrecting it). | `accessTokenFor` |
| P3-C3 | **P1** | Webhook correctness | Per-record provider failures are counted as `skipped` and the delivery still answers 200, so HubSpot never retries and the record is silently lost. | `webhook` catch blocks |
| P3-C4 | **P1** | Timeouts | The OAuth token request has no timeout; a hung provider stalls the request until the platform kills it. | `exchangeToken` |
| P3-B3 | **P1** | Stale locks | A crashed sync leaves `connectionStatus: 'syncing'`; recovery depends on a 10-minute wall-clock heuristic with no renewal, so a slow sync can be double-run. | `sync` guard |
| P3-B4 | **P1** | Aggregation honesty | Research loads at most 1,000 rows per collection (the store default) and reports the totals as exact. | `server/research.mjs` `loadScoped`; `records.list` default `limit = 1000` |
| P3-E1 | **P1** | Release gate | Browser E2E is not in CI at all, so a browser failure cannot fail the release. | `.github/workflows/ci.yml` |
| P3-D1 | **P1** | Supply chain | No license/SBOM gate and no vulnerability gate in CI; 2 critical + 4 high advisories are unmanaged. | `.github/workflows/ci.yml`, `npm audit` |
| P3-F1 | **P1** | Release evidence | No load/concurrency measurement and no machine-readable release artefact. Docker build runs only in GitHub CI, never here. | — |
| P3-A2 | P2 | Hygiene | `oauthStates` is never purged (only expired by comparison), so the collection grows forever. | `server/store.mjs` `RETENTION_DAYS` |
| P3-A3 | P2 | DoS surface | The public webhook performs up to 50 provider reads per delivery with no per-source rate limit. | `webhook` |
| P3-F2 | P2 | Ops | Graceful shutdown has no drain deadline: `server.close()` waits indefinitely for in-flight sockets. | `server/server.mjs` |

## 6. What is *not* wrong (checked, so it is not re-litigated)

- Tenant resolution: every connector and research route takes the tenant from the path and
  re-proves membership through `tenancy.context`; foreign ids return `404`, identical to
  nonexistent ids (PROVEN by existing tests, re-read here).
- Webhook authentication: v3 signature over `method + full URL + raw body + timestamp`,
  compared with `timingSafeEqual`, 5-minute window, 50-event cap, tenant from path **and**
  stored source, `503` without `PUBLIC_BASE_URL` (PROVEN by tests).
- Tokens: AES-256-GCM with tenant AAD; `open()` returns `null` on tamper/wrong tenant; no
  token in any response, audit entry or log (PROVEN by tests).
- Production start-up guards: partial OAuth client, missing sealing key, non-https redirect,
  missing public origin, dev auth with live keys, memory storage in production (PROVEN by
  `check-prod-guards.mjs`).

## 7. Delegation note

This environment provides **no subagent tooling**: I cannot spawn independent agents. The
six workstreams (A–F) are therefore executed sequentially by me, against disjoint file
areas, and are labelled A–F throughout so the separation of concerns is auditable. This is
stated again in the final report; nothing here is presented as parallel independent review.
