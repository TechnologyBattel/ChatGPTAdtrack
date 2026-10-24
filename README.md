# AdTrack (ChatGPTAdtrack)

Ask one plain-language question about your ChatGPT ads and get one answer:
**spend → leads → customers → revenue → where.** Plus a context-hint research
workspace, because ChatGPT Ads has no keyword targeting.

## Status

Working, tested single-page app on demo data (no ad account connected yet).
64 tests + typecheck + build green via `npm run verify`.

## Run it

```bash
npm install
npm run dev     # http://localhost:5173  (binds 0.0.0.0 for the live preview)
npm run verify  # typecheck + 64 tests + production build
```

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

React 18 · Vite 6 · TypeScript (strict) · Tailwind 3 · Vitest + jsdom.
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
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision log |
| [docs/METRICS.md](docs/METRICS.md) | Metric dictionary |
| [docs/TRACKING_PLAN.md](docs/TRACKING_PLAN.md) | Events, dedupe key, cookie lifetimes |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Consent, retention, deletion |
