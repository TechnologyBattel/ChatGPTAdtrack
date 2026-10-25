# Metrics dictionary

Single source of truth for every number the app shows. If a definition here and a
number in the UI disagree, the UI is wrong.

## Attribution windows (decided, not configurable per user)

| Setting | Value | Why |
|---|---|---|
| Click window | **30 days** | Matches OpenAI's default so native and internal numbers are comparable. The platform also offers 7 and 14, which can be reported but are not the default. |
| View-through window | **1 day** | Matches the native default. `0` is available if view-through is excluded. |
| Model | **Last touch** | The only model both sides can agree on with a click identifier. |
| Time zone | **Asia/Kolkata** | The ad account's timezone; all day boundaries use it. |
| Currency | **INR**, stored as integer **paise** | PostgreSQL/Firestore both round floats badly. Format only in the UI. |

Internal attribution must never be silently widened or narrowed relative to these
windows. If you change them, both columns move together or the comparison is a lie.

## Funnel

| Metric | Definition |
|---|---|
| Session | One visit, identified by a first-party session id. Never a person. |
| Lead | A submitted form with a valid contact, recorded once per `lead_id`. |
| Qualified lead | A human sets the status to Qualified. Default rule: valid contact + at least one buying-intent answer + fits the ICP; editable in settings. |
| Customer | A contact with at least one **non-refunded** order. |
| Attributed revenue | Sum of non-refunded order amounts whose lead carries a last-touch click inside the window. |
| Refund | Reverses revenue; does **not** reverse the conversion count already reported upstream. |

## Delivery and cost (native)

| Metric | Definition |
|---|---|
| Impression | One recorded ad impression. |
| Click | One valid ad click (what oCPC bills on). |
| Spend | Ad account currency, stored in minor units. |
| CTR | Clicks ÷ impressions. |
| CPC | Spend ÷ clicks. |
| CPM | Spend ÷ impressions × 1,000. |
| Conversion | Goal conversions from clicks **plus** views within the selected windows. |
| View-through conversion | Conversions attributed to an impression, 1-day window. Reported separately, never merged into the internal count. |

## Efficiency

| Metric | Definition |
|---|---|
| CPL | Spend ÷ leads. |
| CAC | Spend ÷ new customers. |
| ROAS | Attributed revenue ÷ spend. Shown as `2.41×`. |
| Lead → customer rate | New customers ÷ leads, same period. |
| Payback period | Days of attributed gross margin needed to recover CAC. |
| Pacing ratio | Observed daily spend ÷ average daily budget over 7 days. `0.85–1.05` is "on plan". |

## Data quality

| Metric | Definition |
|---|---|
| Native conversions | What OpenAI reports. Includes 1-day view-through. |
| Internal conversions | What our own events prove. Click-only, last touch. |
| Attribution gap | Native − internal. Explained, never "corrected" by blending the two. |
| Preliminary | The newest **48–72 h** may still settle. Labelled in the UI and shaded on charts. |
| Missing | `—`, not `0`. A zero is a measurement; an em dash is an absence of one. |

## Rounding and display

- Rates use one decimal place; CTR uses two.
- Money uses two decimals only when paise are non-zero (`₹900`, `₹899.50`).
- Tables rank by spend unless the answer is about efficiency, in which case they
  rank by the metric being discussed.
