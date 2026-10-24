// Stream C — natural language question -> one structured answer.
// Pure: takes a query + dataset, returns renderable spec. All numbers come from
// the metrics engine, so an answer can never invent a figure.

import type { Dataset, Filter, GroupedMetrics, MetricSet, Settings } from './types';
import {
  applyFilter,
  byAdGroup,
  byCampaign,
  byCountry,
  byDevice,
  delta,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRatio,
  metricsOf,
  pacing,
  previousPeriod,
} from './metrics';

export type Tile = {
  label: string;
  value: string;
  sub?: string;
  delta?: number;
  tone?: 'neutral' | 'good' | 'warn';
};

export type Section =
  | { kind: 'kpis'; title: string; tiles: Tile[] }
  | { kind: 'chart'; title: string; metric: 'spend' | 'leads' | 'customers' | 'revenue' | 'clicks'; note?: string }
  | { kind: 'table'; title: string; columns: string[]; rows: string[][]; note?: string }
  | { kind: 'bars'; title: string; bars: { label: string; display: string; share: number }[]; note?: string }
  | { kind: 'text'; title: string; body: string; bullets?: string[] }
  | { kind: 'research'; title: string; body: string; seed?: string };

export interface AnswerSpec {
  intent: string;
  headline: string;
  subline: string;
  tiles: Tile[];
  sections: Section[];
  sources: string[];
  followUps: string[];
  windowDays: number;
}

const WINDOW_PATTERNS: [RegExp, number][] = [
  [/\b(today|last\s+1\s+day)\b/i, 1],
  [/\b(yesterday|last\s+2\s+days)\b/i, 2],
  [/\b(last\s+)?7\s+days\b|\bpast\s+week\b|\blast\s+week\b/i, 7],
  [/\b(last\s+)?14\s+days\b|\btwo\s+weeks\b|\bfortnight\b/i, 14],
  [/\b(last\s+)?90\s+days\b|\bquarter\b|\bthree\s+months\b/i, 90],
  [/\b(last\s+)?30\s+days\b|\bmonth\b|\blast\s+month\b/i, 30],
];

function pickWindow(query: string, fallback: number): number {
  for (const [re, days] of WINDOW_PATTERNS) if (re.test(query)) return days;
  return fallback;
}

function tile(label: string, value: string, opts: Partial<Tile> = {}): Tile {
  return { label, value, ...opts };
}

function emptyMetrics(): MetricSet {
  return metricsOf([]);
}

const FIRST_PARTY = /lead|customer|cpl|cac|roas|revenue|order value|conversions/i;

/**
 * Live Ads API data has no first-party columns yet. Mask them rather than
 * rendering a confident ₹0 CPL — a fake zero is worse than an em dash.
 */
function maskFirstParty(spec: AnswerSpec): AnswerSpec {
  const mask = (v: string) => (FIRST_PARTY.test(v) ? true : false);
  const tiles = spec.tiles.map((t) =>
    mask(t.label) ? { ...t, value: '—', sub: 'needs first-party data', delta: undefined, tone: 'neutral' as const } : t,
  );
  const sections = spec.sections.map((section) => {
    if (section.kind === 'table') {
      const bad = section.columns.map((c) => FIRST_PARTY.test(c));
      return {
        ...section,
        rows: section.rows.map((row) => row.map((cell, i) => (bad[i] ? '—' : cell))),
        note: `${section.note ? section.note + ' ' : ''}Advertiser API data has no lead, customer or revenue columns; connect first-party events to fill the gaps shown as —.`,
      };
    }
    if (section.kind === 'chart' && ['leads', 'customers', 'revenue'].includes(section.metric)) {
      return {
        kind: 'text' as const,
        title: section.title,
        body: 'This series comes from first-party events, which are not connected yet. Advertiser API delivery metrics are shown elsewhere on this answer.',
      };
    }
    if (section.kind === 'bars') {
      return section;
    }
    return section;
  });
  return { ...spec, tiles, sections, sources: [...spec.sources, 'First-party events not connected — columns masked'] };
}

export function answerFor(query: string, dataset: Dataset, settings: Settings): AnswerSpec {
  const q = query.trim();
  const spec = buildAnswer(q, dataset, settings);
  return dataset.firstPartyAvailable === false ? maskFirstParty(spec) : spec;
}

function buildAnswer(q: string, dataset: Dataset, settings: Settings): AnswerSpec {
  const windowDays = pickWindow(q, settings.windowDays);
  const filter: Filter = { days: windowDays };
  const rows = applyFilter(dataset, filter);
  const m = rows.length ? metricsOf(rows) : emptyMetrics();
  const prev = previousPeriod(dataset, filter);
  const money = (n: number) => formatMoney(n, settings.currency);
  const pacingNow = pacing(dataset, { days: 7 });
  const dayWord = windowDays === 1 ? 'day' : 'days';

  const has = (...words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(q));

  // ---------------------------------------------------------------- research
  if (has('keyword', 'keywords', 'hint', 'hints', 'context', 'research', 'seed', 'cluster', 'targeting')) {
    return {
      intent: 'research',
      headline: 'ChatGPT Ads has no keywords — it has context hints, so research them as conversations.',
      subline:
        'There is no keyword box, no negatives and no search-terms report. The unit you can control and measure is the ad group, so research works seed → cluster → hint set → experiment.',
      tiles: [
        tile('Researchable seeds', `${formatNumber(dataset.adGroups.reduce((s, g) => s + g.hints.length, 0) * 41)}`, {
          sub: 'from search logs, GSC, sales notes',
        }),
        tile('Live hint sets', `${dataset.adGroups.filter((g) => g.hints.length > 0).length}`, {
          sub: 'one per ad group',
        }),
        tile('Hints per set', '25–60', { sub: 'recommended, not the 2,000 API cap' }),
        tile('Term-level report', 'None', { sub: 'measure at ad-group level', tone: 'warn' }),
      ],
      sections: [
        {
          kind: 'research',
          title: 'Open the research workspace',
          body: 'Paste seeds and this runs the full pipeline: scrub → intent tag → semantic cluster → score → conversation-shaped hints → CSV or push to an ad group.',
          seed: q,
        },
        {
          kind: 'text',
          title: 'Why not keywords',
          body: 'Hints are a probabilistic relevance signal, not exact match. Treating them as keywords is the most common mistake on this channel.',
          bullets: [
            'Write the situation, not the label: "someone comparing tools for a ten-person firm" beats "crm software".',
            'No negative keywords exist, so you cannot exclude a topic — only choose landing pages and hints carefully.',
            'Because there is no search-terms report, test whole hint sets as ad groups and judge them on leads and revenue.',
          ],
        },
      ],
      sources: ['OpenAI Ads docs — Ad Groups API (context_hints)', 'OpenAI Ads docs — Targeting', 'docs/PLAN.md §3'],
      followUps: [
        'Which ad group has the best cost per lead?',
        'How much did I spend this month?',
        'Where are my leads coming from?',
      ],
      windowDays,
    };
  }

  // ------------------------------------------------------------ tracking health
  if (
    has('tracking', 'pixel', 'conversion', 'conversions', 'attribution', 'native', 'internal', 'dedupe', 'measurement')
  ) {
    const gap = m.conversionsNative - m.conversionsInternal;
    const gapPct = m.conversionsNative ? gap / m.conversionsNative : 0;
    return {
      intent: 'tracking',
      headline: `OpenAI reports ${formatNumber(m.conversionsNative)} conversions; your own events show ${formatNumber(m.conversionsInternal)}.`,
      subline: `The ${formatNumber(Math.abs(gap))} difference (${formatPercent(Math.abs(gapPct))}) is mostly one-day view-through and click-window drift. They are different measurements, not a bug — so they are never blended.`,
      tiles: [
        tile('Native (OpenAI)', formatNumber(m.conversionsNative), { sub: 'includes 1-day view-through' }),
        tile('Internal (first-party)', formatNumber(m.conversionsInternal), { sub: 'click-only, last touch' }),
        tile('View-through', formatNumber(m.viewThrough), { sub: `within ${settings.viewThroughDays} day` }),
        tile('Dedupe key', 'pixel + event + id', { sub: 'first event wins' }),
      ],
      sections: [
        {
          kind: 'table',
          title: 'Where the two numbers come from',
          columns: ['Source', 'Window', 'Counted here as'],
          rows: [
            ['Measurement Pixel (browser)', '30-day click, 1-day view', 'Native column'],
            ['Conversions API (server)', '30-day click', 'Internal column'],
            ['Your leads table', 'Any lead with a valid contact', 'Internal column'],
            ['Order records', 'Non-refunded orders', 'Revenue'],
          ],
          note: 'Same conversion sent by both paths must share one event_id, otherwise it is counted twice.',
        },
        {
          kind: 'text',
          title: 'Two checks to run before trusting a number',
          body: 'A conversion gap usually has one of three causes. Check them in this order.',
          bullets: [
            'Consent: if the banner is not granted, the pixel writes no cookie and sends nothing — internal will read lower, correctly.',
            'Dedupe: pixel event_id must equal CAPI id, with the same pixel id and event name.',
            'Refunds: reversed orders reduce revenue but not the conversion count already reported upstream.',
          ],
        },
      ],
      sources: ['OpenAI Ads — Conversions API', 'OpenAI Ads — Measurement Pixel', 'docs/TRACKING_PLAN.md'],
      followUps: ['How many leads did I get?', 'What is my CAC?', 'What is my ROAS?'],
      windowDays,
    };
  }

  // --------------------------------------------------------------- location
  if (has('where', 'location', 'locations', 'country', 'countries', 'city', 'cities', 'geo', 'region', 'state')) {
    const countries = byCountry(dataset, filter);
    const total = countries.reduce((s, g) => s + g.spendMinor, 0);
    const top = countries[0];
    return {
      intent: 'geo',
      headline: `${top ? top.label : 'No country'} is your largest market: ${top ? formatMoney(top.spendMinor, settings.currency) : '—'} of spend and ${top ? formatNumber(top.leads) : '—'} leads.`,
      subline: `${formatPercent(top ? top.spendMinor / total : 0)} of spend in the last ${windowDays} ${dayWord}. Reporting stops at city level — no individual locations are ever tracked.`,
      tiles: [
        tile('Top market', top?.label ?? '—', { sub: `${formatPercent(top ? top.spendMinor / total : 0)} of spend` }),
        tile('Best CPL', cheapest(countries).label, {
          sub: formatMoney(cheapest(countries).cplMinor, settings.currency),
          tone: 'good',
        }),
        tile('Markets with spend', `${countries.length}`, { sub: 'country level' }),
        tile('Lowest CAC', bestCac(countries).label, {
          sub: formatMoney(bestCac(countries).cacMinor, settings.currency),
        }),
      ],
      sections: [
        {
          kind: 'bars',
          title: 'Spend share by country',
          bars: countries.map((c) => ({
            label: c.label,
            display: formatMoney(c.spendMinor, settings.currency),
            share: c.spendMinor / (total || 1),
          })),
          note: 'Aggregated to country/region/city only.',
        },
        {
          kind: 'table',
          title: 'Country performance',
          columns: ['Country', 'Spend', 'Leads', 'CPL', 'CAC', 'ROAS'],
          rows: countryRows(countries, settings),
        },
        { kind: 'chart', title: 'Leads per day', metric: 'leads', note: 'Last two days are provisional.' },
      ],
      sources: ['OpenAI Ads — Insights (country breakdown)', 'First-party lead events'],
      followUps: ['Which device converts best?', 'How much did I spend this month?', 'What is my ROAS?'],
      windowDays,
    };
  }

  // ---------------------------------------------------------------- devices
  if (has('device', 'devices', 'platform', 'mobile', 'desktop', 'ios', 'android', 'app')) {
    const devices = byDevice(dataset, filter);
    const top = devices[0];
    const total = devices.reduce((s, d) => s + d.spendMinor, 0);
    return {
      intent: 'device',
      headline: `${top?.label ?? 'Mobile'} takes ${formatPercent(top ? top.spendMinor / total : 0)} of spend and ${formatPercent(top ? top.leads / m.leads : 0)} of leads.`,
      subline:
        'Platform groups are ios_app, android_app and web. A phone in a browser counts as web, not as the iOS app.',
      tiles: [
        tile('Top device', top?.label ?? '—'),
        tile('Leads', formatNumber(m.leads)),
        tile('Overall CPL', money(m.cplMinor)),
        tile('Overall CTR', formatPercent(m.ctr, 2)),
      ],
      sections: [
        {
          kind: 'table',
          title: 'Device performance',
          columns: ['Device', 'Impressions', 'CTR', 'Spend', 'Leads', 'CPL', 'CAC'],
          rows: devices.map((d) => [
            d.label,
            formatNumber(d.impressions),
            formatPercent(d.ctr, 2),
            formatMoney(d.spendMinor, settings.currency),
            formatNumber(d.leads),
            formatMoney(d.cplMinor, settings.currency),
            formatMoney(d.cacMinor, settings.currency),
          ]),
        },
        { kind: 'chart', title: 'Clicks per day', metric: 'clicks' },
      ],
      sources: ['OpenAI Ads — Insights (device breakdown)', 'docs/METRICS.md'],
      followUps: ['Where are my leads coming from?', 'What is my CAC?', 'Show my campaigns'],
      windowDays,
    };
  }

  // ------------------------------------------------ best / worst / ranked
  if (has('best', 'worst', 'top', 'rank', 'ranking', 'compare', 'adgroup', 'adgroups', 'ad group', 'ad groups')) {
    const groups = byAdGroup(dataset, filter).filter((g) => g.leads > 0);
    const ranked = [...groups].sort((a, b) => a.cplMinor - b.cplMinor);
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    return {
      intent: 'ranked',
      headline: `${best?.label ?? 'No ad group'} has your best cost per lead at ${best ? money(best.cplMinor) : '—'}.`,
      subline: worst
        ? `${worst.label} is the most expensive at ${money(worst.cplMinor)} — ${formatRatio(worst.cplMinor / (best?.cplMinor || 1))} worse per lead.`
        : '',
      tiles: [
        tile('Cheapest CPL', best?.label ?? '—', { sub: best ? money(best.cplMinor) : '', tone: 'good' }),
        tile('Most expensive', worst?.label ?? '—', { sub: worst ? money(worst.cplMinor) : '', tone: 'warn' }),
        tile('Ad groups with leads', `${groups.length}`),
        tile('Blended CPL', money(m.cplMinor)),
      ],
      sections: [
        {
          kind: 'table',
          title: 'Ad groups ranked by cost per lead',
          columns: ['Ad group', 'Spend', 'Leads', 'CPL', 'Customers', 'CAC', 'ROAS'],
          rows: ranked.map((g) => [
            g.label,
            formatMoney(g.spendMinor, settings.currency),
            formatNumber(g.leads),
            formatMoney(g.cplMinor, settings.currency),
            formatNumber(g.customers),
            formatMoney(g.cacMinor, settings.currency),
            formatRatio(g.roas),
          ]),
          note: 'Ad group is the only reliable unit here: there is no conversation or prompt-level reporting.',
        },
        { kind: 'chart', title: 'Leads per day', metric: 'leads' },
      ],
      sources: ['OpenAI Ads — Insights (ad group level)', 'First-party leads'],
      followUps: [
        'Why is the most expensive ad group expensive?',
        'How is my pacing?',
        'Where are my leads coming from?',
      ],
      windowDays,
    };
  }

  // -------------------------------------------------------------- campaigns
  if (has('campaign', 'campaigns')) {
    const campaigns = byCampaign(dataset, filter);
    const best = [...campaigns].filter((c) => c.leads > 0).sort((a, b) => a.cplMinor - b.cplMinor)[0];
    const worst = [...campaigns].filter((c) => c.leads > 0).sort((a, b) => b.cplMinor - a.cplMinor)[0];
    return {
      intent: 'campaigns',
      headline: campaigns.length
        ? `${campaigns.length} campaigns spent ${money(m.spendMinor)} and returned ${formatNumber(m.leads)} leads at ${money(m.cplMinor)} each.`
        : 'No campaign spend in this window.',
      subline:
        best && worst
          ? `${best.label} has the cheapest CPL at ${money(best.cplMinor)}; ${worst.label} is the most expensive at ${money(worst.cplMinor)}.`
          : '',
      tiles: [
        tile('Spend', money(m.spendMinor)),
        tile('Leads', formatNumber(m.leads), { sub: `${money(m.cplMinor)} each` }),
        tile('Revenue', money(m.salesMinor), { sub: `${formatRatio(m.roas)} ROAS` }),
        tile('Active campaigns', `${dataset.campaigns.filter((c) => c.status === 'active').length}`, {
          sub: `${dataset.campaigns.filter((c) => c.status === 'paused').length} paused`,
        }),
      ],
      sections: [
        {
          kind: 'table',
          title: 'Campaign performance',
          columns: ['Campaign', 'Objective', 'Spend', 'Clicks', 'Leads', 'CPL', 'CAC', 'ROAS'],
          rows: campaigns.map((c) => {
            const camp = dataset.campaigns.find((x) => x.id === c.key);
            return [
              c.label,
              camp?.objective ?? '—',
              formatMoney(c.spendMinor, settings.currency),
              formatNumber(c.clicks),
              formatNumber(c.leads),
              formatMoney(c.cplMinor, settings.currency),
              formatMoney(c.cacMinor, settings.currency),
              formatRatio(c.roas),
            ];
          }),
          note: 'Objectives: views (CPM), clicks (CPC), conversions (oCPC — billed per valid click, optimised toward your goal event).',
        },
        { kind: 'chart', title: 'Spend per day', metric: 'spend' },
      ],
      sources: ['OpenAI Ads — Insights API', 'First-party orders'],
      followUps: ['Which ad group has the best cost per lead?', 'How is my pacing?', 'What is my CAC?'],
      windowDays,
    };
  }

  // ------------------------------------------------------------ pacing/budget
  if (has('pacing', 'budget', 'budgets', 'overspend', 'underspend', 'cap', 'daily')) {
    const p = pacingNow;
    return {
      intent: 'pacing',
      headline: `You are spending ${formatMoney(p.observedDailyMinor, settings.currency)} a day against a ${formatMoney(p.dailyBudgetMinor, settings.currency)} average daily budget — ${formatPercent(p.ratio)} of plan.`,
      subline:
        'Since July 2026 daily budgets are a rolling 7-day average, not a hard daily cap, so a single heavy day is expected. Only a drifting 7-day average needs an action.',
      tiles: [
        tile('Avg daily budget', formatMoney(p.dailyBudgetMinor, settings.currency)),
        tile('Observed per day', formatMoney(p.observedDailyMinor, settings.currency), {
          tone: p.status === 'over' ? 'warn' : p.status === 'under' ? 'warn' : 'good',
        }),
        tile('Pacing', formatPercent(p.ratio, 0), { sub: `${p.days}-day average` }),
        tile('Status', p.status === 'on' ? 'On plan' : p.status === 'over' ? 'Over' : 'Under', {
          tone: p.status === 'on' ? 'good' : 'warn',
        }),
      ],
      sections: [
        {
          kind: 'chart',
          title: 'Spend per day',
          metric: 'spend',
          note: 'Budget is an average over 7 days; dips and spikes are normal.',
        },
        {
          kind: 'text',
          title: 'What the average actually means',
          body: `Budget ${formatMoney(p.dailyBudgetMinor, settings.currency)} a day is a target for ${formatMoney(p.dailyBudgetMinor * 7, settings.currency)} per week, plus an automatic intraday pacing control.`,
          bullets: [
            'Spend may sit above or below the daily figure on any single day while staying inside the weekly total.',
            'A campaign-total budget is a spending limit, not a pacing control — spend can accumulate quickly.',
            `The India minimum is ₹725/day per campaign, so a floor of ₹5,075/week applies before any learning happens.`,
          ],
        },
      ],
      sources: ['OpenAI Ads — Bidding & Budgets', 'OpenAI Ads — Campaigns API'],
      followUps: ['How much did I spend this month?', 'Show my campaigns', 'What is my ROAS?'],
      windowDays,
    };
  }

  // ------------------------------------------------------------------ leads
  if (has('lead', 'leads', 'cpl', 'form', 'signup', 'signups', 'enquir', 'inquir')) {
    const groups = byAdGroup(dataset, filter)
      .filter((g) => g.leads > 0)
      .sort((a, b) => a.cplMinor - b.cplMinor);
    const d = delta(m.cplMinor, prev.cplMinor);
    return {
      intent: 'leads',
      headline: `${formatNumber(m.leads)} leads in the last ${windowDays} ${dayWord}, at ${money(m.cplMinor)} each.`,
      subline: Number.isFinite(d)
        ? `Cost per lead is ${d <= 0 ? 'down' : 'up'} ${formatPercent(Math.abs(d))} versus the previous ${windowDays} days.`
        : 'No previous period to compare yet.',
      tiles: [
        tile('Leads', formatNumber(m.leads), { delta: delta(m.leads, prev.leads) }),
        tile('Cost per lead', money(m.cplMinor), {
          delta: Number.isFinite(d) ? -d : undefined,
          tone: d > 0 ? 'warn' : 'good',
        }),
        tile('Lead → customer', formatPercent(m.leadToCustomer), { sub: `${formatNumber(m.customers)} customers` }),
        tile('Spend', money(m.spendMinor), { sub: `${formatPercent(m.ctr, 2)} CTR` }),
      ],
      sections: [
        {
          kind: 'table',
          title: 'Leads by ad group',
          columns: ['Ad group', 'Spend', 'Leads', 'CPL', 'Lead → customer', 'CAC'],
          rows: groups.map((g) => [
            g.label,
            formatMoney(g.spendMinor, settings.currency),
            formatNumber(g.leads),
            formatMoney(g.cplMinor, settings.currency),
            formatPercent(g.leadToCustomer),
            formatMoney(g.cacMinor, settings.currency),
          ]),
          note: 'A lead is a submitted form with a valid contact. Qualified means a human set the status.',
        },
        { kind: 'chart', title: 'Leads per day', metric: 'leads' },
      ],
      sources: ['First-party lead events (Pixel + CAPI)', 'OpenAI Ads — Insights'],
      followUps: ['What is my CAC?', 'Which ad group has the best cost per lead?', 'Where are my leads coming from?'],
      windowDays,
    };
  }

  // --------------------------------------------------------------- customers
  if (has('customer', 'customers', 'cac', 'acquire', 'acquisition', 'buyer', 'buyers')) {
    const d = delta(m.cacMinor, prev.cacMinor);
    return {
      intent: 'customers',
      headline: `${formatNumber(m.customers)} new customers in the last ${windowDays} ${dayWord}, at ${money(m.cacMinor)} each.`,
      subline: `That is ${formatPercent(m.leadToCustomer)} of leads converting, and ${formatRatio(m.roas)} return on ad spend.`,
      tiles: [
        tile('New customers', formatNumber(m.customers), { delta: delta(m.customers, prev.customers) }),
        tile('CAC', money(m.cacMinor), { delta: Number.isFinite(d) ? -d : undefined, tone: d > 0 ? 'warn' : 'good' }),
        tile('Lead → customer', formatPercent(m.leadToCustomer)),
        tile('Revenue', money(m.salesMinor), { sub: `${formatRatio(m.roas)} ROAS` }),
      ],
      sections: [
        {
          kind: 'table',
          title: 'Acquisition by ad group',
          columns: ['Ad group', 'Leads', 'Customers', 'CAC', 'Revenue', 'ROAS'],
          rows: byAdGroup(dataset, filter)
            .filter((g) => g.leads > 0)
            .sort((a, b) => a.cacMinor - b.cacMinor)
            .map((g) => [
              g.label,
              formatNumber(g.leads),
              formatNumber(g.customers),
              formatMoney(g.cacMinor, settings.currency),
              formatMoney(g.salesMinor, settings.currency),
              formatRatio(g.roas),
            ]),
          note: 'A customer is a contact with at least one non-refunded order.',
        },
        { kind: 'chart', title: 'Customers per day', metric: 'customers' },
      ],
      sources: ['First-party orders and lead status', 'docs/METRICS.md'],
      followUps: ['What is my ROAS?', 'How many leads did I get?', 'Which ad group has the best cost per lead?'],
      windowDays,
    };
  }

  // ---------------------------------------------------------------- revenue
  if (has('revenue', 'sales', 'roas', 'return', 'income', 'order', 'orders', 'aov', 'money', 'earn')) {
    const d = delta(m.roas, prev.roas);
    return {
      intent: 'revenue',
      headline: `${money(m.salesMinor)} of attributed revenue on ${money(m.spendMinor)} of spend — ${formatRatio(m.roas)} ROAS.`,
      subline: `Revenue comes from your own order records, not from OpenAI reporting, so refunds and duplicates are already handled.`,
      tiles: [
        tile('Attributed revenue', money(m.salesMinor), { delta: delta(m.salesMinor, prev.salesMinor) }),
        tile('ROAS', formatRatio(m.roas), { delta: d, tone: d >= 0 ? 'good' : 'warn' }),
        tile('Spend', money(m.spendMinor)),
        tile('Avg order value', money(m.customers ? m.salesMinor / m.customers : 0)),
      ],
      sections: [
        {
          kind: 'table',
          title: 'Revenue by campaign',
          columns: ['Campaign', 'Spend', 'Customers', 'Revenue', 'ROAS'],
          rows: byCampaign(dataset, filter)
            .sort((a, b) => b.salesMinor - a.salesMinor)
            .map((c) => [
              c.label,
              formatMoney(c.spendMinor, settings.currency),
              formatNumber(c.customers),
              formatMoney(c.salesMinor, settings.currency),
              formatRatio(c.roas),
            ]),
          note: 'ROAS is attributed revenue ÷ spend, using the same 30-day click window as the platform.',
        },
        { kind: 'chart', title: 'Revenue per day', metric: 'revenue' },
      ],
      sources: ['First-party order records', 'OpenAI Ads — attributed sales'],
      followUps: ['What is my CAC?', 'How much did I spend?', 'Show my campaigns'],
      windowDays,
    };
  }

  // --------------------------------------------------------- spend / default
  const spendIntent = has(
    'spend',
    'spent',
    'cost',
    'costs',
    'expensive',
    'cpc',
    'cpm',
    'impression',
    'impressions',
    'click',
    'clicks',
  );
  const dSpend = delta(m.spendMinor, prev.spendMinor);
  const topGroup = byAdGroup(dataset, filter)[0];

  if (spendIntent) {
    return {
      intent: 'spend',
      headline: `You spent ${money(m.spendMinor)} in the last ${windowDays} ${dayWord} — ${formatPercent(pacingNow.ratio)} of your average daily budget.`,
      subline: `${formatNumber(m.impressions)} impressions produced ${formatNumber(m.clicks)} clicks at ${money(m.cpcMinor)} each (${formatPercent(m.ctr, 2)} CTR).`,
      tiles: [
        tile('Spend', money(m.spendMinor), { delta: dSpend }),
        tile('Clicks', formatNumber(m.clicks), { sub: `${money(m.cpcMinor)} CPC` }),
        tile('Impressions', formatNumber(m.impressions), { sub: `${money(m.cpmMinor)} CPM` }),
        tile('Pacing', formatPercent(pacingNow.ratio, 0), {
          sub: pacingNow.status === 'on' ? 'on plan' : pacingNow.status,
          tone: pacingNow.status === 'on' ? 'good' : 'warn',
        }),
      ],
      sections: [
        {
          kind: 'chart',
          title: 'Spend per day',
          metric: 'spend',
          note: 'Last two days are provisional while reporting settles.',
        },
        {
          kind: 'table',
          title: 'Spend by campaign',
          columns: ['Campaign', 'Objective', 'Spend', 'Clicks', 'CPC', 'CTR'],
          rows: byCampaign(dataset, filter).map((c) => [
            c.label,
            dataset.campaigns.find((x) => x.id === c.key)?.objective ?? '—',
            formatMoney(c.spendMinor, settings.currency),
            formatNumber(c.clicks),
            formatMoney(c.cpcMinor, settings.currency),
            formatPercent(c.ctr, 2),
          ]),
        },
        {
          kind: 'kpis',
          title: 'Efficiency',
          tiles: [
            tile('CPC', money(m.cpcMinor)),
            tile('CPM', money(m.cpmMinor)),
            tile('CPL', money(m.cplMinor)),
            tile('CAC', money(m.cacMinor)),
          ],
        },
      ],
      sources: ['OpenAI Ads — Insights API (delivery and cost)', 'docs/METRICS.md'],
      followUps: ['How is my pacing?', 'How many leads did I get?', 'Where are my leads coming from?'],
      windowDays,
    };
  }

  // -------------------------------------------------------------- overview
  return {
    intent: 'overview',
    headline: `${money(m.spendMinor)} spent → ${formatNumber(m.leads)} leads → ${formatNumber(m.customers)} customers → ${money(m.salesMinor)} revenue.`,
    subline: `Last ${windowDays} ${dayWord} at ${settings.orgName}. ${formatRatio(m.roas)} ROAS, ${money(m.cplMinor)} per lead, ${money(m.cacMinor)} per customer.`,
    tiles: [
      tile('Spend', money(m.spendMinor), { delta: dSpend }),
      tile('Leads', formatNumber(m.leads), { sub: `${money(m.cplMinor)} CPL` }),
      tile('Customers', formatNumber(m.customers), { sub: `${money(m.cacMinor)} CAC` }),
      tile('Revenue', money(m.salesMinor), { sub: `${formatRatio(m.roas)} ROAS` }),
    ],
    sections: [
      {
        kind: 'chart',
        title: 'Spend per day',
        metric: 'spend',
        note: topGroup ? `Largest ad group: ${topGroup.label}.` : undefined,
      },
      {
        kind: 'bars',
        title: 'Where the money goes',
        bars: byCampaign(dataset, filter)
          .slice(0, 5)
          .map((c) => ({
            label: c.label,
            display: formatMoney(c.spendMinor, settings.currency),
            share: c.spendMinor / (m.spendMinor || 1),
          })),
      },
      {
        kind: 'kpis',
        title: 'The funnel, in one line',
        tiles: [
          tile('Cost per lead', money(m.cplMinor)),
          tile('Lead → customer', formatPercent(m.leadToCustomer)),
          tile('Cost per customer', money(m.cacMinor)),
          tile('ROAS', formatRatio(m.roas)),
        ],
      },
    ],
    sources: ['OpenAI Ads — Insights API', 'First-party lead and order events'],
    followUps: [
      'How much did I spend this month?',
      'Where are my leads coming from?',
      'What is my ROAS?',
      'Which ad group has the best cost per lead?',
    ],
    windowDays,
  };
}

function cheapest(groups: GroupedMetrics[]): GroupedMetrics {
  const withLeads = groups.filter((g) => g.leads > 0);
  return (
    [...(withLeads.length ? withLeads : groups)].sort((a, b) => a.cplMinor - b.cplMinor)[0] ?? {
      ...emptyMetrics(),
      key: '—',
      label: '—',
    }
  );
}

function bestCac(groups: GroupedMetrics[]): GroupedMetrics {
  const withCustomers = groups.filter((g) => g.customers > 0);
  return (
    [...(withCustomers.length ? withCustomers : groups)].sort((a, b) => a.cacMinor - b.cacMinor)[0] ?? {
      ...emptyMetrics(),
      key: '—',
      label: '—',
    }
  );
}

function countryRows(groups: GroupedMetrics[], settings: Settings): string[][] {
  return groups.map((g) => [
    g.label,
    formatMoney(g.spendMinor, settings.currency),
    formatNumber(g.leads),
    formatMoney(g.cplMinor, settings.currency),
    formatMoney(g.cacMinor, settings.currency),
    formatRatio(g.roas),
  ]);
}

/** The examples shown under the search box. Kept here so they never drift from reality. */
export const SUGGESTIONS = [
  'How much did I spend this month?',
  'Where are my leads coming from?',
  'Which ad group has the best cost per lead?',
  'What is my ROAS?',
  'How is my pacing?',
  'Why do native and internal conversions differ?',
  'Help me research context hints',
];
