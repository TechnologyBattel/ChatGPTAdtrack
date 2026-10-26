// A small load probe with no dependencies.
//
// Purpose: produce *evidence* rather than a capacity claim. It drives one path at a fixed
// concurrency for a fixed duration against whatever URL you point it at and reports what
// it measured. What it cannot tell you:
//
//   * how the service behaves with a Firestore backend (this measures the process, and
//     with the in-memory store the storage layer is not the cost);
//   * how it behaves behind a load balancer, or across more than one instance;
//   * provider latency (nothing here calls HubSpot);
//   * p99 with any statistical confidence at low sample counts — read the sample size.
//
// Usage:
//   node scripts/load-smoke.mjs --url http://127.0.0.1:8787 --duration 10 --concurrency 8
//   node scripts/load-smoke.mjs --path /api/health --token "$TOKEN" --json artifacts/load-smoke.json
//   node scripts/load-smoke.mjs --path /api/nope --expect-status 404 --json artifacts/load-error.json
//
// Exits non-zero if any request failed or if a latency budget you pass was exceeded, so it
// can be used as a gate (with a budget chosen from a real requirement, not from a guess).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};

const baseUrl = String(flag('url', 'http://127.0.0.1:8787')).replace(/\/$/, '');
const path = String(flag('path', '/api/health'));
const durationSeconds = Math.max(1, Number(flag('duration', 10)));
const concurrency = Math.max(1, Number(flag('concurrency', 8)));
const timeoutMs = Math.max(100, Number(flag('timeout', 5000)));
const token = flag('token', null);
const jsonPath = flag('json', null);
const p95BudgetMs = flag('budget-p95', null);
const maxErrorRate = flag('max-error-rate', null);
// Which status counts as success. Default 2xx; an error-path profile passes e.g. 404 so
// its latency is measured without being scored as a failure.
const expectStatus = flag('expect-status', null);

const url = `${baseUrl}${path}`;
const deadline = Date.now() + durationSeconds * 1000;
const latencies = [];
const statuses = new Map();
let failed = 0;

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function worker() {
  while (Date.now() < deadline) {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      // The body must be consumed for the connection to be reusable.
      await response.arrayBuffer();
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      const expected = expectStatus === null ? response.ok : response.status === Number(expectStatus);
      if (!expected) failed += 1;
    } catch {
      failed += 1;
      statuses.set('error', (statuses.get('error') ?? 0) + 1);
    } finally {
      clearTimeout(timer);
      latencies.push(performance.now() - started);
    }
  }
}

const startedAt = Date.now();
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const elapsedSeconds = (Date.now() - startedAt) / 1000;

const total = latencies.length;
const errorRate = total ? failed / total : 1;
const result = {
  // Stated in the artefact itself so a reader cannot mistake it for a capacity test.
  kind: 'single-process smoke probe, not a capacity or soak test',
  url,
  path,
  expectedStatus: expectStatus === null ? '2xx' : Number(expectStatus),
  concurrency,
  durationSeconds,
  elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
  requests: total,
  requestsPerSecond: Number((total / elapsedSeconds).toFixed(1)),
  failed,
  errorRate: Number(errorRate.toFixed(4)),
  statuses: Object.fromEntries(statuses),
  latencyMs: {
    p50: round(percentile(latencies, 50)),
    p95: round(percentile(latencies, 95)),
    p99: round(percentile(latencies, 99)),
    max: round(percentile(latencies, 100)),
  },
  environment: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpuCount: (await import('node:os')).cpus().length,
  },
  recordedAt: new Date().toISOString(),
};

function round(value) {
  return value === null ? null : Number(value.toFixed(1));
}

const text = JSON.stringify(result, null, 2);
console.log(text);

if (jsonPath && jsonPath !== true) {
  await mkdir(dirname(String(jsonPath)), { recursive: true });
  await writeFile(String(jsonPath), `${text}\n`);
  console.log(`\nwritten to ${jsonPath}`);
}

let exitCode = 0;
if (failed > 0) {
  console.error(`\nFAIL: ${failed} of ${total} requests failed (${(errorRate * 100).toFixed(1)}%)`);
  exitCode = 1;
}
if (maxErrorRate !== null && errorRate > Number(maxErrorRate)) {
  console.error(`\nFAIL: error rate ${(errorRate * 100).toFixed(1)}% exceeds budget ${Number(maxErrorRate) * 100}%`);
  exitCode = 1;
}
if (p95BudgetMs !== null && result.latencyMs.p95 !== null && result.latencyMs.p95 > Number(p95BudgetMs)) {
  console.error(`\nFAIL: p95 ${result.latencyMs.p95}ms exceeds budget ${Number(p95BudgetMs)}ms`);
  exitCode = 1;
}
if (total < 100) {
  console.error(`\nWARN: only ${total} samples; percentiles are indicative at best.`);
}

process.exit(exitCode);
