// Builds the dataset the UI renders, from Ads API insights.
//
// Split out of server.mjs so the e2e check can mount the same loader without
// starting the real process (the e2e uses dev auth against a stub upstream, a
// combination the startup guard deliberately forbids for server.mjs itself).

import { fetchInsights, listAdGroups, listCampaigns, mapInsightsToDataset } from './core.mjs';

export function createDatasetLoader({ env, firstPartySource = null }) {
  return async function buildDataset(days) {
    const [countryReport, deviceReport, campaigns] = await Promise.all([
      fetchInsights(env, { days, segment: 'country' }),
      fetchInsights(env, { days, segment: 'device' }),
      listCampaigns(env).catch(() => []),
    ]);

    const data = mapInsightsToDataset(countryReport, { firstPartyAvailable: Boolean(firstPartySource) });
    const deviceData = mapInsightsToDataset(deviceReport);

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
    data.adGroups = lists.flat().map((g) => ({
      id: String(g.id),
      campaignId: String(g.campaign_id ?? ''),
      name: String(g.name ?? g.id),
      theme: 'from Ads API',
      hints: Array.isArray(g.context_hints) ? g.context_hints : [],
      landingPath: '',
    }));

    data.segments = { device: deviceData.rows };
    data.timezone = countryReport.timezone;
    return data;
  };
}
