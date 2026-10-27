import type { IngestKeyRecord } from './sources.mjs';

export declare const EVENT_SCHEMA_VERSION: 2;
export declare const EVENT_TYPES: string[];
export declare const LEAD_EVENT_TYPES: Set<string>;
export declare const MONEY_EVENT_TYPES: Set<string>;
export declare const SERVER_ONLY_EVENT_TYPES: Set<string>;
export declare const DEFAULT_ATTRIBUTION_WINDOW_DAYS: number;

export interface NormalizedEvent {
  schemaVersion: 2;
  eventId: string;
  eventType: string;
  occurredAt: number;
  occurredAtRaw: string;
  receivedAt: number;
  eventSource: 'server' | 'crm';
  workspaceIdClaim: string | null;
  sourceConnectionIdClaim: string | null;
  campaignId: string | null;
  anonymousSessionId: string | null;
  landingUrl: string | null;
  referrer: string | null;
  utm: Record<string, string>;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  consentState: 'granted' | 'denied' | 'unknown';
  crmRecordReference: string | null;
  currency: string | null;
  amountMinor: number | null;
  metadata: Record<string, unknown> | null;
}

export declare function eventDocumentId(input: { workspaceId: string; eventId: string }): string;
export declare function validateEventV2(body: Record<string, unknown>, opts?: { now?: () => number }): NormalizedEvent;

export interface IngestResult {
  accepted: true;
  duplicate: boolean;
  eventId: string;
  eventType: string;
  occurredAt?: number;
  leadId?: string | null;
}
export interface EventIngest {
  ingest(input: { source: IngestKeyRecord; body: Record<string, unknown> }): Promise<IngestResult>;
}
export declare function createEventIngest(opts: { store: { records: unknown }; now?: () => number }): EventIngest;

export interface Attribution {
  available: boolean;
  reason?: string;
  basis: 'observed_touchpoints';
  note?: string;
  window: { days: number; start: string; end: string; timeZone: string };
  models: {
    firstTouch: {
      campaignId: string | null;
      utm: Record<string, string>;
      landingUrl: string | null;
      occurredAt: number;
    } | null;
    lastTouch: {
      campaignId: string | null;
      utm: Record<string, string>;
      landingUrl: string | null;
      occurredAt: number;
    } | null;
  };
  touchpointCount?: number;
}
export declare function attribute(input: {
  touchpoints: {
    occurredAt?: number;
    campaignId?: string | null;
    utm?: Record<string, string>;
    landingUrl?: string | null;
  }[];
  conversionAt: number;
  windowDays?: number;
  timeZone?: string;
}): Attribution;
