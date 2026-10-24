// Local API server for development and the live preview.
// The browser only ever talks to this process; the keys stay here.
// Binds 0.0.0.0 so the preview proxy can reach it.

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ApiError,
  configuration,
  fetchInsights,
  health,
  listCampaigns,
  listAdGroups,
  mapInsightsToDataset,
  pushHintSet,
  track,
} from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = Number(process.env.API_PORT ?? 8787);

// Minimal .env loader: no dependency, and secrets never leave this process.
function loadEnv() {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}
loadEnv();

const env = {
  adsKey: process.env.OPENAI_ADS_API_KEY,
  capiKey: process.env.OPENAI_CONVERSIONS_API_KEY,
  pixelId: process.env.OPENAI_PIXEL_ID ?? process.env.VITE_OPENAI_PIXEL_ID,
  accountTimezone: process.env.ACCOUNT_TIMEZONE ?? 'Asia/Kolkata',
  // Test-only overrides: point the same handlers at a local stub.
  adsBase: process.env.ADS_API_BASE,
  eventsBase: process.env.EVENTS_API_BASE,
};

const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, data: null };

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new ApiError(413, 'payload_too_large', 'Body over 1 MB.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'bad_json', 'Body is not valid JSON.');
  }
}

/** Live dataset: campaign x country per day, plus a separate device report. */
async function buildLiveDataset(days) {
  const [countryReport, deviceReport, campaigns] = await Promise.all([
    fetchInsights(env, { days, segment: 'country' }),
    fetchInsights(env, { days, segment: 'device' }),
    listCampaigns(env).catch(() => []),
  ]);

  const dataset = mapInsightsToDataset(countryReport, { firstPartyAvailable: Boolean(process.env.FIRST_PARTY_SOURCE) });
  const deviceDataset = mapInsightsToDataset(deviceReport);

  const names = new Map(campaigns.map((c) => [String(c.id), String(c.name ?? c.id)]));
  dataset.campaigns = dataset.campaigns.map((c) => {
    const raw = campaigns.find((x) => String(x.id) === c.id);
    return {
      ...c,
      name: names.get(c.id) ?? c.name,
      objective: raw?.bidding_type === 'impressions' ? 'views' : raw?.objective === 'conversions' ? 'conversions' : 'clicks',
      status: raw?.status === 'active' ? 'active' : 'paused',
      dailyBudgetMinor: Number(raw?.budget?.daily_spend_limit_micros ?? 0) / 10000,
    };
  });

  const adGroupLists = await Promise.all(
    dataset.campaigns.slice(0, 20).map((c) => listAdGroups(env, c.id).catch(() => [])),
  );
  dataset.adGroups = adGroupLists
    .flat()
    .map((g) => ({
      id: String(g.id),
      campaignId: String(g.campaign_id ?? ''),
      name: String(g.name ?? g.id),
      theme: 'from Ads API',
      hints: g.context_hints ?? [],
      landingPath: '',
    }));

  dataset.segments = { device: deviceDataset.rows };
  dataset.timezone = countryReport.timezone;
  return dataset;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET,POST,OPTIONS' });
    res.end();
    return;
  }

  try {
    if (path === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ...(await health(env)), configuration: configuration(env) });
    }

    if (path === '/api/dataset' && req.method === 'GET') {
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 90)));
      const now = Date.now();
      if (cache.data && now - cache.at < CACHE_MS) return json(res, 200, cache.data);
      if (!configuration(env).live) {
        return json(res, 200, { mode: 'demo', reason: 'No keys configured on the server.' });
      }
      const dataset = await buildLiveDataset(days);
      cache = { at: now, data: { mode: 'live', dataset } };
      return json(res, 200, cache.data);
    }

    if (path === '/api/track' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await track(body, env);
      return json(res, 202, result);
    }

    const push = /^\/api\/adgroups\/([^/]+)\/hints$/.exec(path);
    if (push && req.method === 'POST') {
      const body = await readBody(req);
      const result = await pushHintSet(decodeURIComponent(push[1]), body.hints ?? [], env);
      return json(res, 200, result);
    }

    return json(res, 404, { error: { code: 'not_found', message: `No route for ${req.method} ${path}` } });
  } catch (error) {
    const e = error instanceof ApiError ? error : new ApiError(500, 'internal_error', String(error));
    const status = e.status >= 400 && e.status < 600 ? e.status : 500;
    return json(res, status, { error: { code: e.code, message: e.message } });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const config = configuration(env);
  console.log(`[api] listening on 0.0.0.0:${PORT}`);
  console.log(`[api] mode: ${config.live ? 'live' : 'demo (no keys on server)'}`);
  console.log(`[api] ads key: ${config.adsKey ? 'configured' : 'missing'} · capi: ${config.capiKey ? 'configured' : 'missing'} · pixel: ${config.pixelId ? 'configured' : 'missing'}`);
});
