# AdTrack (ChatGPTAdtrack)

Ask a plain-language question about ChatGPT ad performance and get one answer:
ad → visit → lead → customer → revenue → location.

Plus a keyword-research workspace for ChatGPT Ads: intent → context hints → ad-group experiments → measured revenue.

## Status
Pre-code. Specifications reviewed and corrected on 2026-10-24; the build plan is in
[`docs/PLAN.md`](docs/PLAN.md). No application code exists yet.

Next: Slice 0 (repo foundation), then Slice 1 (app shell + auth).

## Stack
React + Vite + TypeScript + Tailwind · Firebase Auth/Firestore · Cloud Functions
(Node 20, `asia-south1`) · OpenAI Ads Advertiser API + Conversions API + Measurement Pixel.

## Rules
- Never commit secrets. Use .env locally (git-ignored) and Cloud Function secrets in production.
- The OpenAI Conversions API key is only used server-side; the browser only ever sees the Pixel ID.
- Geography is aggregated to country/region/city. No individual location tracking.
- Native (OpenAI-reported) and internal attribution are always shown separately.
- Money is stored as integer minor units (paise/cents).

## Docs
- [PLAN.md](docs/PLAN.md) — repository review, keyword-research design, architecture, slices
- [DECISIONS.md](docs/DECISIONS.md) · [METRICS.md](docs/METRICS.md) · [TRACKING_PLAN.md](docs/TRACKING_PLAN.md) · [PRIVACY.md](docs/PRIVACY.md)
