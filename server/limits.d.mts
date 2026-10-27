export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}
export interface RateLimiter {
  hit(key: string): RateLimitResult;
  size(): number;
}
export declare const DEFAULT_MAX_BODY_BYTES: number;
export declare function readJsonBodyWithRaw(
  stream: AsyncIterable<Uint8Array | Buffer>,
  opts?: { maxBytes?: number },
): Promise<{ body: Record<string, unknown>; raw: string }>;
export declare function readJsonBody(
  stream: AsyncIterable<Uint8Array | Buffer>,
  opts?: { maxBytes?: number },
): Promise<Record<string, unknown>>;
export declare function assertDeclaredSize(headers?: Record<string, string | undefined>, maxBytes?: number): void;
export declare function createRateLimiter(opts?: {
  limit?: number;
  windowMs?: number;
  now?: () => number;
}): RateLimiter;
export declare function clientIp(
  headers?: Record<string, string | undefined>,
  socketAddress?: string,
  opts?: { trustProxy?: number },
): string;
export declare function assertOrigin(
  headers?: Record<string, string | undefined>,
  allowlist?: string[],
  opts?: { requireOrigin?: boolean },
): { origin: string | null };
export declare function parseAllowlist(raw?: string): string[];
