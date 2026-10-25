# AdTrack — Repository Review & Build Plan

_Date: 2026-10-24 · Branch: `arena/b0e01b66-chatgptadtrack` · Baseline commit: `a984a6f`_

This document does two things:

1. **Review** what the repository actually contains today (docs-only, 7 files, no code).
2. **Plan** the build of **ChatGPT Ad Track + keyword research**, with the keyword-research module designed around what ChatGPT Ads can actually do in 2026 — not around a Google Ads mental model.

---

## 1. What the repository is today

```
.env.example        4 lines, 4 empty vars
.gitignore          node_modules, dist, .env, keys, firebase artifacts
README.md           "Slice 1: Home page and shell (in progress)"
docs/DECISIONS.md   5 decisions, all dated 2026-09-30
docs/METRICS.md     metric dictionary with 3 TODOs
docs/PRIVACY.md     privacy notes with 3 TODOs
docs/TRACKING_PLAN.md  4 events, 4 rules
```

**Verdict:** a well-intentioned **specification skeleton**, not an application. There is no `package.json`, no app, no functions, no Firestore rules, no schema, no tests, no CI. The README's "Slice 1 in progress" is inaccurate — Slice 1 has not been started.

That is not a problem *if* we fix it now: the docs are short enough to correct in one pass, and the product decisions in `DECISIONS.md` are still sound.

### 1.1 What is genuinely good

| Strength | Why it matters |
|---|---|
| Separating **native (OpenAI-reported)** from **internal attribution** | This is the #1 mistake advertisers make on ChatGPT Ads. Keep it as a hard product rule. |
| `oppref` / `obref` already named in the tracking plan | Shows the author read the right docs; both are real and current. |
| Consent gate stated as a rule ("no event when consent denied") | Correct and required; the Pixel has explicit consent controls. |
| Geography aggregated to country/region/city, no individual location | Matches DPDP/GDPR expectations and what is actually reported. |
| One map + metric switcher | Right call. Nine maps is a demo, not a tool. |
| Single-tenant v1, Firestore first | Correct scope control for a first release. |

### 1.2 Gaps and errors found in the review

| # | Finding | Severity | Fix |
|---|---|---|---|
| G1 | README status is false (no app exists) | Medium | Correct the status line; point to this plan. |
| G2 | **Keyword research does not exist anywhere** in the repo — not as a doc, not as a decision, not as a data model. This is the feature the user now wants, and it is the largest missing piece. | **High** | Section 3 of this plan designs it end-to-end. |
| G3 | `.env.example` has no OpenAI Ads variables (Pixel ID, Advertiser API key, Conversions API key), no org/region config, no research-service keys | High | Rewrite `.env.example` with a server/browser split and comments. |
| G4 | `TRACKING_PLAN.md` omits **minor-unit money** (paise/cents as integers). "amount" is ambiguous and will silently break revenue by 100×. | **High** | Add explicit rule: all amounts are integer minor units + ISO-4217 currency. |
| G5 | Dedupe rule says "same event_id" but not the full key. OpenAI dedupes on **Pixel ID + event name + event id**, first event wins. | High | Restate exactly. |
| G6 | No attribution-window decision. Docs say "30-day, configurable" but OpenAI reports click windows of **7 / 14 / 30** and a view-through window of **0 or 1 day**. Internal and native numbers are only comparable if the windows are aligned. | High | Decision: internal click 30d + view-through 1d, matching the native default; make it org configurable and always display both. |
| G7 | No statement that **CAPI must never be called from the browser**, and no server-only enforcement | High (security) | Architecture rule + functions-only credential. |
| G8 | `METRICS.md` lacks CTR, CPC, CPM, impressions, clicks, conversion rate, lead→customer rate, and view-through. CPL/CAC/ROAS can't be reconciled without them. | Medium | Extend the dictionary (section 6). |
| G9 | `METRICS.md` "Qualified lead criteria: TODO" blocks CPL-vs-CPL-by-quality reporting | Medium | Ship a default rule (2+ fields + human status) and make it editable. |
| G10 | Currency/INR assumption was untested. **Now verified:** India is a supported self-serve market and INR accounts have a **₹725/day minimum** (USD $25). | Info | Record in DECISIONS; budget modelling must respect the floor. |
| G11 | Privacy: retention TODO, DPDP/GDPR checklist absent, no consent-record schema, no data map, no deletion/export path design | **High** (blocker for launch) | Slice 7 + schema in section 4. |
| G12 | No Firestore security model, no role model (owner/analyst/viewer), no org scoping, no PII collection lock | High | Define before writing any function. |
| G13 | No error/observability story for event delivery (retries, dead-letter, event-level status) and no way to see "was this conversion received?" | Medium | Add a debug/health view in Slice 2. |
| G14 | No testing strategy, no CI, no lint/format/type config | Medium | Slice 0. |
| G15 | No data-freshness handling. OpenAI delivery metrics and conversion metrics settle over time, so "today" is provisional. | Medium | Show "preliminary" state for last 2–3 days; store `syncedAt`. |
| G16 | No cost model. Embeddings + insights polling + Firestore reads all cost money. | Low | Budget section 4.5. |

---

## 2. Product scope (what we are building)

**One-line:** ask a plain-language question about ChatGPT ad performance and get one answer — `ad → visit → lead → customer → revenue → location` — plus a keyword-research workspace that turns intent into context hints and closed-loop evidence.

Two engines, one app:

| Engine | Question it answers | Primary data |
|---|---|---|
| **Ad Track** | "Did the ads work, where, and for whom?" | OpenAI Insights API + first-party events (pixel + CAPI) + CRM/orders |
| **Keyword Research** | "What should we tell ChatGPT we are relevant to, and which hint sets actually earn money?" | Seeds, clusters, hint sets, ad-group insights, conversion outcomes |

They share the campaign/ad-group hierarchy as the join key, which is what makes the research loop real rather than a keyword spreadsheet.

### 2.1 Hard boundaries (set now, avoid a rewrite later)

- **Single tenant.** One organization per deployment in v1. Multi-tenancy is a v2 migration, not a config flag.
- **Server owns all secrets.** `OPENAI_ADS_API_KEY` and `OPENAI_CONVERSIONS_API_KEY` live only in Cloud Function secrets. Browser only ever gets the Pixel ID (that is public by design).
- **Two numbers, never one.** Native-reported and internally-attributed performance are separate columns. No blended "true ROAS" hero metric.
- **No individual geolocation.** Country / region / city only; no lat-long, no IP storage beyond the event.
- **Research is context hints, not keyword bids.** See 3.1 — this is the most important conceptual correction in the plan.

---

## 3. Keyword research for ChatGPT Ads — the part that needs rethinking

### 3.1 Reality check (verified against current OpenAI docs, Oct 2026)

| Assumption from Google Ads | What ChatGPT Ads actually provides |
|---|---|
| Keyword targeting with match types | **No keyword box.** Relevance comes from the live conversation + your creative + landing page + **context hints** |
| Negatives / excluded keywords | **No negatives.** Hints are a relevance signal, explicitly *not* exclusions |
| Search-terms report | **No search-terms report.** You cannot see which conversations triggered you |
| Keyword Planner volumes | **No keyword planner, no volume estimates, no autocomplete** |
| Hints are exact-match strings | Hints are **free-form descriptions** and do not guarantee delivery |
| Hints per ad group | Up to **2,000** hints per ad group; OpenAI says you need not fill the limit |

**Therefore:** "keyword research" here means **intent research → conversation-shaped hint sets → ad-group experiments → measured evidence**. Anyone who pastes a keyword list into the hints field is misusing the tool.

Design consequence: because there is no term-level reporting, our unit of research and of measurement is the **ad group**, and our differentiator is that we are the only place that can attach *lead and revenue* outcomes to a hint set.

### 3.2 The research pipeline

```
 SEEDS                NORMALIZE            CLUSTER                SCORE
 search logs   ┐      dedupe               embed + group          relevance
 GSC queries   ├──▶   language/locale  ──▶ intent buckets     ──▶ commercial value
 sales notes   │      PII scrub            funnel stage           competition proxy
 ad-group data ┘      brand filter         persona/situation      coverage & risk
                                                                       │
                                                        ┌──────────────┘
                                                        ▼
                              GENERATE      validate (claims/brand/PII)  ──▶  APPROVE
                              conversation-shaped hints                     │
                                                                            ▼
                        ┌──────────── EXPORT / PUSH (create or update ad group) ────────────┐
                        │                                                                    │
                        ▼                                                                    │
                 MEASURE at ad-group level (insights + conversions + CRM outcomes) ──▶ ITERATE
```

### 3.3 Seed sources (ranked by value per effort)

1. **On-site search and chat logs** — the single best source; raw intent in the customer's words.
2. **Google Search Console queries** — a bridge to pre-ChatGPT demand; free, high volume.
3. **Sales-call notes / support tickets** — surface the phrasing of objections and buying triggers.
4. **Existing ad-group insights** — which hint themes already have delivery.
5. **Landing-page and product-catalogue text** — for coverage gaps and for the hint↔landing-page consistency the auction rewards.
6. **Optional external keyword APIs** (paid) — only if volume estimates are worth the spend; note these are Google-shaped, so treat volumes as a popularity proxy, not as ChatGPT demand.
7. **Manual entry / CSV upload** — always supported.

### 3.4 Clustering and tagging

Every seed gets: `intent` (informational / comparison / transactional / navigational / problem-diagnosis), `funnel_stage`, `locale`, `persona`, `topic_cluster`, and `risk_flags` (regulated claim, competitor name, ambiguous meaning).

Clustering: embeddings + threshold + human merge/split. Aim for **3–6 themes per campaign** and **one ad group per theme** — more ad groups than that and you cannot accumulate enough data per group to learn anything, given the absence of term reports.

### 3.5 Hint generation (the actual craft)

Rules encoded as validators, not prose:

- Write the **situation**, not the label: "someone comparing two CRM options for a 6-person sales team" beats "crm software".
- One hint = one coherent need. 8–25 words. Keyword may appear *inside* the sentence as an anchor.
- Never invent product capability, price, or claims; never include competitor trademarks as if endorsed; never include PII.
- Include the *problem* phrasing even when it contains none of your keywords — that is where semantic matching wins.
- Every hint set must map to **one landing page + one ad creative** consistently.
- Cap per set: start at 25–60 hints. There is no delivery benefit to 2,000 hints; it only makes the set unlearnable.

### 3.6 Scoring model (transparent, weight-tunable)

```
Score = 0.30·Relevance + 0.25·Intent + 0.25·Value + 0.10·Coverage + 0.10·(1 − Risk)
```

| Component | Definition | Source |
|---|---|---|
| Relevance | cosine(seed cluster, offer/landing text) | embeddings |
| Intent | hand-weighted by intent class, transactional high | tagging |
| Value | expected ₹ per ad group = leads × lead→customer × avg order value | **first-party**, from our own data |
| Coverage | does it open a theme no current ad group covers | hint-set inventory |
| Risk | brand/claims/ambiguity penalty | validators |

Store raw inputs *and* the weights version, so a score can always be recomputed and defended. Never show a composite score without its parts.

### 3.7 Experiments (how research becomes evidence)

Because you cannot test individual terms, test **hint sets as whole ad groups**:

- Control = current hint set (frozen copy). Variant = new set, same creative/landing page/geo/bid.
- Run 14 days or ≥ 100 clicks per arm, whichever is later; pre-register the primary metric (CPL or lead→customer — choose before launch).
- Report the **decision**, not just the delta: keep / kill / iterate, with the reason stored.
- Confounders to display honestly: seasonal drift, shared campaign budget, and the fact that ChatGPT Ads optimises per campaign.

### 3.8 Keyword research deliverables (UI)

- **Seed inbox** (paste, CSV, or connector) with dedupe status
- **Cluster board** (drag seeds between themes)
- **Hint editor** with live validators and a "why this hint" note
- **Score table** with editable weights
- **Export**: CSV/JSON for Ads Manager, and one-click **push to ad group** via the Ads API (`context_hints`)
- **Performance tab**: hint set → impressions, clicks, CTR, CPC, spend, leads, CPL, customers, CAC, sales, ROAS
- **Version history** so a hint change is attributable to a date

---

## 4. Architecture

### 4.1 Stack (confirming the existing decision, with specifics)

| Layer | Choice | Note |
|---|---|---|
| Web | React 18 + Vite + TypeScript + Tailwind | Google AI Studio scaffold is fine as a starting point, but pin versions and own the code |
| State/data | TanStack Query + Firestore listeners | Avoid Redux |
| Auth | Firebase Auth (email + Google) | Org role claim in custom claims |
| DB | Firestore (v1) | Postgres migration path documented, not built |
| Server | Cloud Functions (Node 20, TS), region `asia-south1` | All third-party keys here |
| Scheduler | Cloud Scheduler → `syncInsights` hourly + nightly backfill | Respect API rate limits |
| Charts/Map | Recharts + a vector map (no per-point tracking) | Metric switcher on one map |
| CI | GitHub Actions: typecheck, lint, unit tests, rules tests, preview deploy | |

### 4.2 Request flows

```
Browser                          Cloud Functions                    Third party
───────                          ───────────────                    ───────────
consent granted?
   │ yes
   ▼
Measurement Pixel (public pixel_id) ──────────────────────────────▶ bzr.openai.com
   │ separate: page_viewed, lead_created (browser copy)
   │
   ▼
POST /track  (no API key, event_id + session_id + consent token)
   │
   ├─ write events/{eventId}  (idempotent, first write wins)
   ├─ lead/order domain records
   └─ enqueue outbox ──▶ CAPI send (server key, same event_id) ──▶ bzr.openai.com

Scheduler ──▶ syncInsights ──▶ Insights API ──▶ reports_daily / hint_performance
Browser  ──▶ /research/*  ──▶ embeddings + scoring (server key)
Browser  ──▶ /push/adGroup ──▶ Ad Groups API (update context_hints, keep a version)
```

`/track` must be **idempotent on `event_id`**, must reject events without a consent token, and must tolerate CAPI failure (retry with backoff, dead-letter collection, surfaced in a health view).

### 4.3 Firestore model (v1)

```
organizations/{orgId}
  settings { currency, timezone, attributionWindowDays, viewThroughDays, weightsVersion }
  users/{uid} { role: owner|analyst|viewer }

adaccounts/{accountId}  { currency, timezone, status }
campaigns/{campaignId}  { name, objective, status, budgetMicros, syncedAt }
adgroups/{adGroupId}    { campaignId, name, contextHints[], status, bidMicros, syncedAt }

-- keyword research
seeds/{seedId}          { text, source, locale, intent, clusterId, riskFlags[], createdAt }
clusters/{clusterId}    { name, theme, intent, seedIds[], persona, status }
hintsets/{hintSetId}    { clusterId, hints[], version, status, adGroupId?, creativeRef, landingUrl }
scores/{scoreId}        { clusterId, hintsVersion, relevance, intent, value, coverage, risk, weights }
experiments/{expId}     { name, variants[], primaryMetric, startDate, endDate, decision, reason }

-- tracking
events/{eventId}        { name, sessionId, oppref?, obref?, consentId, ts, sourceUrl, user{...} }
sessions/{sessionId}    { utm*, oppref, obref, geo{country,region,city}, device, landedAt }
leads/{leadId}          { sessionId, contactHash, status, qualifiedAt, source }
orders/{orderId}        { leadId, amountMinor, currency, refunded, createdAt }
consents/{consentId}    { granted, scopes[], version, ts, ipCountry }   // audit trail

reports_daily/{date_entity}    { impressions, clicks, spendMinor, ctr, cpc, conversions, ... , syncedAt }
hint_performance/{setId_date}  { same metrics + leads, customers, salesMinor, roas }
sync_runs/{runId}              { job, status, records, errors, startedAt, finishedAt }
outbox/{eventId}               { status, attempts, lastError, nextAttemptAt }
```

Rules: deny-all default; org-scoped reads; writes only via callable functions for `events`, `orders`, `scores`, `hintsets`; PII fields (`contactHash` is a hash only) never world-readable; no client write to `reports_*`.

Money: **all amounts stored as integer minor units** (`amountMinor`, `spendMinor`), currency alongside. Format only in the UI.

### 4.4 API surface (callable/HTTP functions)

| Function | Purpose |
|---|---|
| `POST /track` | server-side event intake, consent-gated, idempotent |
| `POST /research/seeds` | ingest + normalize + PII scrub |
| `POST /research/cluster` | embed + cluster, returns clusters |
| `POST /research/hints` | generate + validate hint candidates |
| `POST /research/score` | recompute scores at chosen weights version |
| `POST /research/push` | create/update ad group `context_hints`, keep version |
| `GET /reports/funnel` | ad → visit → lead → customer → revenue, by geo/date/campaign |
| `POST /sync/insights` | scheduler-triggered ingest |
| `GET /health/events` | delivery health: received, deduped, failed, retried |

### 4.5 Cost sketch (monthly, small single-tenant)

- Cloud Functions + Scheduler: a few dollars at low volume
- Firestore: reads dominate; cache reports in `reports_daily`, target < $10
- Embeddings for 5k seeds: single-digit dollars, one-off with cache
- Ads API calls: free, but rate-limited — batch and back off
- Budget floor reminder: a test campaign costs **₹725/day** in India, so "just run a test" is a real cost, not free.

---

## 5. Slice plan

Each slice ships something usable. Effort is a solo-dev estimate, part-time.

### Slice 0 — Truth & foundation (0.5 day)
Correct README status; rewrite `.env.example`; add `DECISIONS` entries; add `package.json`, TS, ESLint/Prettier, Vitest, folder skeleton; CI typecheck+lint+test.
**Accept:** `npm ci && npm run typecheck && npm test` green on a fresh clone; no secret in repo; `.env.example` documents every variable.

### Slice 1 — App shell, auth, org (2–3 days)
Vite+React+Tailwind shell, routing, sidebar (Track / Research / Reports / Settings), Firebase Auth, org doc + roles, protected routes, empty states.
**Accept:** sign-in works, role gating enforced client *and* rules, nav matches plan, no dead links.

### Slice 2 — Tracking foundation (4–5 days)
Consent banner + gate; Pixel wrapper with consent controls; `/track` intake; outbox + retry + dead-letter; `oppref`/`obref` capture; `lead_created` and `order_created` with shared `event_id`; event health view.
**Accept:** deny consent ⇒ zero network calls to `bzr.openai.com` and zero cookies; a lead produces exactly one conversion when both Pixel and CAPI fire (verified by matching `event_id`); a forced CAPI 500 retries then lands in dead-letter and shows in health.

### Slice 3 — Reporting ingest + funnel dashboard (5–6 days)
`syncInsights` + backfill; `reports_daily`; funnel view with native vs internal columns; date range, campaign filter, one map + metric switcher; preliminary-data state for the last 3 days.
**Accept:** numbers reconcile to Ads Manager within a documented tolerance for the same window/timezone; window defaults 30d click / 1d view; every tile shows its source.

### Slice 4 — Keyword research v1 (6–8 days)
Seed inbox (paste/CSV), normalize + PII scrub, embedding cluster, tag editor, scoring with visible components, hint generator + validators, hint set versioning, CSV export.
**Accept:** 500 seeds → clusters in < 60s; every hint has a rationale; validator blocks competitor-claim and PII cases; scores reproducible from stored inputs + weights version.

### Slice 5 — Push to ads + experiments (4–5 days)
`context_hints` push to ad group (create/update), version diff, experiment records, hint-set performance joins, decision log.
**Accept:** a pushed hint set appears on the ad group via GET; rollback restores the previous version; experiment report shows both arms with sample-size caveat.

### Slice 6 — Attribution, revenue, quality (5–6 days)
Qualified-lead workflow; lead→customer; order/refund handling; CAC/ROAS/payback; cohort and geo views; "why did this change" annotations.
**Accept:** CPL, CAC, ROAS reproducible from stored events; refunds reverse revenue correctly; lead status changes are audited.

### Slice 7 — Compliance & launch hardening (4–5 days)
Retention jobs, deletion/export flow, consent audit, DPA/subprocessor list, DPDP+GdPR checklist, privacy page, rate limits, backups, alerting, runbook.
**Accept:** deleting a contact removes/zeroes its PII and is evidenced; retention job dry-run report; legal checklist signed off.

**Total:** ~5–6 focused weeks. Critical path: 0 → 1 → 2 → 3 → 4. Slice 5 depends on 4; 6 depends on 2+3.

---

## 6. Doc corrections to make now

1. **README:** status → "Pre-code: specification reviewed, plan at `docs/PLAN.md`."
2. **TRACKING_PLAN:** add minor-unit rule, full dedupe key (`pixel_id + event_name + event_id`, first wins), cookie facts (`__oppref` 30d, `__obref` 365d), CAPI server-only rule, and note that `page_viewed` is low-value — measure `lead_created` / `order_created` instead.
3. **METRICS:** add impressions, clicks, CTR, CPC, CPM, conversion rate, lead→customer rate, view-through conversions, payback; define "preliminary" for the newest 48–72h; state INR minor unit = paise.
4. **PRIVACY:** add consent scopes, retention defaults (raw events 13 months, aggregates 25 months), deletion SLA, data map, subprocessors, DPDP purpose-limitation note.
5. **DECISIONS:** record (a) keyword research = context-hint research, (b) hints capped per set by quality not by the 2,000 limit, (c) internal attribution windows mirror native defaults, (d) India/INR supported, ₹725/day floor accepted, (e) all money in minor units.

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Team expects Google-style keyword volumes | Product built on a false premise | This plan; in-app explanation of what hints are and are not |
| No search-terms report ⇒ research can't be proven per term | Research looks unmeasurable | Measure at ad-group level; make first-party revenue the differentiator |
| Dual Pixel+CAPI double counting | Inflated conversions | One `event_id` generator shared by both paths + dedupe test in CI |
| Minor-unit vs major-unit bug | 100× revenue error | Integer minor units in schema + format-only-in-UI rule + property test |
| Consent leak (pixel fires before consent) | Legal exposure | Gate at the wrapper, test it, and never initialise the SDK before consent |
| Rate limits / settling metrics | Stale or wrong dashboards | Backoff, `syncedAt`, preliminary badges |
| Long-lived native SDK changes (docs moved in July 2026 already) | Silent breakage | Re-verify against docs each slice; health checks on event delivery |
| Scope creep into multi-tenant / Postgres | Delays v1 | Decisions already lock single-tenant + Firestore |

---

## 8. Open questions to answer before Slice 1

1. **Who is the first user and what is the first offer?** Keyword research without a real offer produces pretty clusters and no signal.
2. Does the business already have a ChatGPT Ads account (currency, country) and API keys, or do we need a sandbox/mock mode first?
3. Where do leads/customers actually live today (own form, CRM, Sheets, WhatsApp)? That determines Slice 2/6 effort more than anything else.
4. Is Google Search Console access available as a seed source?
5. Is ₹725/day budget available for a 14-day hint-set experiment (≈ ₹10k), or is measurement read-only for v1?
6. Legal review available for DPDP/GDPR before launch, or do we ship with conservative defaults and no PII matching?

---

## 8a. Progress against this plan

| Slice | State | What actually exists |
|---|---|---|
| 0 Foundation | **done** | Vite + React + TS strict + Tailwind; ESLint, Prettier, engines, CI on every push; `npm run verify` |
| 1 Shell + auth | **partial** | Single-page shell ships. Server-side auth gate with roles (dev + Firebase verifiers). **No browser sign-in**, no Firestore, so `analyst`/`viewer` exist only in the API. |
| 2 Tracking foundation | **partial** | `POST /api/track` with server-verifiable consent ids, origin allowlist, per-IP rate limit, body cap, dedupe-safe event ids, retry/backoff. **Missing:** the Pixel SDK in the browser, an outbox/dead-letter, and event-level health. |
| 3 Reporting ingest | **partial** | `/api/dataset` pulls insights (country + device segments, daily), maps to integer minor units, caches 5 minutes, flags missing first-party data. **Verified only against a stub**, never a live account. |
| 4 Keyword research | **done (v1)** | Seeds → scrub → intent → cluster with granularity → weighted score → hint validators → CSV. |
| 5 Push + experiments | **partial** | Push with diff, confirm, Undo, audit log and an admin role gate. **Missing:** experiments. |
| 6 Attribution + revenue | **not started** | CAC/ROAS maths exists and is tested, but no first-party ingest, so the UI masks those columns on live data. |
| 7 Compliance | **partial** | Consent is signed and enforced; privacy doc has decisions, not TODOs. **Missing:** persistence of consent records, retention job, deletion flow, DPAs. |

### Architecture, as built

```
browser (React, single page)
  └── /api/*  ──▶ server/server.mjs        HTTP adapter: body cap, ip, auth wiring
                     └── server/app.mjs     router; every route unit-tested, no sockets
                            ├── auth.mjs    dev token | Firebase ID token; roles
                            ├── consent.mjs HMAC-signed consent ids
                            ├── limits.mjs  rate limit, origin allowlist, body size
                            └── core.mjs    Ads API + CAPI client (keys live here only)
```

`server/app.mjs` is deliberately transport-free: `handle({method, path, headers, ip, body})`
returns `{status, body}`. That is why the security assertions run in under a second with
no server, no network and no keys. Transport rules (body cap, client IP, headers) live in
`server/handler.mjs` and are tested over a real socket in `transport.test.ts`.

### Deviations from the original plan

| Planned | Built | Why |
|---|---|---|
| Cloud Functions | One Node HTTP server in a container | Fewer moving parts while there is one client; the handlers are pure and port to Functions later. |
| Firestore | A storage interface with memory and Firestore implementations | Consent replay protection must be persistable, but the demo must still run with no database. `STORAGE=memory` is refused in production. |
| Firebase Auth from day one | Server-side gate first, login overlay after | The expensive mistake is an unprotected write path, not a missing login screen. Roles are set by `scripts/set-role.mjs`, never from the app. |
| "Slice 1 complete before slice 2" | Slices 2–5 built first | The user-facing question was the point of the product; auth and hardening landed right after. |

## 9. Recommended next action

1. **Connect a real ad account** and replace the stub with reality — everything else is guessing until the payloads round-trip.
2. **Point `STORAGE=firestore` at a real database** and confirm the adapter against the emulator; the interface and the transaction path exist, but no Firestore was contacted.
3. **Install the Pixel + consent gate in the browser**, so `firstPartyAvailable` can become true and CAC/ROAS stop being em dashes.
4. **Build the retention/deletion jobs** before any real personal data lands.
5. Only then: hint-set experiments, alerts, and a shared rate-limit store.

---

## 10. Sources verified for this review (Oct 2026)

- OpenAI Ads — Conversions API: server-only, `oppref` event-level, `user.obref`, dedupe on pixel_id + event name + id
- OpenAI Ads — Measurement Pixel: `oaiq("measure", ...)`, `__oppref` 30d, `__obref` 365d, consent controls
- OpenAI Ads — Supported Events: `page_viewed`, `lead_created`, `order_created`, `checkout_started`, minor-unit amounts
- OpenAI Ads — Ad Groups API: `context_hints` string[] (up to ~2,000)
- OpenAI Ads — Targeting: context hints ≠ exact-match keywords, no negatives; country/region geo + custom audiences
- OpenAI Ads — Reporting/Insights: CTR/CPC/CPM, conversion insights, breakdowns by country/device, 7/14/30-day click, 0–1 day view-through
- Ads Manager availability: India available; INR minimum daily budget ₹725
