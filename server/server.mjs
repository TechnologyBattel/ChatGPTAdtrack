// HTTP adapter. All routing lives in app.mjs; this file only translates between
// node:http and the transport-free handlers, and refuses to start in an unsafe
// configuration.

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ApiError } from './errors.mjs';
import { configuration, fetchInsights, listAdGroups, listCampaigns, mapInsightsToDataset } from './core.mjs';
import { createAuth, createFirebaseVerifier, generateDevToken } from './auth.mjs';
import { createConsentStore } from './consent.mjs';
import { assertDeclaredSize, clientIp, createRateLimiter, parseAllowlist, readJsonBody } from './limits.mjs';
import { createApp } from './app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function loadEnvFile() {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}
loadEnvFile();

const NODE_ENV = process.env.NODE_ENV ?? 'development';
const isProduction = NODE_ENV === 'production';

// ---------------------------------------------------------------- auth mode
// Production must be explicit: an unset AUTH_MODE in NODE_ENV=production is a
// startup failure, not a silent downgrade to dev auth.
let authMode = process.env.AUTH_MODE;
if (!authMode) {
  if (isProduction) {
    console.error('[api] FATAL: AUTH_MODE must be "firebase" when NODE_ENV=production.');
    process.exit(1);
  }
  authMode = 'dev';
}
if (authMode === 'dev' && isProduction) {
  console.error('[api] FATAL: AUTH_MODE=dev is not allowed when NODE_ENV=production.');
  process.exit(1);
}

const devToken = process.env.DEV_AUTH_TOKEN || generateDevToken();
const devRole = process.env.DEV_AUTH_ROLE ?? 'owner';

const auth = createAuth({
  mode: authMode,
  devToken,
  devRole,
  verifyToken:
    authMode === 'firebase' ? createFirebaseVerifier({ projectId: process.env.FIREBASE_PROJECT_ID }) : undefined,
});

const consentSecret = process.env.CONSENT_SECRET || (isProduction ? '' : 'dev-only-consent-secret-change-me');
if (!consentSecret) {
  console.error('[api] FATAL: CONSENT_SECRET is required when NODE_ENV=production.');
  process.exit(1);
}
const consent = createConsentStore({
  secret: consentSecret,
  ttlSeconds: Number(process.env.CONSENT_TTL_SECONDS ?? 180 * 24 * 3600),
});

const rateLimit = createRateLimiter({
  limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60),
  windowMs: 60_000,
});

const env = {
  adsKey: process.env.OPENAI_ADS_API_KEY,
  capiKey: process.env.OPENAI_CONVERSIONS_API_KEY,
  pixelId: process.env.OPENAI_PIXEL_ID ?? process.env.VITE_OPENAI_PIXEL_ID,
  accountTimezone: process.env.ACCOUNT_TIMEZONE ?? 'Asia/Kolkata',
  adsBase: process.env.ADS_API_BASE,
  eventsBase: process.env.EVENTS_API_BASE,
  trackOrigins: parseAllowlist(process.env.TRACK_ORIGINS),
  requireOrigin: process.env.TRACK_REQUIRE_ORIGIN === 'true',
};

const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 256 * 1024);

async function buildDataset(days) {
  const [countryReport, deviceReport, campaigns] = await Promise.all([
    fetchInsights(env, { days, segment: 'country' }),
    fetchInsights(env, { days, segment: 'device' }),
    listCampaigns(env).catch(() => []),
  ]);

  const data = mapInsightsToDataset(countryReport, { firstPartyAvailable: Boolean(process.env.FIRST_PARTY_SOURCE) });
  const deviceData = mapInsightsToDataset(deviceReport);

  data.campaigns = data.campaigns.map((c) => {
    const raw = campaigns.find((x) => String(x.id) === c.id);
    return {
      ...c,
      name: String(raw?.name ?? c.name),
      objective:
        raw?.bidding_type === 'impressions' ? 'views' : raw?.objective === 'conversions' ? 'conversions' : 'clicks',
      status: raw?.status === 'active' ? 'active' : 'paused',
      dailyBudgetMinor:
        Number(raw?.budget?.daily_spend_limit_usd_micros ?? raw?.budget?.daily_spend_limit_micros ?? 0) / 10000,
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
}

const app = createApp({ env, auth, consent, rateLimit, dataset: buildDataset });

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  let url;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return send(400, { error: { code: 'bad_url', message: 'Malformed request URL.' } });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET,POST,OPTIONS' });
    return res.end();
  }

  try {
    let body = {};
    if (req.method === 'POST') {
      assertDeclaredSize(req.headers, MAX_BODY_BYTES);
      body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
    }
    const result = await app.handle({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      ip: clientIp(req.headers, req.socket?.remoteAddress),
      body,
    });
    return send(result.status, result.body);
  } catch (error) {
    const e = error instanceof ApiError ? error : new ApiError(500, 'internal_error', String(error));
    return send(e.status, { error: { code: e.code, message: e.message } });
  }
});

const PORT = Number(process.env.API_PORT ?? 8787);
server.listen(PORT, '0.0.0.0', () => {
  const config = configuration(env);
  console.log(`[api] listening on 0.0.0.0:${PORT} (${NODE_ENV})`);
  console.log(`[api] auth: ${authMode}${authMode === 'dev' ? ` role=${devRole}` : ''}`);
  console.log(`[api] mode: ${config.live ? 'live' : 'demo (no keys on server)'}`);
  if (authMode === 'dev') {
    console.log('[api] WARNING: dev auth is enabled. POST /api/dev/session returns a write-role token.');
  }
  if (env.trackOrigins.length === 0) {
    console.log('[api] WARNING: TRACK_ORIGINS is empty; cross-origin /api/track calls will be refused.');
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
