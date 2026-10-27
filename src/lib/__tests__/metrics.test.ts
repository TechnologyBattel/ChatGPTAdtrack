import { describe, expect, it } from 'vitest';
import { buildDataset } from '../demo';
import {
  applyFilter,
  byAdGroup,
  byCountry,
  dailySeries,
  delta,
  formatMoney,
  formatPercent,
  formatRatio,
  metricsOf,
  pacing,
  previousPeriod,
  DEFAULT_SETTINGS,
  toMinor,
} from '../metrics';

const data = buildDataset(90, '2026-10-24');

describe('money', () => {
  it('stores paise, never rupees', () => {
    expect(toMinor(899.5)).toBe(89950);
    expect(formatMoney(89950)).toContain('899.50');
  });
  it('formats INR with Indian grouping', () => {
    expect(formatMoney(26845000)).toBe('₹2,68,450');
  });
  it('handles zero and non-finite without throwing', () => {
    expect(formatMoney(0)).toBe('₹0');
    expect(formatMoney(Number.NaN)).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
    expect(formatRatio(0)).toBe('0.00×');
  });
});

describe('dataset', () => {
  it('is deterministic for a given end date', () => {
    const a = buildDataset(90, '2026-10-24');
    const b = buildDataset(90, '2026-10-24');
    expect(a.rows.length).toBe(b.rows.length);
    expect(a.rows[0].impressions).toBe(b.rows[0].impressions);
    expect(a.rows.at(-1)!.spendMinor).toBe(b.rows.at(-1)!.spendMinor);
  });
  it('produces 90 distinct days', () => {
    expect(new Set(data.rows.map((r) => r.date)).size).toBe(90);
  });
  it('respects the paused campaign: no rows after it pauses', () => {
    const paused = data.rows.filter((r) => r.campaignId === 'cmpn_brand');
    expect(paused.length).toBeGreaterThan(0);
    expect(paused.length).toBeLessThan(data.rows.filter((r) => r.campaignId === 'cmpn_intent').length);
  });
});

describe('aggregation', () => {
  const rows = applyFilter(data, { days: 30 });
  const m = metricsOf(rows);

  it('derives rates from sums, not averages of rates', () => {
    expect(m.ctr).toBeCloseTo(m.clicks / m.impressions, 10);
    expect(m.cplMinor).toBeCloseTo(m.spendMinor / m.leads, 6);
    expect(m.roas).toBeCloseTo(m.salesMinor / m.spendMinor, 10);
  });

  it('never divides by zero', () => {
    const empty = metricsOf([]);
    expect(empty.cplMinor).toBe(0);
    expect(empty.roas).toBe(0);
    expect(Number.isNaN(empty.cacMinor)).toBe(false);
  });

  it('reports native conversions at or above internal ones', () => {
    expect(m.conversionsNative).toBeGreaterThanOrEqual(m.conversionsInternal);
    expect(m.viewThrough).toBeLessThanOrEqual(m.conversionsNative);
  });

  it('filters by country and campaign consistently', () => {
    const india = metricsOf(applyFilter(data, { days: 30, countries: ['IN'] }));
    expect(india.spendMinor).toBeLessThan(m.spendMinor);
    expect(india.spendMinor).toBeGreaterThan(0);
  });
});

describe('windows', () => {
  it('slices exactly N trailing days', () => {
    expect(new Set(applyFilter(data, { days: 7 }).map((r) => r.date)).size).toBe(7);
    expect(new Set(applyFilter(data, { days: 30 }).map((r) => r.date)).size).toBe(30);
  });

  it('uses equal-length previous period', () => {
    const prev = previousPeriod(data, { days: 30 });
    const cur = metricsOf(applyFilter(data, { days: 30 }));
    expect(prev.spendMinor).toBeGreaterThan(0);
    expect(prev.spendMinor).not.toBe(cur.spendMinor);
  });

  it('marks only the newest days as provisional', () => {
    const series = dailySeries(data, { days: 10 }, 2);
    expect(series.filter((p) => p.preliminary)).toHaveLength(2);
    expect(series.at(-1)!.preliminary).toBe(true);
    expect(series[0].preliminary).toBe(false);
  });
});

describe('grouping', () => {
  it('returns groups sorted by spend', () => {
    const groups = byAdGroup(data, { days: 30 });
    const spends = groups.map((g) => g.spendMinor);
    expect([...spends].sort((a, b) => b - a)).toEqual(spends);
  });
  it('country shares sum to about one', () => {
    const countries = byCountry(data, { days: 30 });
    const total = countries.reduce((s, c) => s + c.spendMinor, 0);
    const share = countries.reduce((s, c) => s + c.spendMinor / total, 0);
    expect(share).toBeCloseTo(1, 6);
  });
});

describe('pacing', () => {
  it('compares observed daily spend against the average daily budget', () => {
    const p = pacing(data, { days: 7 });
    expect(p.days).toBe(7);
    expect(p.dailyBudgetMinor).toBeGreaterThan(0);
    expect(p.ratio).toBeCloseTo(p.observedDailyMinor / p.dailyBudgetMinor, 10);
    expect(['under', 'on', 'over']).toContain(p.status);
  });
  it('scopes the budget to the selected campaigns', () => {
    const one = pacing(data, { days: 7, campaignIds: ['cmpn_intent'] });
    const all = pacing(data, { days: 7 });
    expect(one.dailyBudgetMinor).toBeLessThan(all.dailyBudgetMinor);
  });
});

describe('helpers', () => {
  it('delta is NaN without a baseline and correct with one', () => {
    expect(Number.isNaN(delta(10, 0))).toBe(true);
    expect(delta(110, 100)).toBeCloseTo(0.1, 10);
    expect(delta(90, 100)).toBeCloseTo(-0.1, 10);
  });
  it('defaults mirror the native attribution windows', () => {
    expect(DEFAULT_SETTINGS.windowDays).toBe(30);
    expect(DEFAULT_SETTINGS.viewThroughDays).toBe(1);
  });
});
