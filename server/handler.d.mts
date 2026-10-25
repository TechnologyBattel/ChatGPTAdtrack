export declare const API_SECURITY_HEADERS: Record<string, string>;
export declare function createRequestListener(options: {
  app: { handle: (req: unknown) => Promise<{ status: number; body: unknown }> };
  maxBodyBytes?: number;
  trustProxy?: number;
  logger?: { error?: (message: string) => void };
}): (req: unknown, res: unknown) => Promise<void>;
