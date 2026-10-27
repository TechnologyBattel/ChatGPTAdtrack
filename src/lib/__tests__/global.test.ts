// @vitest-environment node
//
// Global-by-design behaviour: time zones, currencies, language, and the rule that a
// missing number is reported as unavailable rather than as zero.
//
// The brief's acceptance criteria for this section are covered one by one below, with
// at least two zones and two currencies as required.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  bucketByLocalDay,
  formatInZone,
  offsetMinutes,
  partsInZone,
  startOfZonedDay,
  zonedDayRange,
} from '../../../server/time.mjs';
import { currencyCode, languageTag, countryCode, timeZone, isoInstant } from '../../../server/validate.mjs';
import { formatMoney } from '../metrics';

const HOUR = 60 * 60 * 1000;

describe('zoned day boundaries', () => {
  it('starts the day at local midnight in Asia/Kolkata (UTC+05:30)', () => {
    // 2025-10-09T20:00Z is 2025-10-10 01:30 IST, so "today" is the 10th, and it began
    // at 18:30Z on the 9th.
    const range = zonedDayRange(Date.parse('2025-10-09T20:00:00Z'), 'Asia/Kolkata');
    expect(range.localDate).toBe('2025-10-10');
    expect(new Date(range.startMs).toISOString()).toBe('2025-10-09T18:30:00.000Z');
    expect(range.hours).toBe(24);
  });

  it('starts the day at local midnight in America/New_York (UTC-04:00 in October)', () => {
    const range = zonedDayRange(Date.parse('2025-10-09T12:00:00Z'), 'America/New_York');
    expect(range.localDate).toBe('2025-10-09');
    expect(new Date(range.startMs).toISOString()).toBe('2025-10-09T04:00:00.000Z');
  });

  it('does not assume a 24-hour day across a DST transition', () => {
    // US DST ends on 2025-11-02: that local day is 25 hours long.
    const range = zonedDayRange(Date.parse('2025-11-02T12:00:00Z'), 'America/New_York');
    expect(range.localDate).toBe('2025-11-02');
    expect(range.hours).toBe(25);
    expect(range.endMs - range.startMs).toBe(25 * HOUR - 1);

    // And the spring transition is 23 hours.
    const spring = zonedDayRange(Date.parse('2025-03-09T12:00:00Z'), 'America/New_York');
    expect(spring.hours).toBe(23);
  });

  it('gives UTC its own trivially correct day', () => {
    const range = zonedDayRange(Date.parse('2025-10-09T23:59:59Z'), 'UTC');
    expect(range.localDate).toBe('2025-10-09');
    expect(new Date(range.startMs).toISOString()).toBe('2025-10-09T00:00:00.000Z');
    expect(range.hours).toBe(24);
  });

  it('reports the offset per instant, not per zone', () => {
    const summer = Date.parse('2025-07-01T12:00:00Z');
    const winter = Date.parse('2025-12-01T12:00:00Z');
    expect(offsetMinutes(summer, 'America/New_York')).toBe(-240); // EDT
    expect(offsetMinutes(winter, 'America/New_York')).toBe(-300); // EST
    expect(offsetMinutes(summer, 'Asia/Kolkata')).toBe(330); // no DST
  });
});

describe('day-boundary bucketing', () => {
  it('puts an event on the local day it happened, not the UTC day', () => {
    // 20:00Z on the 9th is already the 10th in Kolkata.
    const from = Date.parse('2025-10-01T00:00:00Z');
    const to = Date.parse('2025-10-31T00:00:00Z');
    const events = [
      { occurredAt: Date.parse('2025-10-09T18:00:00Z') }, // 23:30 IST on the 9th
      { occurredAt: Date.parse('2025-10-09T18:40:00Z') }, // 00:10 IST on the 10th
    ];
    const kolkata = bucketByLocalDay(events, { timeZone: 'Asia/Kolkata', fromMs: from, toMs: to });
    expect(kolkata).toEqual([
      { date: '2025-10-09', count: 1 },
      { date: '2025-10-10', count: 1 },
    ]);
    // The same two events fall on one UTC day.
    const utc = bucketByLocalDay(events, { timeZone: 'UTC', fromMs: from, toMs: to });
    expect(utc).toEqual([{ date: '2025-10-09', count: 2 }]);
  });

  it('drops out-of-range events instead of clamping them into the boundary day', () => {
    const buckets = bucketByLocalDay([{ occurredAt: Date.parse('2025-09-30T10:00:00Z') }], {
      timeZone: 'Asia/Kolkata',
      fromMs: Date.parse('2025-10-01T00:00:00Z'),
      toMs: Date.parse('2025-10-31T00:00:00Z'),
    });
    expect(buckets).toEqual([]);
  });

  it('formats an instant in the customer’s zone, with the zone named', () => {
    const instant = Date.parse('2025-10-09T08:50:00Z');
    expect(formatInZone(instant, 'Asia/Kolkata')).toContain('14:20');
    expect(formatInZone(instant, 'America/New_York')).toContain('04:50');
    expect(formatInZone(instant, 'Asia/Kolkata')).toMatch(/GMT\+5:30|IST/);
  });
});

describe('validation of global inputs', () => {
  it('accepts real zones and refuses abbreviations that mean several places', () => {
    expect(timeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(timeZone('America/New_York')).toBe('America/New_York');
    expect(timeZone('UTC')).toBe('UTC');
    // IST is India, Israel and Ireland; EST is US Eastern and Australia Eastern.
    expect(() => timeZone('IST')).toThrow(/IANA/);
    expect(() => timeZone('EST')).toThrow(/IANA/);
    expect(() => timeZone('Mars/Olympus')).toThrow();
  });

  it('accepts real currencies and refuses three letters that are not one', () => {
    expect(currencyCode('INR')).toBe('INR');
    expect(currencyCode('inr')).toBe('INR');
    expect(currencyCode('USD')).toBe('USD');
    expect(() => currencyCode('XYZ')).toThrow(/ISO-4217/);
  });

  it('canonicalises language tags and keeps country and language independent', () => {
    expect(languageTag('en-in')).toBe('en-IN');
    expect(languageTag('pt-BR')).toBe('pt-BR');
    // A US client can be reported in Spanish; an Indian client in English.
    expect(languageTag('es')).toBe('es');
    expect(countryCode('in')).toBe('IN');
    expect(() => countryCode('IND')).toThrow(/two-letter/);
  });

  it('refuses a timestamp without an offset', () => {
    expect(() => isoInstant('2025-10-09T14:20:00')).toThrow(/offset/);
    expect(isoInstant('2025-10-09T14:20:00+05:30').ms).toBe(Date.parse('2025-10-09T08:50:00Z'));
  });
});

describe('currency presentation', () => {
  it('formats two currencies with their own symbols and no conversion', () => {
    // The same minor-unit amount means different things in different currencies, which
    // is exactly why we never convert implicitly.
    expect(formatMoney(149900, 'INR')).toContain('1,499');
    expect(formatMoney(149900, 'USD')).toContain('1,499');
    expect(formatMoney(149900, 'INR')).toMatch(/₹|INR/);
    expect(formatMoney(149900, 'USD')).toMatch(/\$|USD/);
  });

  it('has no exchange-rate conversion anywhere in the server', () => {
    // A conversion without a rate source and timestamp is a fabricated number. If
    // someone adds one, this test is the tripwire.
    const dir = new URL('../../../server/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      expect(source, `${file} must not convert currency`).not.toMatch(
        /exchangeRate|exchange_rate|convertCurrency|fxRate/,
      );
    }
  });
});

describe('missing data is never zero', () => {
  it('the workspace summary lists unavailable metrics instead of omitting them', async () => {
    const { createMemoryStore } = await import('../../../server/store.mjs');
    const { createTenancy } = await import('../../../server/tenancy.mjs');
    const { createAgencyApi } = await import('../../../server/agency.mjs');
    const { createAuth } = await import('../../../server/auth.mjs');

    const store = createMemoryStore();
    const tenancy = createTenancy({ store });
    const agency = createAgencyApi({ tenancy, store });
    const auth = createAuth({ mode: 'firebase', verifyToken: async (t: string) => ({ uid: t, role: 'owner' }) });
    const app = (await import('../../../server/app.mjs')).createApp({
      env: {},
      auth,
      consent: (await import('../../../server/consent.mjs')).createConsentService({
        secrets: [{ version: 'v1', secret: 'consent-secret-for-global-tests' }],
        currentVersion: 'v1',
        store,
      }),
      store,
      agency,
      dataset: async () => ({ rows: [] }),
      logger: { info() {}, warn() {}, error() {} },
    });
    const headers = { authorization: 'Bearer u1', 'content-type': 'application/json' };
    const org = await app.handle({ method: 'POST', path: '/api/orgs', headers, body: { name: 'Acme' } });
    const ws = await app.handle({
      method: 'POST',
      path: `/api/orgs/${org.body.organizationId}/workspaces`,
      headers,
      body: { name: 'Acme IN', timeZone: 'Asia/Kolkata', currency: 'INR', defaultLanguage: 'en-IN' },
    });
    const summary = await app.handle({
      method: 'GET',
      path: `/api/orgs/${org.body.organizationId}/workspaces/${ws.body.workspaceId}/summary`,
      headers,
    });

    expect(summary.body.unavailable).toEqual(['search_volume', 'cpc', 'competitor_ad_spend', 'trend_growth']);
    expect(summary.body.missing).toContain('source_connections');
    expect(summary.body.freshness.lastEventAt).toBeNull(); // unknown, rendered as "never"
    expect(summary.body.counts.leads).toBe(0); // a real count of zero is fine
    expect(summary.body.workspace.currency).toBe('INR');
    expect(summary.body.workspace.timeZone).toBe('Asia/Kolkata');
  });

  it('reports parts of an instant in a zone without shifting it', () => {
    const p = partsInZone(Date.parse('2025-10-09T23:30:00Z'), 'Asia/Kolkata');
    expect(p).toMatchObject({ year: 2025, month: 10, day: 10, hour: 5, minute: 0 });
    expect(startOfZonedDay(Date.parse('2025-10-09T23:30:00Z'), 'Asia/Kolkata')).toBe(
      Date.parse('2025-10-09T18:30:00Z'),
    );
  });
});
