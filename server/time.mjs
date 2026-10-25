// Zoned time arithmetic.
//
// Stored instants are UTC epoch milliseconds. Reports, however, are asked for in a
// customer's time zone: "yesterday" in Asia/Kolkata is not "yesterday" in UTC, and a
// daily total that ignores that is wrong by up to a day at the boundary.
//
// These helpers are pure and Intl-based so they follow the tz database rather than a
// hand-maintained offset table (which is how DST bugs get shipped).

const pad = (n) => String(n).padStart(2, '0');

/** The wall-clock parts of an instant in a zone, as numbers. */
export function partsInZone(instantMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(instantMs))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  return {
    // "24" appears for midnight in some ICU builds; normalise it to 0.
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset of the zone at that instant, in minutes east of UTC (IST = +330). */
export function offsetMinutes(instantMs, timeZone) {
  const p = partsInZone(instantMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Compare against the instant truncated to the second, to avoid sub-second noise.
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60000);
}

/**
 * The first instant of the calendar day containing `instantMs`, in `timeZone`.
 *
 * Two passes: the offset is resolved at the local midnight candidate, then again at the
 * result. One pass is wrong on the day a zone changes offset (DST) — the classic
 * off-by-an-hour at exactly the boundary.
 */
export function startOfZonedDay(instantMs, timeZone) {
  const p = partsInZone(instantMs, timeZone);
  const naiveUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  let guess = naiveUtc - offsetMinutes(naiveUtc, timeZone) * 60_000;
  guess = naiveUtc - offsetMinutes(guess, timeZone) * 60_000;
  return guess;
}

/** `{ startMs, endMs, timeZone, localDate }` for the day containing the instant. */
export function zonedDayRange(instantMs, timeZone) {
  const startMs = startOfZonedDay(instantMs, timeZone);
  // The next local day may be 23, 24 or 25 hours away (DST). Ask rather than add 24h.
  const nextStart = startOfZonedDay(startMs + 30 * 60 * 60 * 1000, timeZone);
  const p = partsInZone(startMs, timeZone);
  return {
    startMs,
    endMs: nextStart - 1,
    timeZone,
    localDate: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    hours: (nextStart - startMs) / (60 * 60 * 1000),
  };
}

/** A stable, human-readable stamp in the customer's zone (for reports, not storage). */
export function formatInZone(instantMs, timeZone, locale = 'en-GB') {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(new Date(instantMs));
}

/**
 * Sum events into local days. Events outside the requested range are dropped, not
 * clamped: silently moving an event into the boundary day would inflate it.
 */
export function bucketByLocalDay(events, { timeZone, fromMs, toMs }) {
  const buckets = new Map();
  for (const event of events) {
    if (typeof event.occurredAt !== 'number') continue;
    if (event.occurredAt < fromMs || event.occurredAt > toMs) continue;
    const { localDate } = zonedDayRange(event.occurredAt, timeZone);
    buckets.set(localDate, (buckets.get(localDate) ?? 0) + 1);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
}
