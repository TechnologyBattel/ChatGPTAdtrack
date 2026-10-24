// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  configuration,
  dateRange,
  EVENT_DATA_TYPE,
  fetchInsights,
  health,
  mapInsightsToDataset,
  pushHintSet,
  track,
} from '../../../server/core.mjs';
import type { ServerEnv } from '../../../server/core.mjs';

const ok = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const baseEnv: ServerEnv = { adsKey: 'ak_live_secret_123', capiKey: 'ck_live_secret_456', pixelId: 'px_123' };

describe('configuration', () => {
  it('reports presence without leaking the key', () => {
    const c = configuration(baseEnv);
    expect(c.adsKey).toBe(true);
    expect(c.live).toBe(true);
    expect(JSON.stringify(c)).not.toContain('secret');
    expect(JSON.stringify(c)).not.toContain('ak_live_secret_123');
  });

  it('is not live without a pixel id', () => {
    expect(configuration({ adsKey: 'x' }).live).toBe(false);
  });
});

describe('health', () => {
  it('falls back to demo without keys and never calls out', async () => {
    const fetchImpl = vi.fn();
    const r = await health({ fetchImpl });
    expect(r.mode).toBe('demo');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('verifies the key against /ad_account', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ id: 'adacct_1', name: 'Acme', status: 'active', currency_code: 'INR', timezone: 'Asia/Kolkata', review: { status: 'approved' } }),
    );
    const r = await health({ ...baseEnv, fetchImpl });
    expect(r.mode).toBe('live');
    expect(r.account?.currency).toBe('INR');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.ads.openai.com/v1/ad_account');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ak_live_secret_123');
  });

  it('surfaces an auth failure as an error mode', async () => {
    const fetchImpl = vi.fn(async () => ok({ error: { message: 'invalid api key' } }, 401));
    const r = await health({ ...baseEnv, fetchImpl });
    expect(r.mode).toBe('error');
    expect(r.reason).toBe('invalid api key');
  });
});

describe('track', () => {
  const base = {
    eventName: 'lead_created',
    eventId: 'evt_1',
    sourceUrl: 'https://shop.example.com/thanks',
    consent: true,
  };

  it('drops the event when consent is denied', async () => {
    const fetchImpl = vi.fn();
    await expect(track({ ...base, consent: false }, { ...baseEnv, fetchImpl })).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires an event id for dedupe', async () => {
    await expect(track({ ...base, eventId: '' }, baseEnv)).rejects.toThrow(/event_id/);
  });

  it('rejects unknown event names', async () => {
    await expect(track({ ...base, eventName: 'bought_something' }, baseEnv)).rejects.toThrow(/Unsupported/);
  });

  it('sends the pixel id in the query string and the same event id', async () => {
    const fetchImpl = vi.fn(async () => ok({}));
    await track(
      { ...base, oppref: 'gAAAA_original', obref: 'browser-ref', amountMinor: 149900, currency: 'INR' },
      { ...baseEnv, fetchImpl },
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('pid=px_123');
    const body = JSON.parse(String(init.body));
    expect(body.events[0].id).toBe('evt_1');
    expect(body.events[0].oppref).toBe('gAAAA_original'); // unmodified
    expect(body.events[0].user.obref).toBe('browser-ref');
    expect(body.events[0].data).toEqual({ type: 'customer_action', amount: 149900, currency: 'INR' });
    expect(body.events[0].action_source).toBe('web');
  });

  it('refuses an amount without a currency', async () => {
    const fetchImpl = vi.fn(async () => ok({}));
    await expect(track({ ...base, amountMinor: 500 }, { ...baseEnv, fetchImpl })).rejects.toThrow(/currency/);
  });

  it('maps each event to the data shape the API requires', () => {
    expect(EVENT_DATA_TYPE.lead_created).toBe('customer_action');
    expect(EVENT_DATA_TYPE.order_created).toBe('contents');
    expect(EVENT_DATA_TYPE.trial_started).toBe('plan_enrollment');
  });

  it('retries a 500 then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? ok({}, 500) : ok({});
    });
    await track(base, { ...baseEnv, fetchImpl });
    expect(calls).toBe(2);
  });
});

describe('insights -> dataset', () => {
  it('builds a date range with an inclusive end', () => {
    const { since, until } = dateRange(7, new Date('2026-10-24T00:00:00Z'));
    expect(until).toBe('2026-10-24');
    expect(since).toBe('2026-10-18');
  });

  it('requests one segment per call and requests segment-prefixed fields', async () => {
    const fetchImpl = vi.fn(async () => ok({ account_currency: 'INR', data: [] }));
    await fetchInsights({ ...baseEnv, fetchImpl }, { days: 30, segment: 'country' });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('segments%5B%5D=country');
    expect(decodeURIComponent(String(url))).toContain('fields[]=country.spend');
  });

  it('converts spend to minor units and keeps native conversions separate', () => {
    const ds = mapInsightsToDataset({
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      rows: [
        {
          readable_time: '2026-10-23',
          campaign_id: 'cmpn_1',
          impressions: 1000,
          clicks: 52,
          spend: 1378.5,
          conversions: 4,
          view_through_conversions: 1,
          order_created_attributed_sales: '12000',
          country: 'IN',
        },
      ],
    });
    expect((ds as { rows: { spendMinor: number }[] }).rows[0].spendMinor).toBe(137850);
    expect((ds as { rows: { conversionsNative: number }[] }).rows[0].conversionsNative).toBe(4);
    expect((ds as { rows: { viewThrough: number }[] }).rows[0].viewThrough).toBe(1);
    expect((ds as { rows: { country: string }[] }).rows[0].country).toBe('IN');
    expect((ds as { firstPartyAvailable: boolean }).firstPartyAvailable).toBe(false);
  });

  it('marks first-party columns unavailable so the UI can mask them', () => {
    const ds = mapInsightsToDataset({ currency: 'INR', timezone: 'UTC', rows: [] });
    expect((ds as { firstPartyAvailable: boolean }).firstPartyAvailable).toBe(false);
    const rows = (ds as { rows: { leads: number; customers: number }[] }).rows;
    expect(rows.every((r) => r.leads === 0 && r.customers === 0)).toBe(true);
  });
});

describe('push hint set', () => {
  it('reads the previous set so a rollback is possible', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/ad_groups/adgrp_1')
        ? ok({ id: 'adgrp_1', context_hints: ['old hint one'] })
        : ok({}),
    );
    const r = await pushHintSet('adgrp_1', ['a business owner asking about gst filing'], { ...baseEnv, fetchImpl });
    expect(r.previousHints).toEqual(['old hint one']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('refuses an empty set and hints containing PII', async () => {
    await expect(pushHintSet('adgrp_1', [], baseEnv)).rejects.toThrow(/empty/);
    await expect(pushHintSet('adgrp_1', ['contact me at a@b.com'], baseEnv)).rejects.toThrow(/email/);
  });
});
