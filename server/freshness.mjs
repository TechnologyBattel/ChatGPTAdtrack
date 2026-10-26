// Freshness is a fact about the observation date, not an opinion.
//
// Shared by the topic registry and the research report so that one number has one
// definition. "unknown" is a real answer: a record with no observation date cannot be
// described as fresh or stale.

const DAY_MS = 24 * 60 * 60 * 1000;

export function freshnessOf(observedAt, { now = () => Date.now(), staleAfterDays = 90 } = {}) {
  if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) return 'unknown';
  const ageDays = (now() - observedAt) / DAY_MS;
  if (ageDays < 0) return 'fresh'; // a future-dated observation is not stale
  return ageDays > staleAfterDays ? 'stale' : 'fresh';
}
