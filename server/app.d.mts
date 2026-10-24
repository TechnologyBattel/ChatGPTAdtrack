import type { AuthGate } from './auth.mjs';
import type { ConsentStore } from './consent.mjs';
import type { RateLimiter } from './limits.mjs';

export interface AppRequest {
  method?: string;
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string | undefined>;
  ip?: string;
  body?: Record<string, any>;
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
  consent: ConsentStore;
  rateLimit?: RateLimiter;
  dataset?: (days: number, principal?: unknown) => Promise<unknown>;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  cacheMs?: number;
  now?: () => number;
}): App;
