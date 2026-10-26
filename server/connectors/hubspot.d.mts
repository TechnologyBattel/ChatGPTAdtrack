import type { Store } from '../store.mjs';
import type { Tenancy } from '../tenancy.mjs';

export declare const CONNECTOR_PROVIDER: 'hubspot';
export declare const HUBSPOT_SCOPES: string[];
export declare const CONNECTOR_STATUSES: string[];
export declare function classifyProviderError(error: unknown): {
  code: string;
  retryable: boolean;
  kind: string;
};
export declare function redactError(error: unknown): string;

export interface HubSpotStatus {
  provider: 'hubspot';
  configured: boolean;
  missingConfig: string[];
  status: string;
  connected: boolean;
  sourceConnectionId: string | null;
  trustedForQualification: boolean;
  scopesGranted: string[];
  portalId: string | null;
  lastSyncAt: number | null;
  lastSyncStatus: string | null;
  lastSync: Record<string, any> | null;
  checkpoint: Record<string, any> | null;
  lastError: { code: string; message: string; at: number | null } | null;
  qualifiedStages: string[];
  nextAction: string;
}

export interface HubSpotSyncResult {
  status: string;
  lastSyncStatus: string;
  partial: boolean;
  trigger: string;
  startedAt: number;
  finishedAt: number;
  imported: number;
  duplicates: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  pages: number;
  countsSemantics: string;
  error: { code: string; message: string } | null;
  connection: HubSpotStatus;
}

export interface HubSpotConnector {
  configured: boolean;
  missingConfig: string[];
  scopes: string[];
  status(input: { principal: { uid: string }; organizationId: string; workspaceId: string }): Promise<HubSpotStatus>;
  connectStart(input: {
    principal: { uid: string };
    organizationId: string;
    workspaceId: string;
    body?: Record<string, any>;
  }): Promise<{ authorizationUrl: string; state: string; status: string }>;
  connectComplete(input: {
    principal: { uid: string };
    organizationId: string;
    workspaceId: string;
    body: { code: string; state: string };
  }): Promise<{ status: string }>;
  sync(input: {
    principal: { uid: string };
    organizationId: string;
    workspaceId: string;
    trigger?: string;
    signal?: AbortSignal;
  }): Promise<HubSpotSyncResult>;
  disconnect(input: {
    principal: { uid: string };
    organizationId: string;
    workspaceId: string;
  }): Promise<{ status: string; disconnected: boolean }>;
  webhook(input: {
    organizationId: string;
    sourceConnectionId: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    method?: string;
    url: string;
  }): Promise<{ received: number; imported: number; duplicates: number; skipped: number }>;
}

export declare function createHubSpotConnector(options: {
  store: Store;
  tenancy: Tenancy;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  encryptionKey?: Buffer | null;
  oauth?: Record<string, any>;
  clientFactory?: (accessToken: string) => any;
  limits?: Record<string, number>;
  ingest?: any;
}): HubSpotConnector;
