// Stream B — metrics engine. Pure functions, no UI, no I/O.
// Every number the page shows is computed here so it can be tested.

import type {
  DailyPoint,
  Dataset,
  DayRow,
  Filter,
  GroupedMetrics,
  MetricSet,
  Pacing,
  Settings,
} from './types';

export const DEFAULT_SETTINGS: Settings = {
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  windowDays: 30,
  viewThroughDays: 1,
  pacingDays: 7,
  orgName: 'Ledgerly',
};

export function toMinor(rupees: number): number {
  return Math.round(rupees * 100);
}

export function formatMoney(minor: number, currency = 'INR', compact = false): string {
  if (!Number.isFinite(minor)) return '—';
  const value = minor / 100;
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  if (compact) {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }
  const hasPaise = Math.round(minor) % 100 !== 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: hasPaise ? 2 : 0,
  }).format(value);
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-IN').format(Math.round(n));
}

export function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${ratio.toFixed(2)}×`;
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

export function metricsOf(rows: DayRow[]): MetricSet {
  const sums = rows.reduce(
    (acc, r) => {
      acc.impressions += r.impressions;
      acc.clicks += r.clicks;
      acc.spendMinor += r.spendMinor;
      acc.conversionsNative += r.conversionsNative;
      acc.viewThrough += r.viewThrough;
      acc.leads += r.leads;
      acc.customers += r.customers;
      acc.salesMinor += r.salesMinor;
      return acc;
    },
    {
      impressions: 0,
      clicks: 0,
      spendMinor: 0,
      conversionsNative: 0,
      viewThrough: 0,
      leads: 0,
      customers: 0,
      salesMinor: 0,
    },
  );

  const conversionsInternal = sums.leads;
  return {
    impressions: sums.impressions,
    clicks: sums.clicks,
    spendMinor: sums.spendMinor,
    ctr: safeDiv(sums.clicks, sums.impressions),
    cpcMinor: safeDiv(sums.spendMinor, sums.clicks),
    cpmMinor: safeDiv(sums.spendMinor, sums.impressions) * 1000,
    conversionsNative: sums.conversionsNative,
    conversionsInternal,
    leads: sums.leads,
    cplMinor: safeDiv(sums.spendMinor, sums.leads),
    customers: sums.customers,
    cacMinor: safeDiv(sums.spendMinor, sums.customers),
    salesMinor: sums.salesMinor,
    roas: safeDiv(sums.salesMinor, sums.spendMinor),
    leadToCustomer: safeDiv(sums.customers, sums.leads),
    viewThrough: sums.viewThrough,
  };
}

export function dayCount(dataset: Dataset, days: number): string[] {
  const all = [...new Set(dataset.rows.map((r) => r.date))].sort();
  return all.slice(Math.max(0, all.length - days));
}

export function applyFilter(dataset: Dataset, filter: Filter = {}): DayRow[] {
  const days = filter.days ?? 30;
  const allowedDates = new Set(dayCount(dataset, days));
  const campaignIds = filter.campaignIds ? new Set(filter.campaignIds) : null;
  const adGroupIds = filter.adGroupIds ? new Set(filter.adGroupIds) : null;
  const countries = filter.countries ? new Set(filter.countries) : null;
  const devices = filter.devices ? new Set(filter.devices) : null;

  return dataset.rows.filter((r) => {
    if (!allowedDates.has(r.date)) return false;
    if (campaignIds && !campaignIds.has(r.campaignId)) return false;
    if (adGroupIds && !adGroupIds.has(r.adGroupId)) return false;
    if (countries && !countries.has(r.country)) return false;
    if (devices && !devices.has(r.device)) return false;
    return true;
  });
}

/** Trailing daily series, oldest first, with the freshness flag applied. */
export function dailySeries(dataset: Dataset, filter: Filter = {}, staleAfterDays = 2): DailyPoint[] {
  const rows = applyFilter(dataset, filter);
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const cutoff = dates.length - staleAfterDays;
  const byDate = new Map<string, DayRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  return dates.map((date, i) => {
    const m = metricsOf(byDate.get(date) ?? []);
    return {
      date,
      impressions: m.impressions,
      clicks: m.clicks,
      spendMinor: m.spendMinor,
      leads: m.leads,
      customers: m.customers,
      salesMinor: m.salesMinor,
      preliminary: i >= cutoff,
    };
  });
}

function groupBy(
  dataset: Dataset,
  filter: Filter,
  keyFn: (r: DayRow) => string,
  labelFn: (key: string) => string,
): GroupedMetrics[] {
  const rows = applyFilter(dataset, filter);
  const buckets = new Map<string, DayRow[]>();
  for (const r of rows) {
    const k = keyFn(r);
    const list = buckets.get(k) ?? [];
    list.push(r);
    buckets.set(k, list);
  }
  return [...buckets.entries()]
    .map(([key, list]) => ({ key, label: labelFn(key), ...metricsOf(list) }))
    .sort((a, b) => b.spendMinor - a.spendMinor);
}

export function byCampaign(dataset: Dataset, filter: Filter = {}): GroupedMetrics[] {
  return groupBy(
    dataset,
    filter,
    (r) => r.campaignId,
    (k) => dataset.campaigns.find((c) => c.id === k)?.name ?? k,
  );
}

export function byCountry(dataset: Dataset, filter: Filter = {}): GroupedMetrics[] {
  const names: Record<string, string> = {
    IN: 'India',
    AE: 'United Arab Emirates',
    SG: 'Singapore',
    US: 'United States',
    GB: 'United Kingdom',
  };
  return groupBy(dataset, filter, (r) => r.country, (k) => names[k] ?? k);
}

export function byDevice(dataset: Dataset, filter: Filter = {}): GroupedMetrics[] {
  return groupBy(dataset, filter, (r) => r.device, (k) => k[0].toUpperCase() + k.slice(1));
}

export function byAdGroup(dataset: Dataset, filter: Filter = {}): GroupedMetrics[] {
  return groupBy(
    dataset,
    filter,
    (r) => r.adGroupId,
    (k) => dataset.adGroups.find((g) => g.id === k)?.name ?? k,
  );
}

/** Previous equal-length window, for "vs previous period" deltas. */
export function previousPeriod(dataset: Dataset, filter: Filter = {}): MetricSet {
  const days = filter.days ?? 30;
  const dates = [...new Set(dataset.rows.map((r) => r.date))].sort();
  const end = dates.length - days;
  const start = Math.max(0, end - days);
  const prevDates = new Set(dates.slice(start, end));
  const rows = dataset.rows.filter((r) => {
    if (!prevDates.has(r.date)) return false;
    if (filter.campaignIds && !filter.campaignIds.includes(r.campaignId)) return false;
    if (filter.adGroupIds && !filter.adGroupIds.includes(r.adGroupId)) return false;
    if (filter.countries && !filter.countries.includes(r.country)) return false;
    if (filter.devices && !filter.devices.includes(r.device)) return false;
    return true;
  });
  return metricsOf(rows);
}

/**
 * Average-daily-budget pacing: observed spend vs budget × days.
 * OpenAI moved budgets to a rolling 7-day average in July 2026, so this is the
 * number that actually explains "why did spend jump on Tuesday".
 */
export function pacing(dataset: Dataset, filter: Filter = {}): Pacing {
  const windowDays = filter.days ?? DEFAULT_SETTINGS.pacingDays;
  const rows = applyFilter(dataset, { ...filter, days: windowDays });
  const m = metricsOf(rows);
  const dates = new Set(rows.map((r) => r.date));
  const campaignIds = filter.campaignIds ?? dataset.campaigns.map((c) => c.id);
  const dailyBudgetMinor = dataset.campaigns
    .filter((c) => campaignIds.includes(c.id))
    .reduce((sum, c) => sum + c.dailyBudgetMinor, 0);
  const observed = safeDiv(m.spendMinor, Math.max(1, dates.size));
  const ratio = safeDiv(observed, dailyBudgetMinor);
  return {
    dailyBudgetMinor,
    observedDailyMinor: observed,
    ratio,
    status: ratio > 1.05 ? 'over' : ratio < 0.85 ? 'under' : 'on',
    days: windowDays,
  };
}

export function delta(current: number, previous: number): number {
  if (!Number.isFinite(previous) || previous === 0) return Number.NaN;
  return (current - previous) / previous;
}

export interface Breakdown {
  label: string;
  value: string;
  share: number;
}

/** Share-of-spend rows used by the location and device sections. */
export function shareOfSpend(groups: GroupedMetrics[]): Breakdown[] {
  const total = groups.reduce((s, g) => s + g.spendMinor, 0);
  return groups.map((g) => ({
    label: g.label,
    value: formatMoney(g.spendMinor),
    share: safeDiv(g.spendMinor, total),
  }));
}
