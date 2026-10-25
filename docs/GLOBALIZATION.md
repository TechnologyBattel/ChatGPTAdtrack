# Global by design

_Date: 2026-10-25 · Code: `server/validate.mjs`, `server/time.mjs`, `server/agency.mjs`_

The product is used from more than one country on day one, so three things are decided
once, globally, instead of per-page:

1. **Storage is UTC epoch milliseconds.** Every instant is an integer. No local-time string
   is ever the source of truth.
2. **Meaning comes from the workspace.** Currency, IANA time zone, markets and language are
   workspace fields; a campaign inherits them unless it states its own.
3. **The original offset is preserved.** An event stores both the instant and the raw
   `occurred_at` string it arrived with, so it can be re-read after a timezone rule
   change without guessing.

## 1. Countries and currencies

| Field | Rule | Where |
|---|---|---|
| `country_code` | ISO-3166 alpha-2, upper-cased | `countryCode()` |
| `currency` | ISO-4217, membership in `Intl.supportedValuesOf('currency')` | `currencyCode()` |
| `amount_minor` | non-negative safe integer, minor units (paise, cents), ≤ 1e12 | `events-v2.mjs` |
| `language` | BCP-47-shaped tag (`en-IN`) | `languageTag()` |

**No FX conversion exists in this codebase.** A tripwire test greps `server/` for
`exchangeRate|exchange_rate|convertCurrency|fxRate` and fails if one appears. Adding a
conversion silently would change every historical number in every report, so it must be a
deliberate, documented change — and it must store the rate and its date, not just apply it.

Minor units are the only money representation. `₹1,234.50` is stored as `123450` with
`currency: 'INR'`. Floats do not appear in the money path at all.

### Why not trust `Intl` alone

Measured in this repo (PROVEN, `node -e` probes recorded in the session):

- `Intl.DateTimeFormat` **accepts** legacy abbreviations `IST` and `EST`, which are
  ambiguous (Irish vs India vs Israel Standard Time).
- `Intl.NumberFormat` **accepts any three letters** as a currency (`XYZ` formats fine).
- `Intl.supportedValuesOf('timeZone')` **excludes `UTC`**, so a plain membership test would
  reject the most common zone.

So validation is layered: **shape first, then semantics**.

- Time zone: must match `/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/` or be exactly
  `UTC` / `Etc/UTC`, and only then be resolved by `Intl`. `IST` is rejected on shape;
  `Asia/Kolkata` is accepted.
- Currency: `^[A-Z]{3}$` plus membership in `supportedValuesOf('currency')` (162 codes in
  Node 22.22.3). `XYZ` is rejected; `INR` is accepted.

The rule generalised: **"does `Intl` throw?" is not a validator.** It is lenient in exactly
the places a typo occurs.

## 2. Time zones

Reports are asked for in a customer's zone. "Yesterday" in `Asia/Kolkata` is not
"yesterday" in UTC, so every daily bucket is computed with `server/time.mjs`:

| Function | Purpose |
|---|---|
| `partsInZone(ms, zone)` | wall-clock parts of an instant in a zone (normalises ICU's `hour: 24` to `0`) |
| `offsetMinutes(ms, zone)` | the zone's offset **at that instant**, not today's |
| `startOfZonedDay(ms, zone)` | midnight local, resolved in two passes so DST transitions land correctly |
| `zonedDayRange(ms, zone)` | `{ startMs, endMs, timeZone, localDate, hours }` |
| `bucketByLocalDay(events, {timeZone, fromMs, toMs})` | counts per local date; events outside the range are **dropped, not clamped** |

### Facts this design is built on (PROVEN by `global.test.ts`)

| Fact | Evidence |
|---|---|
| Kolkata is UTC+05:30 with no DST | the local day starting `2025-10-09` begins at `2025-10-09T18:30:00.000Z` |
| A New York day is **25 hours** on the DST fall-back date | `hours: 25` |
| A New York day is **23 hours** on the DST spring-forward date | `hours: 23` |
| The same zone has different offsets at different instants | `-240` and `-300` minutes for New York in one dataset |
| The same two events fall on **different** IST days but the **same** UTC day | bucketing test |
| Offsets pre-date 1970 and are not constant | resolution uses `Intl`, never a hardcoded table |

Consequences in code: no `+ 24 * 3600 * 1000` anywhere in a day boundary; no fixed offset
table; no assumption that a day has 24 hours. A day range is asked for, not calculated.

`bucketByLocalDay` **drops** out-of-range events instead of clamping them to the edge:
clamping would make a partial day look complete, which is the same class of error as a
fake zero.

## 3. Rendering

- Money: `formatMoney(amountMinor, currency)` — the currency symbol comes from `Intl`, so
  an INR workspace never shows `$`.
- Dates in reports: `formatInZone(ms, zone, locale)`; storage and API payloads use ISO-8601
  UTC (`2025-10-09T18:30:00.000Z`) so the wire format is unambiguous.
- A workspace's zone is shown next to the numbers in the workspace panel, because a daily
  total without its zone is an ambiguous number.

## 4. What is not globalised

| Area | State |
|---|---|
| Number grouping/locale display | follows `Intl` defaults per locale; not user-configurable |
| Fiscal calendars (e.g. April–March in India) | not implemented; reports are calendar-based — stated as a gap, not approximated |
| Currency conversion | deliberately absent (see §1) |
| Right-to-left layouts | not implemented; the UI is LTR only |
| Translated UI strings | not implemented; English only |
| Country-specific consent regimes | not encoded; consent is a single `granted/denied/unknown` with a jurisdiction-free meaning |

Each of these is a real gap for a global product; none is faked. See
`BASELINE_AND_GAPS.md` §4 for the tracking table.
