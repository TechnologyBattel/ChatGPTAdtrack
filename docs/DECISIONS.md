# Decision log

- 2026-09-30: Single organization (not multi-tenant) for v1.
- 2026-09-30: Firestore first; move to Postgres if analytics queries outgrow it.
- 2026-09-30: OpenAI CAPI key stored only in Cloud Function secrets.
- 2026-09-30: OpenAI-reported and internal attribution are always shown separately.
- 2026-09-30: One map with a metric switcher, not nine separate maps.
- 2026-10-24: "Keyword research" for ChatGPT Ads means **context-hint research**, not keyword bids. There is no keyword box, no negatives and no search-terms report, so we measure at ad-group level. See docs/PLAN.md §3.
- 2026-10-24: Hints are capped per set by quality (start 25–60), not by the API's ~2,000 limit; a 2,000-hint set is unlearnable.
- 2026-10-24: Internal attribution mirrors native defaults (30-day click, 1-day view-through) so the two numbers are comparable; both are always shown.
- 2026-10-24: India + INR are supported markets; the ₹725/day minimum campaign budget is accepted and must be reflected in budget modelling.
- 2026-10-24: All monetary values stored as integer minor units (paise/cents) + ISO-4217 currency; formatting happens only in the UI.
- 2026-10-24: The browser never holds an OpenAI key. The Ads API is called from a stateless server (`server/core.mjs`), deployed as a container; Vite proxies `/api` so there is no CORS and no localhost dependency.
- 2026-10-24: Live Advertiser data has no lead/customer/revenue columns. When first-party events are not configured, those values render as `—` instead of a confident ₹0.
- 2026-10-24: One segment per insights request. Country and device reports are kept in separate arrays so device rows never inflate totals.
- 2026-10-24: `/api/track` enforces consent, event id, event name and amount-currency server-side; the client is never trusted.
- 2026-10-24: Pushing a hint set returns the previous set, so every push is reversible.
