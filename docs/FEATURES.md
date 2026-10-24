# Feature research → what shipped

_2026-10-24. Sources: OpenAI Ads docs and the platform's own reporting surface; the
feature sets of Ahrefs / Semrush / Keyword Insights / Keyword Cupid as used in practice._

## A. What people actually use in an ads dashboard

| # | Feature | Why it is used | Status here |
|---|---|---|---|
| 1 | Impressions, clicks, spend, CTR, CPC, CPM | The exact seven numbers Ads Manager reports | ✅ on every answer |
| 2 | Conversions + cost per conversion | The one number leadership asks for | ✅ native and internal side by side |
| 3 | Average-daily-budget pacing | Budgets became a rolling 7-day average in Jul 2026; "why did spend jump" is the most common question | ✅ dedicated pacing answer + tile |
| 4 | Date range on every question | Nobody trusts a number without a window | ✅ 7d / 14d / 30d chips + in-question parsing |
| 5 | Country / device breakdown | Geo and device are the only native breakdowns | ✅ tables, spend-share bars, best-market callouts |
| 6 | Data-freshness warning | Recent delivery and conversion data still settles | ✅ last 2 days shaded "provisional" |
| 7 | Pixel + CAPI health | OpenAI calls these "the main tools advertisers use"; the gap between native and internal is the #1 support question | ✅ native-vs-internal answer with a 3-step check |
| 8 | One-click CSV / share | How the output leaves the tool | ✅ hint CSV export; shareable `?q=` URL |
| 9 | Attribution windows | 7 / 14 / 30-day click and 0–1 day view-through are the platform's own options | ✅ defaults mirror native; shown on every answer |
| 10 | Ad-group level ranking | The lowest granularity that exists (no prompt or conversation data) | ✅ ranked table by CPL/CAC/ROAS |

## B. What people actually use keyword tools for

| # | Feature | Why it is used | Status here |
|---|---|---|---|
| 11 | Bulk paste of a list | The first and only way anyone starts | ✅ textarea, dedupe, PII scrub |
| 12 | Intent auto-tagging | Sorting thousands of terms by hand is the bottleneck | ✅ 5 intent classes, rule-based and explainable |
| 13 | Semantic clustering | One cluster = one page = one ad group | ✅ Jaccard on normalised tokens with synonyms |
| 14 | Granularity slider | Every serious clustering tool has one; broad vs fine is a judgement call | ✅ live re-cluster, 0–100 |
| 15 | Coverage / gap detection | Where a new ad group earns its budget | ✅ thin clusters flagged |
| 16 | Score with visible parts | A composite score without its inputs is unusable | ✅ 5 weighted bars, weights shown |
| 17 | Export to the ad platform | Research that cannot be pasted somewhere is waste | ✅ CSV, plus **push to an ad group** with a diff, a confirm gate, Undo and an audit log |
| 18 | Hint quality checks | Paste a keyword list into a hint field and it silently underperforms | ✅ blocks keyword soup, claims, PII, too-short |

**Deliberately absent:** search volume, keyword difficulty, keyword planner, and
negative keywords. They do not exist on this channel — shipping fake versions of
them would be the single most damaging thing this tool could do.

## C. Deliberately deferred (needs a backend or a decision)

- Live Ads API sync (Advertiser key + Conversions API key in Cloud Function secrets)
- Pixel + CAPI event intake with dedupe (`/track`), consent gate, outbox retry
- ~~Push hint sets to an ad group (`context_hints`) and version the change~~ — done, with local rollback + audit
- Hint-set experiments with pre-registered primary metric
- Auth, roles, Firestore security rules, retention/deletion jobs

## D. Suggestions worth considering next

1. **Experiment log** — freeze a hint set, compare to control, store keep/kill/iterate. This is the only way research becomes evidence.
2. **Guardrail alerts** — CPL drift, CAC above target, pixel silent for 6h, consent grant rate falling.
3. **Answer memory** — pin an answer and diff it week over week ("what changed since Monday?").
4. **Landing-page ↔ hint consistency check** — the auction rewards agreement between hint, creative and page; nobody checks this today.
5. **Budget simulator** — given ₹725/day floor and observed CPC, how many leads are needed to learn anything.
6. **Keyboard-first command palette** — `/` already focuses the box; add ↑↓ history like a terminal.
7. **Board/list toggle for clusters** — drag seeds between themes.
8. **Multi-org** — explicitly out of scope until v1 is proven.
