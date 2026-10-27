# Feature research → what shipped

_2026-10-24. Sources: OpenAI Ads docs and the platform's own reporting surface; the
feature sets of Ahrefs / Semrush / Keyword Insights / Keyword Cupid as used in practice._

## Verification legend

| Mark | Meaning |
|---|---|
| **live-verified** | Exercised end-to-end through our HTTP server against a **stub** of the OpenAI Ads API (`scripts/e2e-push.mjs`). Proves our code, not their contract. |
| **demo** | Works on deterministic demo data; no ad account has been connected. |
| **UI-only** | Component behaviour verified in tests; no upstream call involved. |
| **not started** | Planned, not built. |

No feature in this repository has been run against a **real** OpenAI ad account —
that needs keys, which by design are not here.

## A. What people actually use in an ads dashboard

| # | Feature | Why it is used | Status here |
|---|---|---|---|
| 1 | Impressions, clicks, spend, CTR, CPC, CPM | The exact seven numbers Ads Manager reports | **demo** on every answer |
| 2 | Conversions + cost per conversion | The one number leadership asks for | **demo** native and internal side by side |
| 3 | Average-daily-budget pacing | Budgets became a rolling 7-day average in Jul 2026; "why did spend jump" is the most common question | **demo** dedicated pacing answer + tile |
| 4 | Date range on every question | Nobody trusts a number without a window | **demo** 7d / 14d / 30d chips + in-question parsing |
| 5 | Country / device breakdown | Geo and device are the only native breakdowns | **demo** tables, spend-share bars, best-market callouts |
| 6 | Data-freshness warning | Recent delivery and conversion data still settles | **demo** last 2 days shaded "provisional" |
| 7 | Pixel + CAPI health | OpenAI calls these "the main tools advertisers use"; the gap between native and internal is the #1 support question | **demo** native-vs-internal answer with a 3-step check |
| 8 | One-click CSV / share | How the output leaves the tool | **UI-only** hint CSV export; shareable `?q=` URL |
| 9 | Attribution windows | 7 / 14 / 30-day click and 0–1 day view-through are the platform's own options | **demo** defaults mirror native; shown on every answer |
| 10 | Ad-group level ranking | The lowest granularity that exists (no prompt or conversation data) | **demo** ranked table by CPL/CAC/ROAS |

## B. What people actually use keyword tools for

| # | Feature | Why it is used | Status here |
|---|---|---|---|
| 11 | Bulk paste of a list | The first and only way anyone starts | **UI-only** textarea, dedupe, PII scrub |
| 12 | Intent auto-tagging | Sorting thousands of terms by hand is the bottleneck | **UI-only** 5 intent classes, rule-based and explainable |
| 13 | Semantic clustering | One cluster = one page = one ad group | **UI-only** Jaccard on normalised tokens with synonyms |
| 14 | Granularity slider | Every serious clustering tool has one; broad vs fine is a judgement call | **UI-only** live re-cluster, 0–100 |
| 15 | Coverage / gap detection | Where a new ad group earns its budget | **UI-only** thin clusters flagged |
| 16 | Score with visible parts | A composite score without its inputs is unusable | **UI-only** 5 weighted bars, weights shown |
| 17 | Export to the ad platform | Research that cannot be pasted somewhere is waste | **live-verified** CSV, plus **push to an ad group** with a diff, a confirm gate, Undo and an audit log (against a stub) |
| 18 | Hint quality checks | Paste a keyword list into a hint field and it silently underperforms | **UI-only** blocks keyword soup, claims, PII, too-short |

**Deliberately absent:** search volume, keyword difficulty, keyword planner, and
negative keywords. They do not exist on this channel — shipping fake versions of
them would be the single most damaging thing this tool could do.

## C. Built, and what is deliberately deferred

- Live Ads API sync (Advertiser key + Conversions API key server-side) — **built**, unproven against the real API.
- Event intake with dedupe, session→consent handshake, origin allowlist, rate limit — **built**; the outbox retry is still deferred.
- Push hint sets (`context_hints`) with diff, confirm, undo and **server-side** history (`GET /api/audit`) — **built**.
- Auth: dev and Firebase modes, roles, login overlay, `scripts/set-role.mjs` for claims — **built**; [SECURITY.md](SECURITY.md) is the reference.
- Storage interface with memory + Firestore implementations, `STORAGE=firestore` required in production — **built**; the Firestore adapter has not met a real database.

Still deferred, needs a backend or a decision:

- Hint-set experiments with a pre-registered primary metric
- Firestore security rules, retention/deletion jobs
- A shared rate-limit counter (the limiter is per instance)

## D. Suggestions worth considering next

Everything below is unbuilt unless marked otherwise.

1. **Experiment log** — freeze a hint set, compare to control, store keep/kill/iterate. This is the only way research becomes evidence.
2. **Guardrail alerts** — CPL drift, CAC above target, pixel silent for 6h, consent grant rate falling.
3. **Answer memory** — pin an answer and diff it week over week ("what changed since Monday?").
4. **Landing-page ↔ hint consistency check** — the auction rewards agreement between hint, creative and page; nobody checks this today.
5. **Budget simulator** — given ₹725/day floor and observed CPC, how many leads are needed to learn anything.
6. **Keyboard-first command palette** — `/` already focuses the box; add ↑↓ history like a terminal.
7. **Board/list toggle for clusters** — drag seeds between themes.
8. **Multi-org** — explicitly out of scope until v1 is proven.

## Guided research and the first CRM connector (2026-10-26)

| # | Capability | What it does | Status |
|---|---|---|---|
| R1 | Guided research journey | Pick one of four goals; the server computes the report from this workspace's records | **live-verified against the local HTTP server** (curl smoke: plan → run → list) |
| R2 | Honest data states | Every section reports `observed`, `no_data` or `unavailable`; "not measurable yet" is never rendered as `0` | **live-verified** + unit-tested |
| R3 | Saved research runs | `POST …/research/runs` persists the report and audits `research.run`; a later review cannot be rewritten by new data | **live-verified** |
| R4 | Findings with provenance | Each finding carries evidence, limitations and — where the product can act — one suggested next step | unit-tested |
| C1 | HubSpot read-only connector | OAuth, sealed tokens, contact/deal sync, gated qualification | **PROVEN against a fake provider; not live-verified** |
| C2 | HubSpot webhook | v3 signature, 5-minute window, idempotent, tenant from path + stored source | **PROVEN at the HTTP layer; no real delivery** |
| C3 | Connector honesty in the UI | Shows `not connected` / `degraded` / `failed`, the missing environment variables, and why a role cannot act | component-tested |

No feature here measures search volume, CPC, competitor spend or trends: those fields do
not exist anywhere in the codebase.
