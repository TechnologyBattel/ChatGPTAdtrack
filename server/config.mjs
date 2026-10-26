// Configuration resolution and validation.
//
// Every rule that can be checked before the first request is checked here, and a
// violation throws ConfigError. server.mjs turns that into process.exit(1): a
// misconfigured server must never start and then discover the problem at request
// time.

import { parseEncryptionKey } from './connectors/crypto.mjs';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const SECRET_KEYS = ['OPENAI_ADS_API_KEY', 'OPENAI_CONVERSIONS_API_KEY', 'OPENAI_PIXEL_ID'];
// Must stay in step with server/auth.mjs ROLES: a role a token may carry is a role dev
// auth must be able to mint, or the two lists disagree about what a valid role is.
const VALID_ROLES = ['viewer', 'analyst', 'editor', 'admin', 'owner'];

function int(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, field = 'value' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${field} must be an integer between ${min} and ${max}, got "${value}".`);
  }
  return n;
}

/**
 * Parse `v2:secret,v1:older`. Rotation: sign with the current version, verify
 * with any listed version so ids issued before a rotation keep working.
 *
 * `minSecretLength` exists because a consent signing key and an ingest key have
 * different blast radii: 16 chars is fine for a 15-minute consent token, but an
 * ingest key can write revenue into an ad account, so it must be a real secret.
 */
export function parseConsentSecrets(
  raw,
  {
    currentVersion,
    minSecretLength = 16,
    field = 'Consent secret',
    variable = 'CONSENT_SECRETS',
    versionVariable = 'CONSENT_SECRET_VERSION',
  } = {},
) {
  const entries = String(raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(':');
      if (idx <= 0) throw new ConfigError(`${variable} entries must look like "v1:secret".`);
      const version = part.slice(0, idx).trim();
      const secret = part.slice(idx + 1).trim();
      if (!/^v\d+$/.test(version)) throw new ConfigError(`${field} version "${version}" must look like v1, v2, …`);
      if (secret.length < minSecretLength)
        throw new ConfigError(`${field} ${version} must be at least ${minSecretLength} characters.`);
      return { version, secret };
    });

  if (entries.length === 0) return null;
  const duplicates = entries.map((e) => e.version).filter((v, i, all) => all.indexOf(v) !== i);
  if (duplicates.length) throw new ConfigError(`Duplicate secret version: ${duplicates.join(', ')}`);

  const current = currentVersion ?? entries[0].version;
  if (!entries.some((e) => e.version === current)) {
    throw new ConfigError(`${versionVariable}=${current} is not present in ${variable}.`);
  }
  return { entries, currentVersion: current };
}

function splitList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function resolveConfig(env = {}) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  // ------------------------------------------------------------- auth mode
  let authMode = env.AUTH_MODE;
  if (!authMode) {
    if (isProduction) throw new ConfigError('AUTH_MODE must be "firebase" when NODE_ENV=production.');
    authMode = 'dev';
  }
  if (!['dev', 'firebase'].includes(authMode)) {
    throw new ConfigError(`Unsupported AUTH_MODE: ${authMode}. Use "dev" or "firebase".`);
  }
  if (authMode === 'dev' && isProduction) {
    throw new ConfigError('AUTH_MODE=dev is not allowed when NODE_ENV=production.');
  }

  const devRole = env.DEV_AUTH_ROLE ?? 'owner';
  if (!VALID_ROLES.includes(devRole)) {
    throw new ConfigError(`Unknown DEV_AUTH_ROLE: ${devRole}.`);
  }

  // ------------------------------------------------------------ ad account keys
  // Trim first: a whitespace-only value is an unset value, not a configured key.
  const trimmed = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const keys = {
    adsKey: trimmed(env.OPENAI_ADS_API_KEY),
    capiKey: trimmed(env.OPENAI_CONVERSIONS_API_KEY),
    pixelId: trimmed(env.OPENAI_PIXEL_ID) ?? trimmed(env.VITE_OPENAI_PIXEL_ID),
  };
  const configuredKeys = SECRET_KEYS.filter((name) => Boolean(trimmed(env[name])));

  /**
   * Dev auth means anyone who can reach POST /api/dev/session gets a write role.
   * Pointing that at a real ad account would let an unauthenticated caller rewrite
   * live context hints, so the combination is refused outright.
   */
  if (authMode === 'dev' && configuredKeys.length > 0) {
    throw new ConfigError(
      `AUTH_MODE=dev cannot be combined with real ad account keys (found ${configuredKeys.join(', ')}). ` +
        'Use AUTH_MODE=firebase for a live account, or unset the keys to run on demo data.',
    );
  }

  // --------------------------------------------------------------- consent keys
  let consentSecrets = parseConsentSecrets(env.CONSENT_SECRETS, {
    currentVersion: env.CONSENT_SECRET_VERSION || undefined,
  });
  if (!consentSecrets) {
    const single = env.CONSENT_SECRET;
    if (single) {
      if (single.length < 16) throw new ConfigError('CONSENT_SECRET must be at least 16 characters.');
      consentSecrets = { entries: [{ version: 'v1', secret: single }], currentVersion: 'v1' };
    } else if (isProduction) {
      throw new ConfigError('CONSENT_SECRETS (or CONSENT_SECRET) is required when NODE_ENV=production.');
    } else {
      consentSecrets = {
        entries: [{ version: 'v1', secret: 'dev-only-consent-secret-change-me' }],
        currentVersion: 'v1',
      };
    }
  }

  // ------------------------------------------------------------------- ingest
  // HMAC keys for POST /api/events (server-to-server). Separate from consent
  // secrets: different lifetime, different blast radius, different rotation.
  const ingest = parseConsentSecrets(env.INGEST_KEYS, {
    currentVersion: env.INGEST_KEY_VERSION || undefined,
    minSecretLength: 32,
    field: 'Ingest key',
    variable: 'INGEST_KEYS',
    versionVariable: 'INGEST_KEY_VERSION',
  });

  // ------------------------------------------------------------------ storage
  const storageMode = env.STORAGE ?? (isProduction ? 'firestore' : 'memory');
  if (!['memory', 'firestore'].includes(storageMode)) {
    throw new ConfigError(`Unsupported STORAGE: ${storageMode}. Use "memory" or "firestore".`);
  }
  if (isProduction && storageMode === 'memory') {
    throw new ConfigError(
      'STORAGE=memory is not allowed in production: consent replay protection and the audit log must survive a restart and be shared across instances.',
    );
  }
  if (storageMode === 'firestore') {
    if (!env.FIREBASE_PROJECT_ID) throw new ConfigError('STORAGE=firestore requires FIREBASE_PROJECT_ID.');
    if (authMode !== 'firebase') {
      throw new ConfigError('STORAGE=firestore requires AUTH_MODE=firebase (the Admin SDK is the Firestore client).');
    }
  }

  // -------------------------------------------------------------- track guards
  const trustProxy = int(env.TRUST_PROXY, 0, { min: 0, max: 10, field: 'TRUST_PROXY' });
  const origins = splitList(env.TRACK_ORIGINS);
  if (isProduction && origins.length === 0) {
    throw new ConfigError(
      'TRACK_ORIGINS must list the allowed origins in production; an empty allowlist refuses all cross-origin tracking.',
    );
  }

  // ------------------------------------------------------------- connectors
  // The HubSpot connector needs three things to be usable: the app's OAuth client, a
  // key to seal the tokens it receives, and a public origin so webhook signatures can be
  // verified against the URL HubSpot actually called. Any two without the third is a
  // half-configured integration, so it is refused here rather than failing later.
  let encryptionKey = null;
  const rawConnectorKey = trimmed(env.CONNECTOR_ENCRYPTION_KEY);
  if (rawConnectorKey) {
    try {
      encryptionKey = parseEncryptionKey(rawConnectorKey);
    } catch (error) {
      throw new ConfigError(error.message);
    }
  }

  const hubspot = {
    clientId: trimmed(env.HUBSPOT_CLIENT_ID),
    clientSecret: trimmed(env.HUBSPOT_CLIENT_SECRET),
    redirectUri: trimmed(env.HUBSPOT_REDIRECT_URI),
    tokenPath: trimmed(env.HUBSPOT_TOKEN_PATH) ?? '/oauth/2026-09/token',
    apiBase: trimmed(env.HUBSPOT_API_BASE) ?? 'https://api.hubapi.com',
  };
  const hubspotParts = [hubspot.clientId, hubspot.clientSecret, hubspot.redirectUri];
  if (hubspotParts.some(Boolean) && !hubspotParts.every(Boolean)) {
    throw new ConfigError('HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET and HUBSPOT_REDIRECT_URI must be set together.');
  }
  if (hubspot.clientId && !encryptionKey) {
    throw new ConfigError(
      'CONNECTOR_ENCRYPTION_KEY is required when a connector OAuth client is configured: tokens are stored sealed, never in plaintext.',
    );
  }
  if (isProduction && hubspot.redirectUri && !/^https:\/\//i.test(hubspot.redirectUri)) {
    throw new ConfigError('HUBSPOT_REDIRECT_URI must use https in production.');
  }
  if (!/^\//.test(hubspot.tokenPath)) {
    throw new ConfigError('HUBSPOT_TOKEN_PATH must be a path such as /oauth/2026-09/token.');
  }
  const publicBaseUrl = trimmed(env.PUBLIC_BASE_URL);
  if (publicBaseUrl && !/^https?:\/\/[^/]+/i.test(publicBaseUrl)) {
    throw new ConfigError('PUBLIC_BASE_URL must be an absolute http(s) origin, e.g. https://api.example.com.');
  }
  if (isProduction && hubspot.clientId && !publicBaseUrl) {
    throw new ConfigError(
      'PUBLIC_BASE_URL is required to receive HubSpot webhooks in production: the v3 signature covers the full URL.',
    );
  }

  return {
    nodeEnv,
    isProduction,
    authMode,
    devRole,
    devToken: env.DEV_AUTH_TOKEN || null,
    firebaseProjectId: env.FIREBASE_PROJECT_ID || null,
    keys,
    configuredKeyNames: configuredKeys,
    consent: {
      ...consentSecrets,
      sessionTtlSeconds: int(env.SESSION_TTL_SECONDS, 30 * 60, {
        min: 60,
        max: 24 * 3600,
        field: 'SESSION_TTL_SECONDS',
      }),
      consentTtlSeconds: int(env.CONSENT_TTL_SECONDS, 15 * 60, {
        min: 30,
        max: 24 * 3600,
        field: 'CONSENT_TTL_SECONDS',
      }),
    },
    storageMode,
    ingest: ingest
      ? {
          keys: ingest.entries,
          currentVersion: ingest.currentVersion,
          toleranceSeconds: int(env.INGEST_MAX_SKEW_SECONDS, 300, {
            min: 30,
            max: 3600,
            field: 'INGEST_MAX_SKEW_SECONDS',
          }),
        }
      : null,
    outbox: {
      enabled: env.OUTBOX_ENABLED !== 'false',
      intervalMs: int(env.OUTBOX_INTERVAL_MS, 30_000, { min: 1000, max: 600_000, field: 'OUTBOX_INTERVAL_MS' }),
      maxAttempts: int(env.OUTBOX_MAX_ATTEMPTS, 6, { min: 1, max: 50, field: 'OUTBOX_MAX_ATTEMPTS' }),
      baseDelayMs: int(env.OUTBOX_BASE_DELAY_MS, 30_000, { min: 1000, max: 3_600_000, field: 'OUTBOX_BASE_DELAY_MS' }),
      maxDelayMs: int(env.OUTBOX_MAX_DELAY_MS, 30 * 60_000, {
        min: 1000,
        max: 24 * 3_600_000,
        field: 'OUTBOX_MAX_DELAY_MS',
      }),
    },
    // Retention: how often expired events and leads are purged. The policy itself
    // (13 months for events, 25 for leads) lives with the store, because it is a
    // property of the data, not of the deployment.
    retention: {
      sweepEnabled: env.RETENTION_SWEEP !== 'false',
      sweepIntervalMs: int(env.RETENTION_SWEEP_INTERVAL_MS, 6 * 60 * 60 * 1000, {
        min: 60_000,
        max: 7 * 24 * 60 * 60 * 1000,
        field: 'RETENTION_SWEEP_INTERVAL_MS',
      }),
    },
    track: {
      origins,
      requireOrigin: env.TRACK_REQUIRE_ORIGIN === 'true',
      trustProxy,
      rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 60, { min: 1, max: 100000, field: 'RATE_LIMIT_PER_MINUTE' }),
      maxBodyBytes: int(env.MAX_BODY_BYTES, 256 * 1024, { min: 1024, max: 16 * 1024 * 1024, field: 'MAX_BODY_BYTES' }),
    },
    connectors: {
      encryptionKey,
      publicBaseUrl,
      hubspot: {
        ...hubspot,
        // Deliveries accepted per source per minute before answering 429. 0 disables the
        // limiter, which is only reasonable in a single-tenant dev install.
        webhookPerMinute: int(env.HUBSPOT_WEBHOOK_PER_MINUTE, 120, {
          min: 0,
          max: 100000,
          field: 'HUBSPOT_WEBHOOK_PER_MINUTE',
        }),
        scopesNote: 'read-only: crm.objects.contacts.read, crm.objects.deals.read',
      },
    },
    shutdown: {
      // How long in-flight requests get after SIGTERM before the process stops waiting.
      // Longer than the slowest provider call we accept (token exchange times out at 10s),
      // shorter than the default container stop grace period (30s) so the platform's
      // SIGKILL is never what ends a request.
      timeoutMs: int(env.SHUTDOWN_TIMEOUT_MS, 15000, { min: 1000, max: 120000, field: 'SHUTDOWN_TIMEOUT_MS' }),
    },
    accountTimezone: env.ACCOUNT_TIMEZONE ?? 'Asia/Kolkata',
    firstPartySource: env.FIRST_PARTY_SOURCE || null,
    adsBase: env.ADS_API_BASE || null,
    eventsBase: env.EVENTS_API_BASE || null,
    apiPort: int(env.API_PORT, 8787, { min: 1, max: 65535, field: 'API_PORT' }),
  };
}
