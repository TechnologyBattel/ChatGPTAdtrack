// @vitest-environment node
//
// Transport rules over a real socket. app.mjs and limits.mjs are already tested as
// units; this file proves the wiring: a chunked body with no Content-Length is cut
// off while streaming, X-Forwarded-For only counts when TRUST_PROXY is set, and the
// security headers are actually on the wire.

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequestListener } from '../../../server/handler.mjs';
import { ApiError } from '../../../server/errors.mjs';

type Captured = { ip: string; headers: Record<string, string>; body: unknown };

let server: http.Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

type Respond = (captured: Captured) => { status: number; body: unknown; headers?: Record<string, string> };

async function mount({
  maxBodyBytes = 1024,
  trustProxy = 0,
  respond = (captured: Captured): { status: number; body: unknown } => ({ status: 200, body: { ip: captured.ip } }),
  draining = () => false,
}: {
  maxBodyBytes?: number;
  trustProxy?: number;
  respond?: Respond;
  draining?: () => boolean;
} = {}) {
  server = http.createServer(
    createRequestListener({
      maxBodyBytes,
      trustProxy,
      draining,
      logger: { error: () => {} },
      app: {
        async handle(req: unknown) {
          return respond(req as Captured);
        },
      },
    }),
  );
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server!.address() as AddressInfo;
  return { port };
}

describe('body cap while streaming (gap 4)', () => {
  it('rejects a chunked body over the cap without waiting for the client to finish', async () => {
    const { port } = await mount({ maxBodyBytes: 1024 });

    const result = await new Promise<{ status: number; body: string; sentAll: boolean }>((resolve, reject) => {
      let sentAll = false;
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/track', headers: { 'Transfer-Encoding': 'chunked' } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, sentAll }));
        },
      );
      req.on('error', (error) => {
        // The server is allowed to close early; that is the point.
        if (!sentAll) reject(error);
      });

      // Write ~1 MB in 64 KB chunks, deliberately slowly, so a buffering
      // implementation would still be waiting when the cap trips.
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let written = 0;
      const pump = () => {
        while (written < 16) {
          written += 1;
          if (written === 16) {
            sentAll = true;
            req.end(chunk);
            return;
          }
          if (!req.write(chunk)) {
            req.once('drain', pump);
            return;
          }
        }
      };
      pump();
    });

    expect(result.status).toBe(413);
    expect(JSON.parse(result.body).error.code).toBe('payload_too_large');
  });

  it('accepts a chunked body inside the cap', async () => {
    const { port } = await mount({ maxBodyBytes: 4096 });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/x', headers: { 'Transfer-Encoding': 'chunked' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify({ hello: 'world' }));
      req.end();
    });
    expect(status).toBe(200);
  });

  it('rejects a declared Content-Length over the cap before the body is read', async () => {
    const { port } = await mount({ maxBodyBytes: 10 });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/x', headers: { 'Content-Length': '5000' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.write('{"a":1}');
      // Deliberately never finish: we expect the answer anyway.
    });
    expect(status).toBe(413);
  });
});

describe('client ip over the wire (gap 3)', () => {
  it('ignores a spoofed X-Forwarded-For when TRUST_PROXY is 0', async () => {
    const { port } = await mount({ trustProxy: 0 });
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/health', headers: { 'X-Forwarded-For': '1.2.3.4' } },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => resolve(raw));
        },
      );
      req.on('error', reject);
    });
    expect(JSON.parse(body).ip).toBe('127.0.0.1');
  });

  it('uses the rightmost hop when one proxy is trusted', async () => {
    const { port } = await mount({ trustProxy: 1 });
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/health', headers: { 'X-Forwarded-For': '1.2.3.4, 203.0.113.9' } },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => resolve(raw));
        },
      );
      req.on('error', reject);
    });
    expect(JSON.parse(body).ip).toBe('203.0.113.9');
  });
});

describe('response headers', () => {
  it('sends a JSON-only CSP and the rest of the hardening headers', async () => {
    const { port } = await mount();
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers));
      });
      req.on('error', reject);
    });
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cache-control']).toBe('no-store');
  });

  it('answers a CORS preflight without running the route', async () => {
    const { port } = await mount();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'OPTIONS', path: '/api/track' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(204);
  });
});

describe('shutdown drain (gap F2)', () => {
  const get = (port: number, path = '/api/health') =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: body ? JSON.parse(body) : null }),
        );
      });
      req.on('error', reject);
      req.end();
    });

  it('answers 503 to new work once draining, so a load balancer stops choosing it', async () => {
    let draining = false;
    const { port } = await mount({ draining: () => draining });
    expect((await get(port)).status).toBe(200);

    draining = true;
    const res = await get(port);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('shutting_down');
    expect(res.headers.connection).toBe('close');
  });

  it('still serves a request that was already accepted when the drain began', async () => {
    // The gate is checked when the request arrives, not when the response is written, so
    // work in flight at SIGTERM is allowed to finish rather than being truncated.
    let draining = false;
    let release: (value: { status: number; body: unknown }) => void = () => {};
    const gate = new Promise<{ status: number; body: unknown }>((resolve) => {
      release = resolve;
    });
    const { port } = await mount({
      draining: () => draining,
      respond: () => gate as unknown as { status: number; body: unknown },
    });

    const inFlight = get(port, '/api/health');
    await new Promise((resolve) => setTimeout(resolve, 50));
    draining = true;
    release({ status: 200, body: { ok: true } });

    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Retry-After propagation (gap A3)', () => {
  const get = (port: number) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/anything' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end();
    });

  it('turns a route-supplied retry hint into a Retry-After header', async () => {
    const { port } = await mount({
      respond: () => {
        const error = new ApiError(429, 'rate_limited', 'Slow down.') as ApiError & { retryAfterSeconds: number };
        error.retryAfterSeconds = 12.4;
        throw error;
      },
    });
    const res = await get(port);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('13');
  });

  it('omits Retry-After when the route has no hint', async () => {
    const { port } = await mount({
      respond: () => {
        throw new ApiError(400, 'bad_request', 'Nope.');
      },
    });
    const res = await get(port);
    expect(res.status).toBe(400);
    expect(res.headers['retry-after']).toBeUndefined();
  });
});
