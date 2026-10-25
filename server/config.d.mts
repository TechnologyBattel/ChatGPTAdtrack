export declare class ConfigError extends Error {}

export interface ConsentSecret {
  version: string;
  secret: string;
}

export interface ResolvedConfig {
  nodeEnv: string;
  isProduction: boolean;
  authMode: 'dev' | 'firebase';
  devRole: 'viewer' | 'analyst' | 'admin' | 'owner';
  devToken: string | null;
  firebaseProjectId: string | null;
  keys: { adsKey: string | null; capiKey: string | null; pixelId: string | null };
  configuredKeyNames: string[];
  consent: {
    entries: ConsentSecret[];
    currentVersion: string;
    sessionTtlSeconds: number;
    consentTtlSeconds: number;
  };
  /** Server-to-server ingest keys (POST /api/events). Null when unconfigured. */
  ingest: {
    keys: ConsentSecret[];
    currentVersion: string;
    toleranceSeconds: number;
  } | null;
  /** Retry queue for events the upstream refused for a retryable reason. */
  outbox: {
    enabled: boolean;
    intervalMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  /** Retention sweeps: whether they run, and how often. The policy is in the store. */
  retention: {
    sweepEnabled: boolean;
    sweepIntervalMs: number;
  };
  storageMode: 'memory' | 'firestore';
  track: {
    origins: string[];
    requireOrigin: boolean;
    trustProxy: number;
    rateLimitPerMinute: number;
    maxBodyBytes: number;
  };
  accountTimezone: string;
  firstPartySource: string | null;
  adsBase: string | null;
  eventsBase: string | null;
  apiPort: number;
}

export declare function parseConsentSecrets(
  raw: string | undefined,
  opts?: {
    currentVersion?: string;
    minSecretLength?: number;
    /** Human-readable secret name used in error messages, e.g. "Ingest key". */
    field?: string;
    /** Environment variable named in error messages, e.g. "INGEST_KEYS". */
    variable?: string;
    /** Version variable named in error messages, e.g. "INGEST_KEY_VERSION". */
    versionVariable?: string;
  },
): { entries: ConsentSecret[]; currentVersion: string } | null;
export declare function resolveConfig(env?: Record<string, string | undefined>): ResolvedConfig;
