// @vitest-environment node
//
// Configuration rules for the Phase-2 connectors.
//
// A half-configured OAuth client is worse than none: it would let an operator start a
// connection that can never complete, or store tokens under a key that is not there. Each
// case below pins one refusal, so the failure is a startup error rather than a surprise
// during someone's first sync.

import { describe, expect, it } from 'vitest';
import { ConfigError, resolveConfig } from '../../../server/config.mjs';

const KEY_HEX = 'a'.repeat(64);
const KEY_B64 = Buffer.alloc(32, 5).toString('base64');
const prodBase = {
  NODE_ENV: 'production',
  AUTH_MODE: 'firebase',
  FIREBASE_PROJECT_ID: 'proj',
  STORAGE: 'firestore',
  TRACK_ORIGINS: 'https://app.example',
  CONSENT_SECRETS: 'v1:prod-consent-secret-0123456789',
};

const hubspotEnv = {
  HUBSPOT_CLIENT_ID: 'client-id',
  HUBSPOT_CLIENT_SECRET: 'client-secret',
  HUBSPOT_REDIRECT_URI: 'https://api.example.com/oauth/callback',
};

describe('connector configuration', () => {
  it('is inert — not broken — when no connector is configured', () => {
    const config = resolveConfig({});
    expect(config.connectors.encryptionKey).toBeNull();
    expect(config.connectors.hubspot.clientId).toBeNull();
    expect(config.connectors.publicBaseUrl).toBeNull();
    // A default token endpoint is chosen, not invented per call.
    expect(config.connectors.hubspot.tokenPath).toBe('/oauth/2026-09/token');
  });

  it('accepts a 64-hex or a base64 encryption key', () => {
    expect(resolveConfig({ CONNECTOR_ENCRYPTION_KEY: KEY_HEX }).connectors.encryptionKey).toHaveLength(32);
    expect(resolveConfig({ CONNECTOR_ENCRYPTION_KEY: KEY_B64 }).connectors.encryptionKey).toHaveLength(32);
  });

  it('refuses an encryption key that is not 32 bytes', () => {
    expect(() => resolveConfig({ CONNECTOR_ENCRYPTION_KEY: 'too-short' })).toThrow(ConfigError);
    expect(() => resolveConfig({ CONNECTOR_ENCRYPTION_KEY: 'a'.repeat(40) })).toThrow(/32 bytes/);
  });

  it('refuses a partial OAuth client instead of starting half-configured', () => {
    expect(() => resolveConfig({ HUBSPOT_CLIENT_ID: 'client-id' })).toThrow(
      /HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET and HUBSPOT_REDIRECT_URI must be set together/,
    );
    expect(() => resolveConfig({ HUBSPOT_CLIENT_ID: 'client-id', HUBSPOT_CLIENT_SECRET: 'client-secret' })).toThrow(
      ConfigError,
    );
  });

  it('refuses an OAuth client with no key to seal the tokens it will receive', () => {
    expect(() => resolveConfig(hubspotEnv)).toThrow(/CONNECTOR_ENCRYPTION_KEY is required/);
    // With the key, the same configuration is accepted.
    expect(() => resolveConfig({ ...hubspotEnv, CONNECTOR_ENCRYPTION_KEY: KEY_HEX })).not.toThrow();
  });

  it('requires https for the redirect URI and a public origin for webhooks in production', () => {
    expect(() =>
      resolveConfig({
        ...prodBase,
        ...hubspotEnv,
        HUBSPOT_REDIRECT_URI: 'http://api.example.com/oauth/callback',
        CONNECTOR_ENCRYPTION_KEY: KEY_HEX,
        PUBLIC_BASE_URL: 'https://api.example.com',
      }),
    ).toThrow(/must use https in production/);

    expect(() => resolveConfig({ ...prodBase, ...hubspotEnv, CONNECTOR_ENCRYPTION_KEY: KEY_HEX })).toThrow(
      /PUBLIC_BASE_URL is required to receive HubSpot webhooks/,
    );
  });

  it('accepts an absolute PUBLIC_BASE_URL and rejects a relative one', () => {
    expect(
      resolveConfig({ ...hubspotEnv, CONNECTOR_ENCRYPTION_KEY: KEY_HEX, PUBLIC_BASE_URL: 'https://api.example.com' })
        .connectors.publicBaseUrl,
    ).toBe('https://api.example.com');
    expect(() => resolveConfig({ PUBLIC_BASE_URL: 'api.example.com' })).toThrow(/absolute http\(s\) origin/);
  });

  it('refuses a token path that is not a path', () => {
    expect(() =>
      resolveConfig({
        ...hubspotEnv,
        CONNECTOR_ENCRYPTION_KEY: KEY_HEX,
        HUBSPOT_TOKEN_PATH: 'https://evil.test/token',
      }),
    ).toThrow(/HUBSPOT_TOKEN_PATH/);
  });

  it('treats a whitespace-only value as unset', () => {
    const config = resolveConfig({ HUBSPOT_CLIENT_ID: '   ', CONNECTOR_ENCRYPTION_KEY: '  ' });
    expect(config.connectors.hubspot.clientId).toBeNull();
    expect(config.connectors.encryptionKey).toBeNull();
  });
});
