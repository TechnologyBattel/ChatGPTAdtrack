// Stream B — deterministic demo dataset.
// No network, no keys: the UI must be useful before an ad account is connected.
// Rates are shaped after public 2026 ChatGPT Ads benchmarks (CPC ~$3-5 for
// high-intent, mobile-heavy delivery, small but high-quality conversion volume).

import type { AdGroup, Campaign, Dataset, DayRow, Device, Platform } from './types';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNTRIES: { code: string; weight: number }[] = [
  { code: 'IN', weight: 0.74 },
  { code: 'AE', weight: 0.08 },
  { code: 'SG', weight: 0.05 },
  { code: 'US', weight: 0.07 },
  { code: 'GB', weight: 0.06 },
];

const DEVICES: { device: Device; platform: Platform; weight: number }[] = [
  { device: 'mobile', platform: 'android_app', weight: 0.41 },
  { device: 'mobile', platform: 'ios_app', weight: 0.21 },
  { device: 'desktop', platform: 'web', weight: 0.34 },
  { device: 'tablet', platform: 'web', weight: 0.04 },
];

export const CAMPAIGNS: Campaign[] = [
  {
    id: 'cmpn_intent',
    name: 'Intent — accounting automation',
    objective: 'conversions',
    status: 'active',
    dailyBudgetMinor: 250000, // ₹2,500
    goalEvent: 'lead_created',
  },
  {
    id: 'cmpn_compare',
    name: 'Comparison — vs legacy tools',
    objective: 'clicks',
    status: 'active',
    dailyBudgetMinor: 150000, // ₹1,500
    goalEvent: 'lead_created',
  },
  {
    id: 'cmpn_reach',
    name: 'Reach — GST season',
    objective: 'views',
    status: 'active',
    dailyBudgetMinor: 100000, // ₹1,000
    goalEvent: 'page_viewed',
  },
  {
    id: 'cmpn_brand',
    name: 'Brand defence',
    objective: 'clicks',
    status: 'paused',
    dailyBudgetMinor: 50000, // ₹500
    goalEvent: 'lead_created',
  },
];

export const AD_GROUPS: AdGroup[] = [
  {
    id: 'adgrp_gst',
    campaignId: 'cmpn_intent',
    name: 'GST filing stress',
    theme: 'Deadline anxiety',
    hints: [
      'someone who is behind on GST filing for a small business and running out of time',
      'a business owner asking how to reconcile GSTR-2B before the filing deadline',
      'an accountant looking for a way to stop filing GST returns manually every month',
    ],
    landingPath: '/gst-automation',
  },
  {
    id: 'adgrp_invoice',
    campaignId: 'cmpn_intent',
    name: 'Invoice data entry',
    theme: 'Manual work',
    hints: [
      'a bookkeeper describing hours spent typing purchase invoices into a spreadsheet',
      'someone asking whether invoice data entry can be automated from PDFs',
      'an accounts team complaining that bills arrive as photos on WhatsApp',
    ],
    landingPath: '/invoice-automation',
  },
  {
    id: 'adgrp_size',
    campaignId: 'cmpn_intent',
    name: 'Choosing for a 5–20 person firm',
    theme: 'Tool selection',
    hints: [
      'a founder comparing accounting tools for a team of about ten people',
      'someone asking what accounting software suits an Indian SMB with two accountants',
      'a CA firm deciding whether to move client bookkeeping to a single system',
    ],
    landingPath: '/for-small-teams',
  },
  {
    id: 'adgrp_switch',
    campaignId: 'cmpn_compare',
    name: 'Switching from spreadsheets',
    theme: 'Migration',
    hints: [
      'someone who has outgrown Excel for bookkeeping and is looking at alternatives',
      'a business owner asking how painful it is to migrate years of spreadsheet data',
    ],
    landingPath: '/switch-from-spreadsheets',
  },
  {
    id: 'adgrp_vs',
    campaignId: 'cmpn_compare',
    name: 'Comparing against legacy desktop software',
    theme: 'Comparison',
    hints: [
      'an accountant weighing a cloud tool against installed desktop accounting software',
      'someone asking which is better for a firm that shares work across three branches',
    ],
    landingPath: '/compare',
  },
  {
    id: 'adgrp_gstseason',
    campaignId: 'cmpn_reach',
    name: 'GST season awareness',
    theme: 'Seasonal',
    hints: [
      'people discussing the busiest weeks before a GST return deadline',
      'conversations about hiring temporary help during tax season',
    ],
    landingPath: '/gst-season',
  },
  {
    id: 'adgrp_brand',
    campaignId: 'cmpn_brand',
    name: 'Brand and product names',
    theme: 'Brand',
    hints: ['someone looking for this product by name', 'someone looking for product login'],
    landingPath: '/',
  },
];

const HINTS_BY_AG = new Map(AD_GROUPS.map((g) => [g.id, g]));

/** Per-ad-group economics, tuned so the story on the page is coherent. */
const ECON: Record<
  string,
  { base: number; ctr: number; cpcMinor: number; l2c: number; leadRate: number; aovMinor: number; trend: number }
> = {
  adgrp_gst: { base: 1500, ctr: 0.052, cpcMinor: 26500, leadRate: 0.061, l2c: 0.27, aovMinor: 1499000, trend: 0.55 },
  adgrp_invoice: { base: 1200, ctr: 0.046, cpcMinor: 23800, leadRate: 0.052, l2c: 0.23, aovMinor: 1299000, trend: 0.2 },
  adgrp_size: { base: 900, ctr: 0.041, cpcMinor: 31000, leadRate: 0.058, l2c: 0.31, aovMinor: 1899000, trend: 0.35 },
  adgrp_switch: { base: 700, ctr: 0.038, cpcMinor: 22000, leadRate: 0.047, l2c: 0.26, aovMinor: 1499000, trend: -0.1 },
  adgrp_vs: { base: 620, ctr: 0.035, cpcMinor: 28000, leadRate: 0.05, l2c: 0.29, aovMinor: 1799000, trend: 0.12 },
  adgrp_gstseason: {
    base: 2600,
    ctr: 0.021,
    cpcMinor: 9500,
    leadRate: 0.012,
    l2c: 0.14,
    aovMinor: 1299000,
    trend: 0.9,
  },
  adgrp_brand: { base: 800, ctr: 0.09, cpcMinor: 6500, leadRate: 0.071, l2c: 0.38, aovMinor: 1499000, trend: 0 },
};

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function buildDataset(days = 90, endDate = '2026-10-24'): Dataset {
  const rand = rng(20261024);
  const rows: DayRow[] = [];
  const end = new Date(`${endDate}T00:00:00Z`);

  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - d);
    const date = iso(day);
    const dow = day.getUTCDay();
    const weekend = dow === 0 || dow === 6 ? 0.82 : 1;
    // Visible growth so period-over-period answers have something to say.
    const progress = (days - 1 - d) / days;

    for (const group of AD_GROUPS) {
      const camp = CAMPAIGNS.find((c) => c.id === group.campaignId)!;
      if (camp.status === 'paused' && progress > 0.72) continue; // paused late in the window
      const e = ECON[group.id];
      if (!e) continue;

      // GST bump in the last third of each month.
      const dom = day.getUTCDate();
      const gstBump = group.id.startsWith('adgrp_gst') && dom > 18 ? 1.45 : 1;

      for (const c of COUNTRIES) {
        for (const dev of DEVICES) {
          const noise = 0.72 + rand() * 0.6;
          const impressions = Math.max(
            0,
            Math.round(e.base * c.weight * dev.weight * 0.9 * noise * weekend * (1 + e.trend * progress) * gstBump),
          );
          if (impressions === 0) continue;
          const ctr = Math.max(0.004, e.ctr * (0.85 + rand() * 0.3) * (dev.device === 'mobile' ? 1.06 : 1));
          const clicks = Math.max(0, Math.round(impressions * ctr));
          const spendMinor = Math.round(clicks * e.cpcMinor * (0.88 + rand() * 0.24));

          const leads = Math.max(0, Math.round(clicks * e.leadRate * (0.75 + rand() * 0.5)));
          const customers = Math.max(0, Math.round(leads * e.l2c * (0.7 + rand() * 0.6)));
          const refunds = rand() < 0.03 ? 1 : 0;
          const netCustomers = Math.max(0, customers - refunds);
          const salesMinor = Math.round(netCustomers * e.aovMinor * (0.92 + rand() * 0.16));

          // Native reports one-day view-through on top of click conversions.
          const viewThrough = rand() < 0.42 ? Math.max(0, Math.round(leads * 0.18 * rand())) : 0;
          const conversionsNative = leads + viewThrough;

          rows.push({
            date,
            campaignId: group.campaignId,
            adGroupId: group.id,
            country: c.code,
            device: dev.device,
            platform: dev.platform,
            impressions,
            clicks,
            spendMinor,
            conversionsNative,
            viewThrough,
            leads,
            customers: netCustomers,
            salesMinor,
          });
        }
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    endDate,
    currency: 'INR',
    campaigns: CAMPAIGNS,
    adGroups: AD_GROUPS.map((g) => ({ ...g, hints: [...(HINTS_BY_AG.get(g.id)?.hints ?? g.hints)] })),
    rows,
  };
}

/** Small helper used by the research module and the UI legend. */
export function campaignOf(dataset: Dataset, id: string): Campaign | undefined {
  return dataset.campaigns.find((c) => c.id === id);
}
