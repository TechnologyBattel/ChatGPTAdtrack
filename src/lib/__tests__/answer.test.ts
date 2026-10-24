import { describe, expect, it } from 'vitest';
import { answerFor, SUGGESTIONS } from '../answer';
import { buildDataset } from '../demo';
import { DEFAULT_SETTINGS } from '../metrics';

const data = buildDataset(90, '2026-10-24');
const ask = (q: string) => answerFor(q, data, DEFAULT_SETTINGS);

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
