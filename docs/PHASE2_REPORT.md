# Phase 2 report — client-friendly research experience + first real CRM connector

_2026-10-26 · branch `arena/b0e01b66-chatgptadtrack` · commit `7f82dac` · Node 22.22.3_

Legend: **PROVEN** = a command ran here and exited successfully (output quoted). **CLAIMED** = written down but not executed. **UNKNOWN** = could not be established in this environment, with the exact next step named.

## 1. What was asked, and what was built

| Deliverable | Status |
|---|---|
| **A. Client-friendly research experience** — guided journey, honest states, no fake progress | Built, tested, live-smoked. **PROVEN** at the API and component level; browser rendering **UNKNOWN** (§5) |
| **B. First real CRM connector** — read-only, tenant-safe, provider adapter, webhook | Built, tested against a **fake provider**. Real HubSpot install **UNKNOWN** (§6) |
| **C. Playwright** — only if genuinely missing | It was genuinely missing. Config + 2 specs shipped; **no browser binary could be downloaded**, so results are **UNKNOWN** (§5) |
| **D. Search Console** | Deferred, as instructed (unchanged) |

Nothing was rewritten: the auth model, the store contract, the tenancy model, the event
contract and every existing test are intact. `npm run verify` passes with **455 passed / 2
skipped** (baseline was 394 / 2 — the 61 new tests are all additive, and the 2 skips are
pre-existing).

## 2. Baseline, captured before any edit (PROVEN)

```
git status --short                      → (empty)
HEAD                                    → d3875a7 / branch arena/b0e01b66-chatgptadtrack
node -v                                 → v22.22.3
npm run verify                          → exit 0
                                          Test Files 17 passed (17)
                                          Tests 394 passed | 2 skipped (396)
                                          ✓ built in 1.59s
which docker                            → not found   → Docker: UNKNOWN
ls ~/.cache/ms-playwright               → not found   → browser E2E: UNKNOWN
```

Prior phase reports were treated as reports, not proof: every number above was re-measured.

## 3. Deliverable A — guided research

### What a user sees

1. Pick an agency and a client workspace (both lists come from the server's membership
   view — the client never asserts a tenant).
2. Pick one goal: attribution, lead data, topics, or sources.
3. Run it. One server request builds the whole report; the page shows **elapsed seconds**
   and the server's own description of what is being read. There is no percentage, no
   step-by-step theatre, and no spinner without a timeout.
4. Read the report: window, currency, time zone, counts, findings with evidence and
   limitations, and one suggested next step per actionable finding.
5. Saved runs are reopened as immutable snapshots.

### The rule that shaped it

A finding is a statement about stored records. The report distinguishes three states per
section — `observed`, `no_data`, `unavailable` — and the UI renders the last two as
"none found" and "not measurable yet". The tests assert the literal strings, so a future
refactor cannot quietly replace them with `0`.

Not present anywhere, by construction: keyword volume, CPC, competitor spend, trend
percentages, currency conversion. The report's own limitations list says so in words.

### Server surface (PROVEN)

```
GET    /api/orgs/:org/workspaces/:ws/research/plan          data.read
POST   /api/orgs/:org/workspaces/:ws/research/runs          research.write  → 201
GET    /api/orgs/:org/workspaces/:ws/research/runs          research.read
GET    /api/orgs/:org/workspaces/:ws/research/runs/:runId   research.read
DELETE /api/orgs/:org/workspaces/:ws/research/runs/:runId   research.write
```

A body claiming its own `report` or `counts` is ignored; the server recomputes from the
store. Proven by `research-server.test.ts` ("saves a run computed on the server and
ignores client-supplied findings") and by the live smoke below, where a posted
`counts: {leads: 999}` came back as `0`.

### Live smoke against the running server (PROVEN, 2026-10-26)

```
POST /api/dev/session                     → token (52 chars)
POST /api/orgs                            → org_O7EnFFrV2vsE
POST /api/orgs/{org}/workspaces            → ws_xWQ-xFLTvRhi
GET  .../research/plan                    → 4 goals, 6 steps
POST .../research/runs {"goal":"lead_data","report":{"counts":{"leads":999}}}
                                          → 201, runId res_kbGTeRAICsDv
                                            counts.leads = 0
                                            dataStates.leads = no_data,
                                            dataStates.qualification = unavailable
                                            findings: sources.none, leads.none,
                                                      attribution.no_events, topics.none
GET  .../research/runs                     → 1 run, newest first
```

The same flow was then repeated **through the Vite proxy on 5173** to confirm the preview
path works: `plan=200 run=201 connector=200`.

## 4. Deliverable B — read-only HubSpot connector

### Design decisions worth defending

| Decision | Why |
|---|---|
| Scopes: `crm.objects.contacts.read`, `crm.objects.deals.read` only | An unused write scope is unnecessary blast radius; writing back to a customer's CRM is a product decision nobody made |
| Tokens sealed with AES-256-GCM, AAD = `org:workspace:sourceConnection` | Encryption without tenant binding lets a copied ciphertext be replayed into another tenant. Tampering or a tenant swap returns `null`, never a partial token |
| OAuth state single-use, user-bound, 10-minute TTL, spent **before** the code exchange | A replayed callback cannot re-run an exchange |
| Qualification needs `trustedForQualification` **and** a configured stage **and** an associated contact | The provider's vocabulary (`closedwon`) is not a product decision |
| Deterministic event ids (`hs.contact.{id}`, `hs.deal.{id}.{stage}`) | Makes re-import idempotent at the database, not in application memory |
| Bounded pagination → `degraded` / `partial` + resumable checkpoint | A truncated import must never look like a complete one |
| Failure keeps the previous `lastSyncAt` | "Last success" and "last attempt" are different facts |
| SDK retries disabled (`numberOfApiCallRetries: 0`) | Two retry policies stacked multiply into an unbounded wait |
| Webhook refuses (`503`) without `PUBLIC_BASE_URL` | The v3 signature covers the exact URL called; guessing it verifies nothing |
| `/oauth/2026-09/token` as default, overridable | `/oauth/v1/token` sunsets 2027-02-16; migrating later is work for no benefit |

The webhook is the only public connector route. Its guard list — signature, 5-minute
window, raw-body verification, 50-event cap, tenant from path **and** stored source,
per-record re-read, idempotent delivery — is documented in `docs/SECURITY.md` §7a and
tested in `hubspot.test.ts` and `connector-routes.test.ts`.

### Proven by execution

| Behaviour | Test |
|---|---|
| Seal/open round-trip; tamper, wrong key and wrong tenant all rejected | `hubspot.test.ts` |
| No token, client secret or credential material in a source record, status response or audit entry | `hubspot.test.ts` |
| OAuth: read-only scopes, single-use state, cross-tenant state, expired state, reused state, token-exchange rejection → `failed` + `reconnect` | `hubspot.test.ts` |
| Contact → `lead_created` with provenance-only metadata, `consent_state: 'unknown'`, never qualified | `hubspot.test.ts` |
| Deal → `lead_qualified` only when trusted + configured stage + contact association | `hubspot.test.ts` |
| **1,000-record import run twice** → first run 1,000 imported / 0 duplicates, second run 0 imported / 1,000 duplicates, 1,000 leads, 1,000 events, unique event ids | `hubspot.test.ts` |
| Missing provider timestamp → skipped as `missing_timestamp`, never dated "now" | `hubspot.test.ts` |
| 429 then success; 429 beyond the attempt budget → `failed`, ≤3 provider calls | `hubspot.test.ts` |
| Partial pagination (2-page cap over 300 records) → `degraded`, `partial`, `sync_incomplete`, checkpoint `after: '2'` | `hubspot.test.ts` |
| 401 → `failed` + `reconnect`; disconnected connection refuses sync and webhooks | `hubspot.test.ts` |
| Webhook: valid signature imports once and dedupes a replay; bad signature, stale timestamp, missing header, >50 events and a disconnected connection all refused | `hubspot.test.ts` |
| HTTP layer: tenant routes need a bearer token, the webhook does **not**, another organization gets `404`, unconfigured server gets `503` naming the variables | `connector-routes.test.ts` |
| Startup refuses a partial OAuth client, a client without a sealing key, a non-https redirect and a production webhook with no public origin | `connector-config.test.ts` (9) + `scripts/check-prod-guards.mjs` (2 new cases) |

### Not proven — stated plainly

- **No HubSpot app or account exists here.** No OAuth redirect ever left this machine, no
  real contact or deal was read, and no webhook delivery arrived from HubSpot. The
  provider is a fake that returns synthetic fixtures; that proves *our* code, not
  HubSpot's contract.
- Remaining step to close it: create a HubSpot app with redirect URL
  `HUBSPOT_REDIRECT_URI`, set `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`,
  `HUBSPOT_REDIRECT_URI`, `CONNECTOR_ENCRYPTION_KEY` (`openssl rand -base64 32`) and
  `PUBLIC_BASE_URL`; complete one connect; run one sync; confirm one delivery at
  `POST /api/connectors/hubspot/webhook/:org/:sourceConnectionId`.
- The connector is therefore **not** production-ready, and no mock is described as one.

## 5. Deliverable C — browser tests

`@playwright/test` was installed (Apache-2.0) and a config plus two specs were written
(`e2e/guided-research.e2e.ts`). They are deliberately **not** part of `npm run verify`:
verify must pass on a machine with no browser.

Attempted and failed, verbatim:

```
npx playwright install chromium
  Error: Failed to download Chrome for Testing 156.0.8078.4 (playwright chromium v1248),
  caused by Error: Download failure, code=1

npx playwright test
  Error: browserType.launch: Executable doesn't exist at
  /home/user/.cache/ms-playwright/chromium_headless_shell-1248/.../chrome-headless-shell
  2 failed
```

So: the specs exist, the harness starts both servers, and **no browser-level result is
claimed**. The same assertions are covered at the component level by
`guided-research.test.tsx` (jsdom + stubbed `fetch`), which is a weaker proof and is
labelled as such.

## 6. Honest accounting of new dependencies

| Package | Why | Licence | Compatibility | Risk |
|---|---|---|---|---|
| `@tanstack/react-query@^5.104.5` (dependency) | Query cache keyed by org + workspace, mutation states; avoids hand-rolled fetch state | MIT | React 18.3 peer, Vite 6, TS 5.7 — builds and typechecks | Actively maintained; ~13 kB gzipped; no transitive surprises in the audit graph |
| `@hubspot/api-client@^14.0.1` (**optionalDependencies**) | Official client; typed `getPage`/`getById`, lazily imported only when an OAuth app exists | ISC | Node 22; loaded via dynamic `import()` so a deployment without HubSpot never loads it | Provider SDK churn; mitigated by a thin adapter (`hubspot-sdk.mjs`) and SDK retries disabled |
| `@playwright/test@^1.64.1` (devDependency) | Browser-level proof, when a browser is available | Apache-2.0 | Node 22; browser binary absent here | Dev-only; not in the production bundle |

`npm audit` after the installs: **21 advisories (2 low, 13 moderate, 4 high, 2 critical)** —
all pre-existing (eslint, firebase-admin, postcss, tailwindcss, vite, vitest chains). None
of the three new packages appears in the vulnerability graph, and no `--force` fix was
applied (it would break Vite/vitest majors).

## 7. Verification gate (PROVEN, after all changes)

```
npm run verify  → exit 0
  lint                     ok
  format:check             ok
  tsc --noEmit             ok
  vitest run               Test Files 22 passed (22)
                           Tests 455 passed | 2 skipped (457)
  vite build               ✓ built in 1.92s
  check-server.mjs         ok
  check-prod-guards.mjs    ok (incl. 2 new connector refusals)
  e2e-push.mjs             ok
```

Per-file evidence for the new suites:

```
npx vitest run src/lib/__tests__/hubspot.test.ts            → 25 passed
npx vitest run src/lib/__tests__/research-server.test.ts    → 13 passed
npx vitest run src/lib/__tests__/connector-routes.test.ts   →  9 passed
npx vitest run src/lib/__tests__/connector-config.test.ts   →  9 passed
npx vitest run src/lib/__tests__/guided-research.test.tsx   →  5 passed
```

## 8. Security review of the new surface

| Question | Answer |
|---|---|
| Can a caller choose its tenant? | No. Tenant comes from the path **and** is re-proved by `tenancy.context`; `404` for a foreign org (not `403`, which would confirm existence) |
| Can a caller assert findings? | No. The report is computed server-side; extra body fields are ignored (tested) |
| Can a token leak to the browser? | No. Tokens exist only as sealed ciphertext in the store; status responses carry scopes and portal id only |
| Can a token leak to logs? | `redactError()` strips `access_token=`, `refresh_token=` and `Bearer …`; audits store codes, not payloads |
| Can a webhook be forged or replayed? | Only a valid v3 signature inside a 5-minute window is accepted, and a replay becomes a duplicate |
| Can a read-only role write? | No. `research.write` / `source.manage` are checked server-side; the UI disables the control **and** explains why |
| Does anything fail open? | No. Missing connector config → `503` with the variable names; missing `PUBLIC_BASE_URL` → `503`; bad encryption key or partial OAuth client → startup refusal |

## 9. Documentation touched (no duplicates created)

`docs/CONNECTORS.md` (§7 with a PROVEN/UNKNOWN table), `docs/API.md` (route index +
sync-response shape), `docs/SECURITY.md` (§7a connector credentials + webhook guards, and
four new rows in §8), `docs/DATA_MODEL.md` (`sources` OAuth fields, `researchRuns`),
`docs/PRIVACY.md` (§7 what a CRM import does and does not bring in), `docs/DECISIONS.md`
(10 new dated decisions), `docs/FEATURES.md` (status legend + Phase-2 table),
`docs/BASELINE_AND_GAPS.md` (G15 partly closed, new suites, new totals), `README.md`
(guided research, connector setup, `npm run e2e`), `.env.example`, `firestore.rules`
(collection note), `docs/PHASE2_REPORT.md` (this file).

## 10. Residual risks and what to do next

1. **HubSpot is not live-verified.** Highest-value next step, exact steps in §4.
2. **No browser-level evidence.** Run `npx playwright install chromium && npm run e2e` on a
   machine with CDN access; treat the current UI evidence as component-level only.
3. **Retention on `researchRuns` is "keep".** Deliberate — a saved report is evidence — but
   an operator may want a per-agency retention decision.
4. **No load or concurrency test was run.** Nothing about throughput is claimed; the sync
   is single-flight per source (`syncing` state) but that is a code property, not a
   measured one.
5. **Docker still UNKNOWN.** No `docker` binary here; the Dockerfile's first real check is CI.
6. **Search Console remains deferred**, as instructed.
