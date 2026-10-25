// Builds the dataset the UI renders, from Ads API insights.
//
// Three reports, deliberately separate so totals are never double counted:
//   campaign  — the authoritative spend/clicks/impressions rows (no ad group)
//   ad_group  — the same window at ad-group granularity, for ad-group views only
//   segments  — one country report and one device report, each one segment per
//               request (the API rejects two segments in one call)
//
// The ad-group report is what used to be faked: the campaign report has no ad group
// id, and the mapper fell back to the campaign id, which made every campaign look
// like a single ad group. `adGroupRows` carries the real breakdown; `rows` stays at
// campaign level so a headline total is never the sum of two granularities.
//
// Split out of server.mjs so the e2e check can mount the same loader without
// starting the real process (the e2e uses dev auth against a stub upstream, a
// combination the startup guard deliberately forbids for server.mjs itself).

import { fetchInsights, listAdGroups, listCampaigns, mapInsightsToDataset } from './core.mjs';

export function createDatasetLoader({ env, firstPartySource = null }) {
  return async function buildDataset(days) {
    const [campaignReport, deviceReport, campaigns] = await Promise.all([
      fetchInsights(env, { days }),
      fetchInsights(env, { days, segment: 'device' }),
      listCampaigns(env).catch(() => []),
    ]);

    // Ad-group granularity is a separate call. If the account has no ad groups (or
    // the report fails) the answer keeps saying so instead of inventing groups.
    const [adGroupReport, countryReport] = await Promise.all([
      fetchInsights(env, { days, aggregation: 'ad_group' }).catch(() => ({
        rows: [],
        currency: campaignReport.currency,
      })),
      fetchInsights(env, { days, segment: 'country' }).catch(() => ({ rows: [], currency: campaignReport.currency })),
    ]);

    // `rows` come from the country-segmented report, exactly as before: the segment
    // is what makes geography answerable, and one segment per request means the
    // totals still add up. If that report is empty, fall back to the plain one.
    const baseReport = countryReport.rows.length ? countryReport : campaignReport;
    const data = mapInsightsToDataset(baseReport, {
      firstPartyAvailable: Boolean(firstPartySource),
      aggregation: 'campaign',
    });
    const deviceData = mapInsightsToDataset(deviceReport);
    const adGroupData = mapInsightsToDataset(adGroupReport, { aggregation: 'ad_group' });

    data.campaigns = data.campaigns.map((c) => {
      const raw = campaigns.find((x) => String(x.id) === c.id);
      return {
        ...c,
        name: String(raw?.name ?? c.name),
        objective:
          raw?.bidding_type === 'impressions' ? 'views' : raw?.objective === 'conversions' ? 'conversions' : 'clicks',
        status: raw?.status === 'active' ? 'active' : 'paused',
        dailyBudgetMinor: Number(raw?.budget?.daily_spend_limit_micros ?? 0) / 10000,
      };
    });

    const lists = await Promise.all(data.campaigns.slice(0, 20).map((c) => listAdGroups(env, c.id).catch(() => [])));
    const adGroups = lists.flat().map((g) => ({
      id: String(g.id),
      campaignId: String(g.campaign_id ?? ''),
      name: String(g.name ?? g.id),
      theme: 'from Ads API',
      hints: Array.isArray(g.context_hints) ? g.context_hints : [],
      landingPath: '',
    }));
    data.adGroups = adGroups;

    // Ad-group rows without a campaign id: resolve it from the ad-group list rather
    // than leaving the row unattributable.
    const campaignOf = new Map(adGroups.map((g) => [g.id, g.campaignId]));
    data.adGroupRows = adGroupData.rows.map((r) => ({
      ...r,
      campaignId: r.campaignId || campaignOf.get(r.adGroupId) || '',
    }));

    data.segments = { device: deviceData.rows };
    data.timezone = baseReport.timezone ?? campaignReport.timezone;
    return data;
  };
}
