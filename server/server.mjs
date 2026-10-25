// HTTP adapter. All routing lives in app.mjs; this file only translates between
// node:http and the transport-free handlers, and refuses to start in an unsafe
// configuration (see config.mjs for the rules themselves).

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ApiError } from './errors.mjs';
import { createDatasetLoader } from './dataset.mjs';
import { createAuth, createFirebaseVerifier, createAdminLoader, generateDevToken } from './auth.mjs';
import { createConsentService } from './consent.mjs';
import { createFirestoreStore, createMemoryStore } from './store.mjs';
import { createRateLimiter } from './limits.mjs';
import { createRequestListener } from './handler.mjs';
import { createApp } from './app.mjs';
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

const app = createApp({ env, auth, consent, store, rateLimit, dataset: buildDataset });

// Transport rules live in handler.mjs so tests can mount them on a throwaway port.
const listener = createRequestListener({
  app,
  maxBodyBytes: config.track.maxBodyBytes,
  trustProxy: config.track.trustProxy,
});

const server = http.createServer((req, res) => {
  void listener(req, res);
});

server.listen(config.apiPort, '0.0.0.0', () => {
  console.log(`[api] listening on 0.0.0.0:${config.apiPort} (${config.nodeEnv})`);
  console.log(`[api] auth: ${config.authMode}${config.authMode === 'dev' ? ` role=${config.devRole}` : ''}`);
  console.log(`[api] storage: ${store.kind}`);
  console.log(`[api] consent secrets: ${consent.secrets().join(', ')} (signing as ${consent.currentVersion})`);
  console.log(
    `[api] trust proxy: ${config.track.trustProxy} hop(s); origins: ${config.track.origins.join(', ') || 'none'}`,
  );
  console.log(`[api] mode: ${env.adsKey && env.pixelId ? 'live' : 'demo (no keys on server)'}`);
  if (config.authMode === 'dev') {
    console.log('[api] WARNING: dev auth is enabled. POST /api/dev/session returns a write-role token.');
    console.log('[api] WARNING: dev auth and ad account keys are mutually exclusive by configuration.');
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
