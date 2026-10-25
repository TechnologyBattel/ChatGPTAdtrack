// node:http <-> app bridge.
//
// Kept apart from server.mjs so the transport rules (body cap, client IP, headers)
// can be mounted on an ephemeral port in tests without starting the real server or
// needing real configuration.

import { ApiError } from './errors.mjs';
import { assertDeclaredSize, clientIp, readJsonBodyWithRaw } from './limits.mjs';

/** The API serves JSON only, so the policy can stay maximal here. */
export const API_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/**
 * opts.app        the routed application (createApp(...))
 * opts.maxBodyBytes   streaming cap for request bodies
 * opts.trustProxy     number of our own proxy hops to skip from the right of XFF
 * opts.logger         optional
 */
export function createRequestListener({ app, maxBodyBytes = 256 * 1024, trustProxy = 0, logger = console } = {}) {
  if (!app || typeof app.handle !== 'function') throw new Error('createRequestListener requires an app.');

  return async function listener(req, res) {
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        ...API_SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        // A body we refused to finish reading leaves unread bytes in the socket;
        // the connection cannot be reused, so say so instead of hanging.
        ...(status === 413 ? { Connection: 'close' } : {}),
      });
      res.end(payload, () => {
        // Free the socket without waiting for the client to send the rest of a body
        // we already rejected. The response is flushed at this point.
        if (status === 413 && typeof req.destroy === 'function') req.destroy();
      });
    };

    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return send(400, { error: { code: 'bad_url', message: 'Malformed request URL.' } });
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET,POST,OPTIONS' });
      return res.end();
    }

    try {
      let body = {};
      let rawBody = '';
      if (req.method === 'POST') {
        // Declared length first (cheap and conclusive), then the streaming cap, so a
        // chunked body with no Content-Length is still bounded and abandoned early.
        assertDeclaredSize(req.headers, maxBodyBytes);
        const parsed = await readJsonBodyWithRaw(req, { maxBytes: maxBodyBytes });
        body = parsed.body;
        // The raw bytes are needed by the HMAC-signed ingest route, which signs what
        // the sender signed rather than a re-serialisation of it.
        rawBody = parsed.raw;
      }
      const result = await app.handle({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        ip: clientIp(req.headers, req.socket?.remoteAddress, { trustProxy }),
        body,
        rawBody,
      });
      return send(result.status, result.body);
    } catch (error) {
      const e =
        error instanceof ApiError ? error : new ApiError(500, 'internal_error', String(error?.message ?? error));
      if (e.status >= 500) logger.error?.(`[api] ${e.code}: ${e.message}`);
      return send(e.status, { error: { code: e.code, message: e.message } });
    }
  };
}
