export declare const API_SECURITY_HEADERS: Record<string, string>;
export type ApiResult = { status: number; body: unknown; headers?: Record<string, string> };
export declare function createRequestListener(options: {
  app: { handle: (req: unknown) => Promise<ApiResult> };
  maxBodyBytes?: number;
  trustProxy?: number;
  logger?: { error?: (message: string) => void };
  /** Returns true while the process is draining; every request then gets 503 + close. */
  draining?: () => boolean;
}): (req: unknown, res: unknown) => Promise<void>;
