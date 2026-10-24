# Workstream split (sub-agent division of labour)

_Date: 2026-10-24 · Branch: `arena/b0e01b66-chatgptadtrack`_

Six workstreams with **explicit file ownership** so they can run in parallel without merge conflicts.
Contracts are fixed up front; each stream only consumes another stream's exported types/functions.

| Stream | Owns (files) | Deliverable | Depends on |
|---|---|---|---|
| **A — Foundation** | `package.json`, `vite.config.ts`, `tsconfig*`, `tailwind.config.js`, `postcss.config.js`, `index.html`, `.env.example`, `README.md`, `src/main.tsx`, `src/index.css` | Runnable Vite + React + TS + Tailwind app, single-page entry, 0.0.0.0 dev server for preview | — |
| **B — Data & metrics** | `src/lib/types.ts`, `src/lib/demo.ts`, `src/lib/metrics.ts` | Deterministic synthetic ad-account data (90 days) + real aggregation: windows, native vs internal, CTR/CPC/CPM/CPL/CAC/ROAS, pacing, freshness | A |
| **C — Answer engine** | `src/lib/answer.ts` | Natural-language query → structured answer (headline sentence, tiles, sections). No UI. | B |
| **D — Single-page UI** | `src/App.tsx`, `src/components/SearchBar.tsx`, `src/components/Answer.tsx`, `src/components/Chrome.tsx` | Google-style one-page experience: centered ask box → inline answer. No router, no separate pages. | A, B, C |
| **E — Keyword research** | `src/lib/research.ts`, `src/components/Research.tsx`, `src/components/ResearchAnswer.tsx` | Seeds → scrub → intent → cluster (granularity slider) → score → hints → validators → CSV | A, B |
| **F — QA** | `src/lib/__tests__/*` | 64 tests: money/window/pacing/grouping, intent routing, hint validators, CSV, and 6 jsdom UI smoke tests. Gate: `npm run verify`. | B, C, E |

## Execution order actually used in this session

Because I am one agent rather than six real processes, the streams ran as **parallel work where files were disjoint, serial where they shared a contract**:

```
A ──▶ B ──┬──▶ C ──┐
          ├──▶ E ──┼──▶ D ──▶ F
          └─────────┘
```

Everything D consumes is a pure function from B/C/E, which is also why the UI has no business logic in it — a second agent can replace any stream without touching the page.

## Stream G — live integration (added after the first build)

| Files | Deliverable |
|---|---|
| `server/core.mjs`, `server/dev.mjs`, `scripts/check-server.mjs`, `src/lib/api.ts`, `src/components/ConnectionBar.tsx`, `src/components/ExportMenu.tsx` | Server-side Ads API: account verification, insights → dataset mapping (minor units, split segments), consent-gated `/track`, reversible hint push, 5-minute cache, retry with backoff; plus connection status and answer export |

Because this stream crosses the browser boundary, it owns the rule that no key
may appear in a `VITE_` variable, and it ships a test asserting no key material is
echoed in any response.

## Interface contracts (frozen)

```ts
// B
type Window = { days: 7 | 14 | 30; viewThroughDays: 0 | 1 };
type MetricSet = {
  impressions; clicks; spendMinor; ctr; cpc; cpm;
  conversionsNative; conversionsInternal;
  leads; cplMinor; customers; cacMinor; salesMinor; roas; leadToCustomer;
};
aggregate(rows, filter, window): MetricSet
dailySeries(rows, filter, window): DailyPoint[]
pacing(rows, window): Pacing

// C
type AnswerSpec = {
  intent: string; headline: string; subline: string;
  tiles: Tile[]; sections: Section[];
  sources: string[]; followUps: string[];
};
answerFor(query: string, data: Dataset, settings: Settings): AnswerSpec

// E
type ResearchResult = {
  digits: { seeds, duplicates, piiRemoved, clusters };
  clusters: Cluster[];
  hints: Hint[];           // with score parts + validators
  gaps: string[];
};
runResearch(rawSeeds: string, granularity: number): ResearchResult
toCsv(result): string
```

## Feature research that drove the scope

Most-used capabilities, from the platform's own reporting surface and from what keyword tools are actually used for:

**Track (must be on the first screen):** impressions, clicks, spend, CTR, CPC, CPM, conversions, cost/conversion — the exact list Ads Manager reports. Plus: average-daily-budget pacing (rolling 7 days, since July 2026), conversion measurement via Pixel + CAPI (called "the main tools advertisers use"), one-day view-through, country/device breakdowns, data-freshness lag, and per-ad-group landing paths as the only available proxy for intent (there is no prompt-level reporting).

**Research (must be in the first release):** bulk paste, intent auto-tagging, semantic clustering with a granularity control, one cluster = one ad group + landing page, coverage/gap detection, CSV export. That is what people actually use Ahrefs/Semrush/Keyword Insights *for*; volume and difficulty are replaced here by first-party expected value, because ChatGPT Ads has no keyword volume to show.

**Deliberately out of scope for this slice:** live API calls (no keys), multi-page navigation, auth. The page labels its data as demo everywhere it appears.
