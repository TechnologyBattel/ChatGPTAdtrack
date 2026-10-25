// @vitest-environment node
//
// Configuration rules. Everything here runs before the server binds a port: a
// violation must throw ConfigError, which server.mjs turns into process.exit(1).

import { describe, expect, it } from 'vitest';
import { ConfigError, parseConsentSecrets, resolveConfig } from '../../../server/config.mjs';

const SECRET = 'local-dev-consent-secret-1234';

/** A copy of env with one variable removed, used to test an absent setting. */
function without(env: Record<string, string>, key: string): Record<string, string> {
  const copy = { ...env };
  delete copy[key];
  return copy;
}

/** A minimal valid local environment. */
const base = (): Record<string, string> => ({
  NODE_ENV: 'development',
  AUTH_MODE: 'dev',
  DEV_AUTH_TOKEN: 'dev-token-value-1234567890',
  CONSENT_SECRETS: `v1:${SECRET}`,
});

describe('dev mode and account keys are mutually exclusive (gap 1)', () => {
  it.each(['OPENAI_ADS_API_KEY', 'OPENAI_CONVERSIONS_API_KEY', 'OPENAI_PIXEL_ID'])(
    'refuses AUTH_MODE=dev when %s is set',
    (key) => {
      const env = { ...base(), [key]: 'some-real-looking-value' };
      expect(() => resolveConfig(env)).toThrow(ConfigError);
      expect(() => resolveConfig(env)).toThrow(
        new RegExp(`AUTH_MODE=dev cannot be combined with real ad account keys \\(found ${key}\\)`),
      );
    },
  );

  it('names every offending key when more than one is set', () => {
    const env = { ...base(), OPENAI_ADS_API_KEY: 'a', OPENAI_PIXEL_ID: 'p' };
    expect(() => resolveConfig(env)).toThrow(/OPENAI_ADS_API_KEY, OPENAI_PIXEL_ID/);
  });

  it('treats a blank key as unset, so an empty .env line does not block dev', () => {
    const env = { ...base(), OPENAI_ADS_API_KEY: '   ', OPENAI_PIXEL_ID: '' };
    const config = resolveConfig(env);
    expect(config.keys.adsKey).toBeNull();
    expect(config.keys.pixelId).toBeNull();
    expect(config.authMode).toBe('dev');
  });

  it('allows the same keys with AUTH_MODE=firebase', () => {
    const config = resolveConfig({
      ...base(),
      AUTH_MODE: 'firebase',
      FIREBASE_PROJECT_ID: 'proj-1',
      STORAGE: 'firestore',
      TRACK_ORIGINS: 'https://app.example',
      OPENAI_ADS_API_KEY: 'a',
      OPENAI_PIXEL_ID: 'p',
    });
    expect(config.authMode).toBe('firebase');
    expect(config.storageMode).toBe('firestore');
    expect(config.keys.adsKey).toBe('a');
  });
});

describe('mode selection', () => {
  it('defaults to dev locally', () => {
    expect(resolveConfig({ NODE_ENV: 'development', CONSENT_SECRETS: `v1:${SECRET}` }).authMode).toBe('dev');
  });

  it('refuses an unset AUTH_MODE in production rather than guessing', () => {
    expect(() => resolveConfig({ NODE_ENV: 'production', CONSENT_SECRETS: `v1:${SECRET}` })).toThrow(
      /AUTH_MODE must be "firebase" when NODE_ENV=production/,
    );
  });

  it('refuses an unknown AUTH_MODE', () => {
    expect(() => resolveConfig({ ...base(), AUTH_MODE: 'open' })).toThrow(/Unsupported AUTH_MODE/);
  });

  it('refuses an unknown dev role', () => {
    expect(() => resolveConfig({ ...base(), DEV_AUTH_ROLE: 'root' })).toThrow(/DEV_AUTH_ROLE/);
  });

  it('accepts an absent DEV_AUTH_TOKEN and mints one at startup instead', () => {
    const config = resolveConfig(without(base(), 'DEV_AUTH_TOKEN'));
    // No token configured: config reports null, and server.mjs generates one so dev
    // auth is never anonymous. See createAuth's refusal of an empty dev token.
    expect(config.devToken).toBeNull();
  });
});

describe('production requirements', () => {
  const prod = () => ({
    NODE_ENV: 'production',
    AUTH_MODE: 'firebase',
    FIREBASE_PROJECT_ID: 'proj',
    STORAGE: 'firestore',
    TRACK_ORIGINS: 'https://app.example',
    CONSENT_SECRETS: `v1:${SECRET}`,
  });

  it('accepts a fully specified production environment', () => {
    const config = resolveConfig(prod());
    expect(config.authMode).toBe('firebase');
    expect(config.storageMode).toBe('firestore');
    expect(config.track.origins).toEqual(['https://app.example']);
  });

  it('refuses production with no TRACK_ORIGINS', () => {
    expect(() => resolveConfig(without(prod(), 'TRACK_ORIGINS'))).toThrow(/TRACK_ORIGINS/);
  });

  it('refuses production backed by the in-memory store', () => {
    expect(() => resolveConfig({ ...prod(), STORAGE: 'memory' })).toThrow(
      /STORAGE=memory is not allowed in production/,
    );
  });

  it('requires a project id for firestore', () => {
    expect(() => resolveConfig(without(prod(), 'FIREBASE_PROJECT_ID'))).toThrow(/FIREBASE_PROJECT_ID/);
  });
});

describe('numeric settings', () => {
  it('clamps nothing silently: out-of-range values are fatal', () => {
    expect(() => resolveConfig({ ...base(), TRUST_PROXY: '11' })).toThrow(/TRUST_PROXY/);
    expect(() => resolveConfig({ ...base(), TRUST_PROXY: '-1' })).toThrow(/TRUST_PROXY/);
    expect(() => resolveConfig({ ...base(), RATE_LIMIT_PER_MINUTE: '0' })).toThrow(/RATE_LIMIT_PER_MINUTE/);
    expect(() => resolveConfig({ ...base(), MAX_BODY_BYTES: 'abc' })).toThrow(/MAX_BODY_BYTES/);
  });

  it('defaults to trusting no proxy hop', () => {
    const config = resolveConfig(base());
    expect(config.track.trustProxy).toBe(0);
    expect(config.track.maxBodyBytes).toBe(262144);
    expect(config.consent.sessionTtlSeconds).toBe(1800);
    expect(config.consent.consentTtlSeconds).toBe(900);
  });

  it('reads TRUST_PROXY as a hop count (gap 3)', () => {
    expect(resolveConfig({ ...base(), TRUST_PROXY: '2' }).track.trustProxy).toBe(2);
  });
});

describe('consent secrets', () => {
  it('parses versioned secrets and signs with the newest by default', () => {
    const parsed = parseConsentSecrets(`v2:${SECRET}-two,v1:${SECRET}-one`)!;
    expect(parsed.entries.map((e) => e.version)).toEqual(['v2', 'v1']);
    expect(parsed.currentVersion).toBe('v2');
  });

  it('honours an explicit current version so rotation is ordered', () => {
    const parsed = parseConsentSecrets(`v2:${SECRET}-two,v1:${SECRET}-one`, { currentVersion: 'v1' })!;
    expect(parsed.currentVersion).toBe('v1');
  });

  it('refuses a current version that is not in the list', () => {
    expect(() => parseConsentSecrets(`v1:${SECRET}`, { currentVersion: 'v9' })).toThrow(
      /not present in CONSENT_SECRETS/,
    );
  });

  it('refuses duplicate versions and short secrets', () => {
    expect(() => parseConsentSecrets(`v1:${SECRET},v1:${SECRET}-again`)).toThrow(/Duplicate/);
    expect(() => parseConsentSecrets('v1:short')).toThrow(/at least 16/);
  });

  it('refuses an entry without a version prefix', () => {
    expect(() => parseConsentSecrets(SECRET)).toThrow(/look like "v1:secret"/);
  });

  it('falls back to the single legacy CONSENT_SECRET as v1', () => {
    const config = resolveConfig({ ...base(), CONSENT_SECRETS: '', CONSENT_SECRET: SECRET });
    expect(config.consent.currentVersion).toBe('v1');
    expect(config.consent.entries).toHaveLength(1);
  });

  it('refuses to start in production with no signing secret at all', () => {
    const env: Record<string, string> = {
      NODE_ENV: 'production',
      AUTH_MODE: 'firebase',
      FIREBASE_PROJECT_ID: 'proj',
      TRACK_ORIGINS: 'https://app.example',
    };
    expect(() => resolveConfig(env)).toThrow(/CONSENT_SECRETS/);
  });

  it('uses an obvious throwaway secret in dev, and says so', () => {
    const config = resolveConfig(without(base(), 'CONSENT_SECRETS'));
    expect(config.consent.currentVersion).toBe('v1');
    expect(config.consent.entries[0].secret).toMatch(/dev-only/);
  });
});

describe('ingest keys and the outbox (items 3 and 4)', () => {
  const INGEST = 'ingest-key-0123456789abcdef0123456789';

  it('has no ingest keys by default, so server-to-server events are refused', () => {
    const config = resolveConfig(base());
    expect(config.ingest).toBeNull();
  });

  it('parses versioned ingest keys and refuses a secret that is too short', () => {
    const config = resolveConfig({ ...base(), INGEST_KEYS: `v1:${INGEST}` });
    expect(config.ingest).toMatchObject({ keys: [{ version: 'v1', secret: INGEST }], currentVersion: 'v1' });
    // An ingest key can write revenue into an ad account, so 16 chars is not enough.
    expect(() => resolveConfig({ ...base(), INGEST_KEYS: 'v1:short-secret-16' })).toThrow(/Ingest key/);
    expect(() => resolveConfig({ ...base(), INGEST_KEYS: `v1:${INGEST}`, INGEST_KEY_VERSION: 'v9' })).toThrow(
      /INGEST_KEY_VERSION/,
    );
  });

  it('defaults the outbox to enabled with bounded backoff, and accepts an opt-out', () => {
    const config = resolveConfig(base());
    expect(config.outbox).toMatchObject({ enabled: true, maxAttempts: 6, baseDelayMs: 30_000, maxDelayMs: 1_800_000 });
    expect(resolveConfig({ ...base(), OUTBOX_ENABLED: 'false' }).outbox.enabled).toBe(false);
    expect(() => resolveConfig({ ...base(), OUTBOX_MAX_ATTEMPTS: '0' })).toThrow(/OUTBOX_MAX_ATTEMPTS/);
    expect(() => resolveConfig({ ...base(), OUTBOX_INTERVAL_MS: '10' })).toThrow(/OUTBOX_INTERVAL_MS/);
  });
});
