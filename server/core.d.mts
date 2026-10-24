// Types for the plain-JS server core, so the tests and any TS caller get
// contracts without forcing a build step onto the deployed container.

export interface ServerEnv {
  adsKey?: string;
  capiKey?: string;
  pixelId?: string;
  accountTimezone?: string;
  fetchImpl?: typeof fetch;
}

export interface TrackInput {
  eventName: string;
  eventId: string;
  sourceUrl: string;
  timestampMs?: number;
  oppref?: string;
  obref?: string;
  amountMinor?: number;
  currency?: string;
  consent: boolean;
  user?: {
    emailsSha256?: string[];
    externalIdsSha256?: string[];
    countries?: string[];
    cities?: string[];
    ipAddress?: string;
  };
}

export interface InsightsRow {
  readable_time?: string;
  campaign_id?: string;
  ad_group_id?: string;
  country?: string;
  country_name?: string;
  device?: string;
  impressions?: number | string;
  clicks?: number | string;
  spend?: number | string;
  conversions?: number | string;
  view_through_conversions?: number | string;
  [key: string]: unknown;
}

export declare class ApiError extends Error {
  status: number;
  code: string;
}

export declare function configuration(env: ServerEnv): {
  adsKey: boolean;
  capiKey: boolean;
  pixelId: boolean;
  adsKeyHint?: string;
  live: boolean;
};

export declare function fetchAccount(env: ServerEnv): Promise<unknown>;
export declare function listCampaigns(env: ServerEnv): Promise<Record<string, unknown>[]>;
export declare function listAdGroups(env: ServerEnv, campaignId: string): Promise<Record<string, unknown>[]>;
export declare function dateRange(days: number, today?: Date): { since: string; until: string };
export declare function fetchInsights(
  env: ServerEnv,
  opts?: { days?: number; segment?: 'country' | 'device' | null; aggregation?: 'campaign' | 'ad_group' },
): Promise<{ timezone: string; currency: string; rows: InsightsRow[] }>;
export declare function mapInsightsToDataset(
  payload: { rows: InsightsRow[]; currency: string; timezone: string },
  opts?: { firstPartyAvailable?: boolean },
): unknown;
export declare function health(env: ServerEnv): Promise<{
  ok: boolean;
  mode: 'live' | 'demo' | 'error';
  reason?: string;
  code?: string;
  configuration: ReturnType<typeof configuration>;
  account?: { id: string; name: string; currency: string; timezone: string; status: string; review: string };
}>;
export declare function track(
  input: TrackInput,
  env: ServerEnv,
): Promise<{ accepted: boolean; eventId: string; eventName: string }>;
export declare function pushHintSet(
  adGroupId: string,
  hints: string[],
  env: ServerEnv,
): Promise<{ adGroupId: string; previousHints: string[]; pushedHints: string[]; versionedAt: string }>;
export declare const EVENT_DATA_TYPE: Record<string, string>;
export declare const SUPPORTED_EVENTS: Set<string>;
