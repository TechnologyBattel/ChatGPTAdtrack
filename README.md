# AdTrack (ChatGPTAdtrack)

Ask one plain-language question about your ChatGPT ads and get one answer:
**spend → leads → customers → revenue → where.** Plus a context-hint research
workspace, because ChatGPT Ads has no keyword targeting.

## Status

Working, tested single-page app with a real server-side Ads API integration.
It runs on demo data until keys exist on the server, then switches to the live
account — nothing in the browser ever holds a key.

```bash
npm install
cp .env.example .env     # fill in the server keys you actually have
npm run api              # API server, 0.0.0.0:8787
npm run dev              # web app, 0.0.0.0:5173 (proxies /api)
npm run verify           # typecheck + 84 tests + build + server contract check
```

Open the app: the connection bar under the search box says **Demo data** or
**live · <account>**. Click it for key presence, mode and retry.

### Live mode

| Variable (server only) | Purpose |
|---|---|
| `OPENAI_ADS_API_KEY` | Advertiser API: account, campaigns, ad groups, insights, hint push |
| `OPENAI_CONVERSIONS_API_KEY` | Server-to-server conversion events |
| `OPENAI_PIXEL_ID` | Data source id for both Pixel and CAPI |
| `ACCOUNT_TIMEZONE` | Reporting timezone, default `Asia/Kolkata` |
| `FIRST_PARTY_SOURCE` | Set only when lead/order events really flow; otherwise those columns are masked |

Keys are read by the API process only. `VITE_` variables are public by
definition, so no key ever uses that prefix. See [docs/API.md](docs/API.md).

### Export

Every answer has **Share**: copy a link to the exact question, print / save as
PDF (print stylesheet included), or download the tables as CSV.

## The interface

One page, modeled on search rather than on a dashboard:

```
        AdTrack
   Ask your ChatGPT ads one question  [ 🔍 ]  Track | Research   Ask
   chips: "How much did I spend this month?" …

   ── on submit the box docks to the top, nothing navigates ──

   You spent ₹1,84,290 in the last 30 days — 96% of your average daily budget.
   4 tiles → chart → table → "where these numbers come from" → follow-ups
```

No routes, no tabs, no sidebar. The question is in the URL (`?q=…&m=track`), so an
answer is shareable. If a question does not match a known intent, it falls back to a
full-funnel overview rather than refusing.

## What it answers

| Question | You get |
|---|---|
| How much did I spend this month? | spend, clicks, impressions, CPC, CPM, pacing, spend-by-campaign |
| How many leads did I get? | leads, CPL, lead→customer, leads by ad group, daily chart |
| What is my CAC / ROAS? | customers, CAC, revenue, AOV, per-campaign table |
| Where are my leads coming from? | country table, spend-share bars, best CPL and CAC market |
| How is my pacing? | 7-day average budget vs observed spend, and what a rolling average means |
| Which ad group has the best cost per lead? | ranked table by CPL/CAC/ROAS |
| Why do native and internal conversions differ? | the gap explained: view-through, dedupe key, refunds |
| Help me research context hints | the research workspace, inline |

## Research (the honest version of "keyword research")

ChatGPT Ads has **no keyword box, no negatives, and no search-terms report**. What it
has is free-form **context hints** at ad-group level. So research here is:

`seeds → PII scrub + dedupe → intent tag → semantic cluster → weighted score → conversation-shaped hints → validators → CSV`

- granularity slider (broad ↔ fine) with live re-clustering
- 5-part score with weights shown (relevance, intent, value, coverage, safety)
- hint validators that **block** keyword soup, unsupported claims and PII
- coverage-gap detection, and each cluster mapped to one landing page and one ad group

There is no search volume, because the platform has none. Value is estimated from
your own lead and revenue data instead.

## Stack

React 18 · Vite 6 · TypeScript (strict) · Tailwind 3 · Vitest + jsdom · Node 22 API server (no framework).
No runtime dependencies beyond React; the metrics and research engines are pure
functions with no I/O. Money is always integer minor units (paise).

## Rules

- Never commit secrets. `.env` locally, Cloud Function secrets in production.
- The Conversions API key is server-only; the browser only ever sees the Pixel ID.
- Geography is aggregated to country/region/city — no individual locations.
- Native (OpenAI-reported) and internal (first-party) attribution are never blended.
- Amounts are integer minor units; formatting happens only in the UI.

## Docs

| File | Contents |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Repository review, architecture, 8-slice plan, risks |
| [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md) | The six-way split used to build this, with frozen contracts |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature research: what shipped, what is deferred, what to add next |
| [docs/API.md](docs/API.md) | Server contract: modes, endpoints, mapping rules, deployment |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision log |
| [docs/METRICS.md](docs/METRICS.md) | Metric dictionary |
| [docs/TRACKING_PLAN.md](docs/TRACKING_PLAN.md) | Events, dedupe key, cookie lifetimes |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Consent, retention, deletion |
