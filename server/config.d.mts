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
  opts?: { currentVersion?: string },
): { entries: ConsentSecret[]; currentVersion: string } | null;
export declare function resolveConfig(env?: Record<string, string | undefined>): ResolvedConfig;
