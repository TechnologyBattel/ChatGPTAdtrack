export interface PrivateResearchConfig {
  enabled: boolean;
  providers: string[];
  models: { openai: string[]; anthropic: string[] };
  timeoutMs: number;
  maxClusters: number;
  maxResponseBytes: number;
  perMinute: number;
}

export interface PrivateCluster {
  id: string;
  label?: string;
  seeds: string[];
}

export interface PrivateName {
  id: string;
  name: string;
}

export interface AuditDetailInput {
  provider: 'openai' | 'anthropic';
  model: string;
  clusterCount: number;
  outcome: 'ok' | 'provider_error' | 'invalid_output' | 'timeout' | 'rejected';
  errorCode?: string;
}

export interface AuditDetail {
  provider: 'openai' | 'anthropic';
  model: string;
  clusterCount: number;
  outcome: AuditDetailInput['outcome'];
  errorCode?: string;
}

export declare const PRIVATE_PATH: RegExp;
export declare const PRIVATE_ERROR_CODES: readonly string[];

export declare function auditDetail(input: AuditDetailInput): AuditDetail;

export interface PrivateResearch {
  readonly enabled: boolean;
  readonly models: { openai: string[]; anthropic: string[] };
  status(): { enabled: true; providers: string[] };
  run(input: {
    actor?: string;
    provider?: string;
    model?: string;
    apiKey?: string;
    clusters?: PrivateCluster[];
  }): Promise<{ names: PrivateName[]; provider: string; model: string }>;
  auditDetail(input: AuditDetailInput): AuditDetail;
}

export declare function createPrivateResearch(
  options?: Partial<PrivateResearchConfig> & {
    fetchImpl?: typeof fetch | null;
    now?: () => number;
  },
): PrivateResearch;
