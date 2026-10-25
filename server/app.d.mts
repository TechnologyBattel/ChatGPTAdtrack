import type { AuthGate } from './auth.mjs';
import type { ConsentService } from './consent.mjs';
import type { Store } from './store.mjs';
import type { RateLimiter } from './limits.mjs';
import type { AgencyApi } from './agency.mjs';
import type { Sources } from './sources.mjs';
import type { EventIngest } from './events-v2.mjs';

export interface AppRequest {
  method?: string;
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string | undefined>;
  ip?: string;
  body?: Record<string, any>;
  /** Exact bytes received. Required by /api/events, whose signature covers them. */
  rawBody?: string;
}

export interface AppResult {
  status: number;
  body: Record<string, any>;
}

export interface App {
  handle(req?: AppRequest): Promise<AppResult>;
  invalidateCache(): void;
}

export declare function createApp(deps: {
  env?: Record<string, any>;
  auth: AuthGate;
  consent: ConsentService;
  store: Store;
  /** Tenancy/agency routes. Without it, `/api/orgs*` 404s rather than half-working. */
  agency?: AgencyApi | null;
  /** Per-tenant ingest key resolution. */
  sources?: Sources | null;
  /** Validates and persists v2 lead events. */
  ingestV2?: EventIngest | null;
  rateLimit?: RateLimiter;
  dataset?: (days: number, principal?: unknown) => Promise<unknown>;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  cacheMs?: number;
  now?: () => number;
}): App;
