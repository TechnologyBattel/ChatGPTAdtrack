import type { HubSpotConnector } from './hubspot.mjs';

export interface ConnectorRouter {
  handle(input: {
    method: string;
    path: string;
    body?: Record<string, any>;
    headers?: Record<string, string | string[] | undefined>;
    rawBody?: string;
    principal?: { uid: string } | null;
  }): Promise<{ matched: boolean; status?: number; body?: any }>;
}

export declare function createConnectorRouter(options: {
  hubspot?: HubSpotConnector | null;
  publicBaseUrl?: string | null;
}): ConnectorRouter;
