import type { Store } from './store.mjs';
import type { Tenancy } from './tenancy.mjs';

export declare const RESEARCH_GOALS: string[];
export declare const RESEARCH_GOAL_LABELS: Record<string, string>;

export type ResearchGoal = 'attribution' | 'lead_data' | 'topics' | 'sources';
/** `observed` is measured; `no_data` and `unavailable` are answers, not zeros. */
export type DataState = 'observed' | 'no_data' | 'unavailable';

export interface ResearchFinding {
  id: string;
  severity: 'gap' | 'attention' | 'info';
  topics: ResearchGoal[];
  title: string;
  summary: string;
  evidence: { label: string; value: string | number; detail: string | null }[];
  limitations: string[];
  action?: { label: string; kind: string };
}

export interface ResearchReport {
  version: number;
  goal: ResearchGoal;
  goalLabel: string;
  generatedAt: number;
  workspace: {
    workspaceId: string;
    name: string;
    clientName: string | null;
    currency: string;
    timeZone: string;
    targetMarkets: { countryCode: string | null; region: string | null; city: string | null }[];
  };
  window: {
    firstEventAt: number | null;
    lastEventAt: number | null;
    dataFreshness: 'none' | 'fresh' | 'aging' | 'stale';
    currency: string;
    timeZone: string;
  };
  counts: Record<string, number>;
  /** Collections whose totals are minimums because the read hit the store row cap. */
  countsAreLowerBound: string[];
  dataStates: Record<string, DataState>;
  permissions: string[];
  findings: ResearchFinding[];
  limitations: string[];
  nextActions: { findingId: string; label: string; kind: string }[];
}

export interface ResearchRun {
  runId: string;
  organizationId: string;
  workspaceId: string;
  goal: ResearchGoal;
  note: string | null;
  report: ResearchReport;
  version: number;
  createdBy: string;
  createdAt: number;
}

export interface ResearchRunSummary {
  runId: string;
  workspaceId: string;
  goal: ResearchGoal;
  note: string | null;
  createdAt: number;
  createdBy: string;
  findings: number;
  summary: string | null;
}

export interface ResearchPlan {
  goals: { id: ResearchGoal; label: string }[];
  steps: { id: string; label: string; detail: string; request: string }[];
}

export declare function researchPlan(): ResearchPlan;

export declare function buildResearchReport(input: {
  workspace: Record<string, any> & { workspaceId: string; currency: string; timeZone: string };
  sources?: Record<string, any>[];
  campaigns?: Record<string, any>[];
  topics?: Record<string, any>[];
  leads?: Record<string, any>[];
  events?: Record<string, any>[];
  permissions?: string[];
  goal?: ResearchGoal;
  now?: () => number;
  /** Collections whose read was capped; their totals are reported as lower bounds. */
  truncated?: string[];
}): ResearchReport;

export interface ResearchApi {
  plan(input: { principal: { uid: string }; organizationId: string; workspaceId: string }): Promise<ResearchPlan>;
  create(input: {
    principal: { uid: string };
    organizationId: string;
    workspaceId: string;
    /** Extra fields are accepted and ignored: a caller cannot assert its own report. */
    body?: Record<string, any>;
  }): Promise<ResearchRun>;
  list(input: {
    principal: { uid: string };
    organizationId: string;
    workspaceId: string;
    query?: { limit?: number };
  }): Promise<ResearchRunSummary[]>;
  get(input: {
    principal: { uid: string };
    organizationId: string;
    workspaceId: string;
    runId: string;
  }): Promise<ResearchRun>;
  remove(input: {
    principal: { uid: string };
    organizationId: string;
    workspaceId: string;
    runId: string;
  }): Promise<{ runId: string; deleted: boolean }>;
  buildReport: typeof buildResearchReport;
}

export declare function createResearch(options: {
  store: Store;
  tenancy: Tenancy;
  now?: () => number;
  /** Rows one aggregate query may read. Exceeding it turns totals into lower bounds. */
  aggregateLimit?: number;
}): ResearchApi;
