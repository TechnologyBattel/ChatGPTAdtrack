export type Freshness = 'fresh' | 'stale' | 'unknown';
export declare function freshnessOf(
  observedAt: number | null | undefined,
  options?: { now?: () => number; staleAfterDays?: number },
): Freshness;
