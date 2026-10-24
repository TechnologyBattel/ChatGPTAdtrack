import { describe, expect, it } from 'vitest';
import { normalizeSeeds, runResearch, scoreBreakdown, toCsv, validateHint, SAMPLE_SEEDS } from '../research';

describe('seed intake', () => {
  it('removes PII instead of clustering it', () => {
    const seeds = normalizeSeeds('accounting help for small firm\ncall 9876543210\nmail me at a@b.com');
    const pii = seeds.filter((s) => s.removed === 'pii');
    expect(pii).toHaveLength(2);
    expect(pii.every((s) => !s.clean.includes('9876543210') && !s.clean.includes('a@b.com'))).toBe(true);
  });

  it('drops duplicates', () => {
    const seeds = normalizeSeeds('gst filing help\ngst filing help\nGST filing help');
    expect(seeds.filter((s) => s.removed === 'duplicate').length).toBeGreaterThanOrEqual(1);
  });

  it('drops one-word lines as too short', () => {
    const seeds = normalizeSeeds('accounting');
    expect(seeds[0].removed).toBe('too-short');
  });

  it('classifies buying intent', () => {
    const seeds = normalizeSeeds('accounting software pricing for small team');
    expect(seeds[0].intent).toBe('transactional');
  });

  it('classifies comparison intent', () => {
    const seeds = normalizeSeeds('compare cloud accounting vs desktop software');
    expect(seeds[0].intent).toBe('comparison');
  });
});

describe('clustering', () => {
  it('runs the full pipeline on the sample', () => {
    const r = runResearch(SAMPLE_SEEDS, 50);
    expect(r.stats.input).toBeGreaterThan(25);
    expect(r.stats.clusters).toBeGreaterThan(2);
    expect(r.hints.length).toBeGreaterThanOrEqual(r.clusters.length * 2);
  });

  it('produces more clusters as granularity rises', () => {
    const broad = runResearch(SAMPLE_SEEDS, 0).stats.clusters;
    const fine = runResearch(SAMPLE_SEEDS, 100).stats.clusters;
    expect(fine).toBeGreaterThanOrEqual(broad);
    expect(fine).toBeGreaterThan(1);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(runResearch(SAMPLE_SEEDS, 50))).toBe(JSON.stringify(runResearch(SAMPLE_SEEDS, 50)));
  });

  it('assigns every usable seed to a cluster', () => {
    const r = runResearch(SAMPLE_SEEDS, 50);
    const assigned = r.clusters.reduce((s, c) => s + c.seedIds.length, 0);
    expect(assigned).toBe(r.stats.unique);
  });

  it('scores stay in range and decompose into weighted parts', () => {
    const r = runResearch(SAMPLE_SEEDS, 50);
    for (const c of r.clusters) {
      expect(c.score).toBeGreaterThan(0);
      expect(c.score).toBeLessThanOrEqual(1);
      const parts = scoreBreakdown(c);
      expect(parts.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(1, 6);
    }
  });

  it('sorts clusters by score', () => {
    const scores = runResearch(SAMPLE_SEEDS, 50).clusters.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe('hint validators', () => {
  it('blocks a keyword list masquerading as a hint', () => {
    const issues = validateHint('accounting software gst filing invoice');
    expect(issues.some((i) => i.code === 'keyword-soup' && i.severity === 'block')).toBe(true);
  });

  it('blocks unsupported claims', () => {
    const issues = validateHint('a founder wants software guaranteed to cut work by 100%');
    expect(issues.some((i) => i.code === 'claim')).toBe(true);
  });

  it('blocks PII', () => {
    const issues = validateHint('someone with email a@b.com asking about filing');
    expect(issues.some((i) => i.code === 'pii')).toBe(true);
  });

  it('passes a well-shaped hint', () => {
    const issues = validateHint('a business owner asking how to reconcile invoices before the filing deadline');
    expect(issues.some((i) => i.severity === 'block')).toBe(false);
  });

  it('generated hints are mostly shippable', () => {
    const r = runResearch(SAMPLE_SEEDS, 50);
    const ready = r.hints.filter((h) => !h.blocked).length;
    expect(ready).toBeGreaterThan(r.hints.length * 0.8);
  });
});

describe('export', () => {
  it('emits a header and one row per hint', () => {
    const r = runResearch(SAMPLE_SEEDS, 50);
    const csv = toCsv(r).split('\n');
    expect(csv[0]).toBe('cluster,intent,hint,score,status,issues,landing_path');
    expect(csv).toHaveLength(r.hints.length + 1);
  });

  it('quotes every free-text field so commas cannot break the row', () => {
    const r = runResearch('a team saying "this is broken" about invoice entry', 50);
    const rows = toCsv(r).split('\n').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.startsWith('"')).toBe(true);
  });

  it('keeps the header stable for downstream tooling', () => {
    const cols = toCsv(runResearch(SAMPLE_SEEDS, 50)).split('\n')[0].split(',');
    expect(cols).toEqual(['cluster', 'intent', 'hint', 'score', 'status', 'issues', 'landing_path']);
  });
});
