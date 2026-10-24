# Tracking plan

Verify every event name and field against the current OpenAI Ads developer docs before coding.
Verified against developers.openai.com/ads (supported-events, measurement-pixel, conversions-api) on 2026-10-24.

| Event | Fires from | Key properties | event_id rule |
|---|---|---|---|
| page_viewed | Browser | url, session_id | uuid per view |
| lead_created | Browser + Server | lead_id, session_id | same uuid on both |
| checkout_started | Browser + Server | amount, currency | same uuid on both |
| order_created | Server | order_id, amount, currency | order_id-based |

Rules:
- Same conversion sent by Pixel and CAPI must share one event_id.
- No event is sent when consent is denied.
- Never modify or invent oppref.

Reference details that must not drift:
- Dedupe key is **pixel_id + event name + event id**; OpenAI keeps the first event it receives and drops later duplicates.
- The Conversions API is **server-only**. The browser must never call `bzr.openai.com`; it calls our `/track` endpoint.
- `oppref` is an event-level field. `obref` lives in `user` and is passed unhashed, read from the Pixel's `__obref` first-party cookie.
- The Pixel captures `oppref` itself and stores it in `__oppref` (30 days). `__obref` lasts 365 days. Neither cookie may be read or written before consent.
- All monetary values are integers in the currency's **minor unit** (₹899.00 → `89900`, USD 89.00 → `8900`). An `amount` always ships with a `currency`.
- `page_viewed` is cheap but low-signal; the metrics that matter are `lead_created` and `order_created`. Do not fire `page_viewed` on every SPA route change.
