// @vitest-environment node
//
// Structured logging: what a log line may contain, and what it must never contain.
//
// A logging change is a security change — one careless field turns an audit trail into a
// credential leak — so the redaction rules are asserted here rather than left to review.

import { describe, expect, it } from 'vitest';
import { createLogger, routeOf } from '../../../server/log.mjs';

function capture() {
  const lines: string[] = [];
  const sink = {
    log: (line: string) => lines.push(line),
    warn: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
  const now = () => Date.UTC(2026, 9, 26, 12, 0, 0);
  return { lines, sink, now };
}

describe('log lines', () => {
  it('strips the query string from a route, so an email in a query never lands in a log', () => {
    expect(routeOf('/api/orgs?email=someone@example.com')).toBe('/api/orgs');
    expect(routeOf('/api/health')).toBe('/api/health');
    expect(routeOf(undefined)).toBe('/');
  });

  it('emits one JSON object with the operational fields and no body', () => {
    const { lines, sink, now } = capture();
    const logger = createLogger({ format: 'json', sink, now });
    const record = logger.request({
      requestId: 'req-1',
      method: 'POST',
      route: '/api/orgs/org_1/research/runs?token=abc',
      status: 201,
      durationMs: 12,
      body: { secret: 'should never be logged' },
      authorization: 'Bearer abc.def',
    });

    expect(record.route).toBe('/api/orgs/org_1/research/runs');
    const line = lines[0];
    expect(line.startsWith('{')).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ level: 'info', message: 'request', status: 201, durationMs: 12 });
    expect(line).not.toContain('someone@example.com');
    expect(line).not.toContain('should never be logged');
    expect(line).not.toContain('abc.def');
    expect(parsed.body).toBe('[redacted]');
    expect(parsed.authorization).toBe('[redacted]');
  });

  it('maps status to level so an alert can filter on severity', () => {
    const { lines, sink, now } = capture();
    const logger = createLogger({ format: 'json', sink, now });
    logger.request({ requestId: 'a', method: 'GET', route: '/api/health', status: 200, durationMs: 1 });
    logger.request({ requestId: 'b', method: 'GET', route: '/api/nope', status: 404, durationMs: 1 });
    logger.request({ requestId: 'c', method: 'POST', route: '/api/x', status: 503, durationMs: 1 });
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(['info', 'warn', 'error']);
  });

  it('scrubs token-shaped text inside a message field', () => {
    const { lines, sink, now } = capture();
    const logger = createLogger({ format: 'json', sink, now });
    logger.error('provider said no', {
      detail: 'Authorization: Bearer abc.123 refresh_token=rt_secret_value access_token=at_secret_value',
    });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.detail).not.toContain('abc.123');
    expect(parsed.detail).not.toContain('rt_secret_value');
    expect(parsed.detail).not.toContain('at_secret_value');
    expect(parsed.detail).toContain('[redacted]');
  });

  it('keeps a readable single line in text mode', () => {
    const { lines, sink, now } = capture();
    const logger = createLogger({ format: 'text', sink, now });
    logger.request({ requestId: 'req-9', method: 'GET', route: '/api/health', status: 200, durationMs: 4 });
    expect(lines[0]).toContain('request');
    expect(lines[0]).toContain('status=200');
    expect(lines[0]).toContain('durationMs=4');
    // Text mode is still one line: a multi-line record breaks line-based log collection.
    expect(lines[0]).not.toContain('\n');
  });
});
