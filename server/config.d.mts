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
  connectors: {
    /** 32-byte AES key for sealing OAuth tokens, or null when no connector is configured. */
    encryptionKey: Buffer | null;
    /** Public origin of this API, used to reconstruct the URL a webhook signed. */
    publicBaseUrl: string | null;
    hubspot: {
      clientId: string | null;
      clientSecret: string | null;
      redirectUri: string | null;
      tokenPath: string;
      apiBase: string;
      scopesNote: string;
    };
  };
  storageMode: 'memory' | 'firestore';
  track: {
    origins: string[];
    requireOrigin: boolean;
    trustProxy: number;
    rateLimitPerMinute: number;
    maxBodyBytes: number;
  };
  /**
   * Private research (slice 1): a server-wide beta switch. Off unless an operator sets
   * PRIVATE_RESEARCH_ENABLED=true. There is no per-organization or per-workspace setting.
   */
  privateResearch: {
    enabled: boolean;
    /** Named providers only; a caller can never supply a host. */
    providers: string[];
    /** Fixed model allowlist per provider. */
    models: { openai: string[]; anthropic: string[] };
    timeoutMs: number;
    maxClusters: number;
    maxResponseBytes: number;
    perMinute: number;
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
