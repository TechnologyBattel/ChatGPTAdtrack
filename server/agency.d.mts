export declare const CAMPAIGN_STATUSES: string[];
export declare const TOPIC_INTENTS: string[];
export declare const FUNNEL_STAGES: string[];
export declare const TOPIC_STATUSES: string[];
export declare function freshnessOf(
  observedAt: number | null,
  opts?: { now?: () => number; staleAfterDays?: number },
): 'fresh' | 'stale' | 'unknown';
export interface AgencyApi {
  handle(input: {
    method: string;
    path: string;
    body?: Record<string, any>;
    query?: Record<string, string>;
    principal?: { uid: string; role?: string } | null;
  }): Promise<{ matched: boolean; status?: number; body?: Record<string, any> }>;
}
export declare function createAgencyApi(opts: {
  tenancy: unknown;
  store: { records: unknown; maintenance: unknown };
  sources?: unknown;
  /** Injected research implementation; defaults to createResearch over the same store. */
  research?: unknown;
  now?: () => number;
}): AgencyApi;
