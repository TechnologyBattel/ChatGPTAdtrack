import { describe, expect, it } from 'vitest';
import { answerFor, SUGGESTIONS } from '../answer';
import { buildDataset } from '../demo';
import { DEFAULT_SETTINGS } from '../metrics';

const data = buildDataset(90, '2026-10-24');
const ask = (q: string) => answerFor(q, data, DEFAULT_SETTINGS);

/** The same demo dataset with no first-party source, which is what live looks like. */
const noFirstParty = { ...data, firstPartyAvailable: false };
const askLive = (q: string) => answerFor(q, noFirstParty, DEFAULT_SETTINGS);

describe('intent routing', () => {
  const cases: [string, string][] = [
    ['How much did I spend this month?', 'spend'],
    ['Where are my leads coming from?', 'geo'],
    ['Which ad group has the best cost per lead?', 'ranked'],
    ['What is my ROAS?', 'revenue'],
    ['How is my pacing?', 'pacing'],
    ['How many leads did I get?', 'leads'],
    ['What is my CAC?', 'customers'],
    ['Which device converts best?', 'device'],
    ['Show my campaigns', 'campaigns'],
    ['Why do native and internal conversions differ?', 'tracking'],
    ['Help me research context hints', 'research'],
  ];
  it.each(cases)('%s -> %s', (q, intent) => {
    expect(ask(q).intent).toBe(intent);
  });

  it('falls back to an overview for an unmatched question', () => {
    expect(ask('tell me a story').intent).toBe('overview');
  });

  it('never routes a research question to tracking', () => {
    expect(ask('keyword ideas for gst').intent).toBe('research');
  });
});

describe('windows', () => {
  it('reads an explicit range from the question', () => {
    expect(ask('how much did I spend in the last 7 days?').windowDays).toBe(7);
    expect(ask('how many leads in the last 14 days?').windowDays).toBe(14);
    expect(ask('revenue for the quarter').windowDays).toBe(90);
  });
  it('defaults to the settings window', () => {
    expect(ask('where are my leads').windowDays).toBe(DEFAULT_SETTINGS.windowDays);
  });
});

describe('answer shape', () => {
  it('always has a headline, tiles and sources', () => {
    for (const q of SUGGESTIONS) {
      const a = ask(q);
      expect(a.headline.length).toBeGreaterThan(10);
      expect(a.tiles).toHaveLength(4);
      expect(a.sources.length).toBeGreaterThan(0);
      expect(a.followUps.length).toBeGreaterThan(1);
      expect(a.sections.length).toBeGreaterThan(0);
    }
  });

  it('puts the real currency in the headline', () => {
    expect(ask('how much did I spend?').headline).toContain('₹');
  });

  it('keeps native and internal conversions distinct in the tracking answer', () => {
    const a = ask('are my conversions tracked correctly?');
    const labels = a.tiles.map((t) => t.label).join(' ');
    expect(labels).toContain('Native');
    expect(labels).toContain('Internal');
  });

  it('never claims a term-level report exists', () => {
    const a = ask('help me research keywords');
    const text = JSON.stringify(a);
    expect(text).toContain('no search-terms report');
  });

  it('is deterministic', () => {
    expect(JSON.stringify(ask('what is my roas'))).toBe(JSON.stringify(ask('what is my roas')));
  });
});

// ---------------------------------------------------------------------------
// Item 1: with no first-party source, nothing may present a fabricated zero —
// not a tile, not a column, and not the written headline or subline.
// ---------------------------------------------------------------------------

describe('first-party masking, per intent', () => {
  const INTENTS: [string, string][] = [
    ['How many leads did I get?', 'leads'],
    ['What is my CAC?', 'customers'],
    ['What is my ROAS?', 'revenue'],
    ['Which ad group has the best cost per lead?', 'ranked'],
    ['Where are my leads coming from?', 'geo'],
    ['Which device converts best?', 'device'],
    ['Show my campaigns', 'campaigns'],
    ['Why do native and internal conversions differ?', 'tracking'],
    ['How much did I spend this month?', 'spend'],
    ['How is my pacing?', 'pacing'],
    ['Help me research context hints', 'research'],
    ['tell me a story', 'overview'],
  ];

  it.each(INTENTS)('masks first-party numbers and prose for %s (%s)', (question, intent) => {
    const answer = askLive(question);
    expect(answer.intent).toBe(intent);

    // The prose must not assert a number we cannot measure.
    for (const prose of [answer.headline, answer.subline]) {
      expect(prose).not.toMatch(/\b0 (leads?|customers?|conversions?|orders?)\b/i);
      expect(prose).not.toMatch(/₹\s?0(?![\d,])/);
      expect(prose).not.toMatch(/\b0%\b/);
    }

    // Every first-party tile is an em dash, with a reason instead of a fake delta.
    for (const tile of answer.tiles) {
      if (/lead|customer|cpl|cac|roas|revenue/i.test(tile.label)) {
        expect(tile.value).toBe('—');
      }
    }

    // The answer says why, in a source line the UI already renders.
    expect(answer.sources).toContain('First-party events not connected — columns masked');
  });

  it('rewrites the headline for intents that talk about first-party outcomes', () => {
    // Not merely number-stripped: the sentence is rebuilt around delivery metrics.
    expect(askLive('How many leads did I get?').headline).toMatch(/no lead count/i);
    expect(askLive('What is my ROAS?').headline).toMatch(/Attributed revenue is unavailable/i);
    expect(askLive('What is my CAC?').headline).toMatch(/no customer count/i);
    // Delivery figures survive, because those are real.
    expect(askLive('How much did I spend this month?').headline).toContain('₹');
  });

  it('replaces a first-party chart with text rather than an empty series', () => {
    const answer = askLive('What is my ROAS?');
    const charts = answer.sections.filter((section) => section.kind === 'chart');
    for (const chart of charts) {
      expect(['leads', 'customers', 'revenue']).not.toContain((chart as unknown as { metric?: string }).metric);
    }
    expect(answer.sections.some((section) => section.kind === 'text')).toBe(true);
  });

  it('leaves the same answers untouched when first-party data exists', () => {
    // The demo dataset has leads and revenue, so nothing is masked and the numbers
    // are the real ones from the fixture.
    const leads = ask('How many leads did I get?');
    expect(leads.headline).not.toMatch(/not connected/i);
    expect(leads.sources).not.toContain('First-party events not connected — columns masked');
  });
});
