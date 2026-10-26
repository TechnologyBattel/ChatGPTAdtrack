// HTTP adapter. All routing lives in app.mjs; this file only translates between
// node:http and the transport-free handlers, and refuses to start in an unsafe
// configuration (see config.mjs for the rules themselves).

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ApiError } from './errors.mjs';
import { track } from './core.mjs';
import { createDatasetLoader } from './dataset.mjs';
import { createIngestVerifier } from './ingest.mjs';
import { createOutbox } from './outbox.mjs';
import { createAuth, createFirebaseVerifier, createAdminLoader, generateDevToken } from './auth.mjs';
import { createConsentService } from './consent.mjs';
import { createFirestoreStore, createMemoryStore } from './store.mjs';
import { createRateLimiter } from './limits.mjs';
import { createRequestListener } from './handler.mjs';
import { createApp } from './app.mjs';
import { createTenancy } from './tenancy.mjs';
import { createSources } from './sources.mjs';
import { createEventIngest } from './events-v2.mjs';
import { createAgencyApi } from './agency.mjs';
import { createHubSpotConnector } from './connectors/hubspot.mjs';
import { createConnectorRouter } from './connectors/router.mjs';
import { ConfigError, resolveConfig } from './config.mjs';

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

function fatal(message) {
  console.error(`[api] FATAL: ${message}`);
  process.exit(1);
}

let config;
try {
  config = resolveConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) fatal(error.message);
  throw error;
}

// ---------------------------------------------------------------- auth + store
const devToken = config.devToken || (config.authMode === 'dev' ? generateDevToken() : null);

let store;
if (config.storageMode === 'firestore') {
  // Only here is firebase-admin ever loaded, and only because both auth and
  // storage need the Admin SDK. It is an optionalDependency.
  const loadAdmin = createAdminLoader({ projectId: config.firebaseProjectId });
  try {
    const admin = await loadAdmin();
    store = createFirestoreStore({ firestore: admin.firestore() });
  } catch (error) {
    fatal(error instanceof ApiError ? error.message : String(error));
  }
} else {
  store = createMemoryStore();
}

const auth = createAuth({
  mode: config.authMode,
  devToken,
  devRole: config.devRole,
  verifyToken:
    config.authMode === 'firebase' ? createFirebaseVerifier({ projectId: config.firebaseProjectId }) : undefined,
});

const consent = createConsentService({
  secrets: config.consent.entries,
  currentVersion: config.consent.currentVersion,
  store,
  sessionTtlSeconds: config.consent.sessionTtlSeconds,
  consentTtlSeconds: config.consent.consentTtlSeconds,
});

const rateLimit = createRateLimiter({ limit: config.track.rateLimitPerMinute, windowMs: 60_000 });

// Server-to-server ingest is optional: without INGEST_KEYS the route fails closed.
const verifyIngest = config.ingest
  ? createIngestVerifier({ keys: config.ingest.keys, toleranceSeconds: config.ingest.toleranceSeconds })
  : null;

const env = {
  adsKey: config.keys.adsKey,
  capiKey: config.keys.capiKey,
  pixelId: config.keys.pixelId,
  accountTimezone: config.accountTimezone,
  adsBase: config.adsBase ?? undefined,
  eventsBase: config.eventsBase ?? undefined,
  trackOrigins: config.track.origins,
  requireOrigin: config.track.requireOrigin,
};

const buildDataset = createDatasetLoader({ env, firstPartySource: config.firstPartySource });

const outbox = createOutbox({
  store,
  consent,
  deliver: (event) => track(event, env),
  maxAttempts: config.outbox.maxAttempts,
  baseDelayMs: config.outbox.baseDelayMs,
  maxDelayMs: config.outbox.maxDelayMs,
  // A dead letter is a security-relevant record: an event the business believes it
  // reported was never delivered.
  onDeadLetter: async (entry, error) => {
    await store.audit.append({
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      action: 'deliver',
      adGroupId: '',
      before: [],
      after: [],
      actor: 'outbox',
      actorRole: 'system',
      ok: false,
      error: `${entry.eventName} ${entry.eventId}: ${error?.message ?? error}`,
      errorCode: error?.code ?? 'dead_letter',
      outboxId: entry.id,
    });
  },
});

// Tenancy, per-tenant source keys, the v2 event contract and the agency routes.
// All of them are built on the same store, so the memory and Firestore adapters stay
// the only two implementations of persistence in the product.
const tenancy = createTenancy({ store });
const sources = createSources({ store, tenancy });
const ingestV2 = createEventIngest({ store });
const agency = createAgencyApi({ tenancy, store, sources });

// ---------------------------------------------------------------- connectors
// The router always exists so the UI can ask for a status and be told, precisely, what
// is not configured. The SDK is only imported when the OAuth client actually exists,
// and the module is an optionalDependency — a deployment without HubSpot never loads it.
let clientFactory = () => {
  throw new Error('The HubSpot connector is not configured on this server.');
};
if (config.connectors.hubspot.clientId && config.connectors.encryptionKey) {
  const { createHubSpotSdkClientFactory } = await import('./connectors/hubspot-sdk.mjs');
  try {
    clientFactory = await createHubSpotSdkClientFactory({ basePath: config.connectors.hubspot.apiBase });
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
}

const hubspot = createHubSpotConnector({
  store,
  tenancy,
  encryptionKey: config.connectors.encryptionKey,
  oauth: {
    clientId: config.connectors.hubspot.clientId,
    clientSecret: config.connectors.hubspot.clientSecret,
    redirectUri: config.connectors.hubspot.redirectUri,
    tokenPath: config.connectors.hubspot.tokenPath,
    apiBase: config.connectors.hubspot.apiBase,
  },
  clientFactory,
  ingest: ingestV2,
});

const connectors = createConnectorRouter({ hubspot, publicBaseUrl: config.connectors.publicBaseUrl });

const app = createApp({
  env,
  auth,
  consent,
  store,
  outbox,
  rateLimit,
  dataset: buildDataset,
  verifyIngest,
  agency,
  sources,
  ingestV2,
  connectors,
});

// Transport rules live in handler.mjs so tests can mount them on a throwaway port.
const listener = createRequestListener({
  app,
  maxBodyBytes: config.track.maxBodyBytes,
  trustProxy: config.track.trustProxy,
});

if (config.connectors.hubspot.clientId) {
  console.log(`[api] connectors: hubspot OAuth client loaded (read-only scopes)`);
  if (!config.connectors.publicBaseUrl) {
    console.log('[api] connectors: PUBLIC_BASE_URL is unset, so HubSpot webhooks will be refused');
  }
}

const server = http.createServer((req, res) => {
  void listener(req, res);
});

// Retention sweep. Deliberately not "on every request": a purge is a bulk write, and
// doing it opportunistically would make latency depend on how much data happens to be
// expired. Runs once at startup and then on a long interval.
async function sweepRetention() {
  try {
    const result = await store.maintenance.purge();
    const removed = Object.entries(result.removed).filter(([, n]) => n > 0);
    if (removed.length) console.log(`[retention] purged ${removed.map(([k, n]) => `${k}=${n}`).join(' ')}`);
  } catch (error) {
    console.error(`[retention] sweep failed: ${error?.message ?? error}`);
  }
}

let retentionTimer = null;
if (config.retention.sweepEnabled) {
  retentionTimer = setInterval(() => void sweepRetention(), config.retention.sweepIntervalMs);
  retentionTimer.unref?.();
  void sweepRetention();
}

// Drain the outbox on a timer. unref() so a shutdown is not blocked by the timer.
let outboxTimer = null;
if (config.outbox.enabled) {
  outboxTimer = setInterval(() => {
    outbox.drain().catch((error) => console.error(`[outbox] drain failed: ${error?.message ?? error}`));
  }, config.outbox.intervalMs);
  outboxTimer.unref?.();
}

server.listen(config.apiPort, '0.0.0.0', () => {
  console.log(`[api] listening on 0.0.0.0:${config.apiPort} (${config.nodeEnv})`);
  console.log(`[api] auth: ${config.authMode}${config.authMode === 'dev' ? ` role=${config.devRole}` : ''}`);
  console.log(`[api] storage: ${store.kind}`);
  console.log(`[api] consent secrets: ${consent.secrets().join(', ')} (signing as ${consent.currentVersion})`);
  console.log(
    `[api] trust proxy: ${config.track.trustProxy} hop(s); origins: ${config.track.origins.join(', ') || 'none'}`,
  );
  console.log(`[api] mode: ${env.adsKey && env.pixelId ? 'live' : 'demo (no keys on server)'}`);
  console.log(
    `[api] tenancy: organizations + workspaces (${store.kind === 'memory' ? 'in-memory, not durable' : store.kind})`,
  );
  if (config.authMode === 'dev') {
    console.log('[api] WARNING: dev auth is enabled. POST /api/dev/session returns a write-role token.');
    console.log('[api] WARNING: dev auth and ad account keys are mutually exclusive by configuration.');
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (outboxTimer) clearInterval(outboxTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    server.close(() => process.exit(0));
  });
}
