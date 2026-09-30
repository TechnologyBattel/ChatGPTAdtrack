# Tracking plan

Verify every event name and field against the current OpenAI Ads developer docs before coding.

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
