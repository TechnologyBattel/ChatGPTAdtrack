// Stream B — shared domain contracts.
// Money rule (docs/DECISIONS.md): every amount is an integer in the currency's
// minor unit (paise for INR). Formatting happens only in the UI.

export type Currency = 'INR' | 'USD';
export type Device = 'mobile' | 'desktop' | 'tablet';
export type Platform = 'ios_app' | 'android_app' | 'web';
export type Objective = 'views' | 'clicks' | 'conversions';
export type Intent = 'transactional' | 'comparison' | 'problem' | 'informational' | 'navigational';

export interface Settings {
  currency: Currency;
  timezone: string;
  /** Click window, mirroring the native options of 7 / 14 / 30 days. */
  windowDays: 7 | 14 | 30;
  /** View-through window, mirroring the native options of 0 / 1 day. */
  viewThroughDays: 0 | 1;
  /** Native default is an average daily budget over a rolling 7 days. */
  pacingDays: number;
  orgName: string;
}

export interface Campaign {
  id: string;
  name: string;
  objective: Objective;
  status: 'active' | 'paused';
  dailyBudgetMinor: number;
  goalEvent: 'lead_created' | 'order_created' | 'page_viewed';
}

export interface AdGroup {
  id: string;
  campaignId: string;
  name: string;
  theme: string;
  hints: string[];
  landingPath: string;
}

/** One campaign × ad group × country × device × day. */
export interface DayRow {
  date: string; // YYYY-MM-DD
  campaignId: string;
  adGroupId: string;
  country: string;
  device: Device;
  platform: Platform;
  impressions: number;
  clicks: number;
  spendMinor: number;
  /** Reported by OpenAI, includes 1-day view-through. */
  conversionsNative: number;
  viewThrough: number;
  /** First-party events, last-touch 30-day click window only. */
  leads: number;
  customers: number;
  salesMinor: number;
}

export interface Dataset {
  generatedAt: string;
  endDate: string;
  currency: Currency;
  /** Account timezone reported by the Ads API; absent for demo data. */
  timezone?: string;
  /** True when lead/customer/revenue columns come from our own events. */
  firstPartyAvailable?: boolean;
  /** Breakout reports fetched separately so totals are never double counted. */
  segments?: { device?: DayRow[] };
  /**
   * The same window at ad-group granularity, from its own Insights request. Kept
   * apart from `rows` on purpose: adding two granularities would double every total.
   * Absent in demo data, where `rows` already carry real ad-group ids.
   */
  adGroupRows?: DayRow[];
  campaigns: Campaign[];
  adGroups: AdGroup[];
  rows: DayRow[];
}

export interface MetricSet {
  impressions: number;
  clicks: number;
  spendMinor: number;
  ctr: number;
  cpcMinor: number;
  cpmMinor: number;
  conversionsNative: number;
  conversionsInternal: number;
  leads: number;
  cplMinor: number;
  customers: number;
  cacMinor: number;
  salesMinor: number;
  roas: number;
  leadToCustomer: number;
  viewThrough: number;
}

export interface DailyPoint {
  date: string;
  impressions: number;
  clicks: number;
  spendMinor: number;
  leads: number;
  customers: number;
  salesMinor: number;
  preliminary: boolean;
}

export interface GroupedMetrics extends MetricSet {
  key: string;
  label: string;
}

export interface Pacing {
  dailyBudgetMinor: number;
  observedDailyMinor: number;
  ratio: number;
  status: 'under' | 'on' | 'over';
  days: number;
}

export type Filter = {
  campaignIds?: string[];
  adGroupIds?: string[];
  countries?: string[];
  devices?: string[];
  days?: number;
  includePaused?: boolean;
};
