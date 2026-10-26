// Structured logging for the API process.
//
// Two rules shape this module:
//
//   1. A log line is an operational record, not a debug dump. It carries a request id, the
//      method, the *route* (never the query string — it can hold an email address), the
//      status, the duration and the client address. It never carries a body, an
//      Authorization header, a token, or a provider payload.
//   2. The same event is one line of JSON when LOG_FORMAT=json, so a log-based alert can
//      match on fields instead of regexes against prose. Text mode exists for a developer's
//      terminal and is not what staging or production should run.

import { randomUUID } from 'node:crypto';

/** Fields that must never be logged, whatever a caller passes. */
const FORBIDDEN_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'access_token',
  'refresh_token',
  'client_secret',
  'secret',
  'password',
  'body',
  'rawbody',
  'apikey',
  'api_key',
]);

/** Strip a query string: `/api/orgs?email=a@b.com` logs as `/api/orgs`. */
export function routeOf(path) {
  const raw = String(path ?? '/');
  const cut = raw.indexOf('?');
  return cut === -1 ? raw : raw.slice(0, cut);
}

function scrub(fields = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      clean[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      // Defence in depth: a caller can put a token in a message field.
      clean[key] = value
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
        .replace(/(access_token|refresh_token)=[^\s&,;]+/gi, '$1=[redacted]')
        .slice(0, 500);
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

export function createLogger({ format = 'text', sink = console, now = () => Date.now() } = {}) {
  const json = format === 'json';

  function emit(level, message, fields = {}) {
    const record = {
      ts: new Date(now()).toISOString(),
      level,
      message: String(message).slice(0, 500),
      ...scrub(fields),
    };
    if (json) {
      const line = JSON.stringify(record);
      if (level === 'error') sink.error?.(line);
      else if (level === 'warn') sink.warn?.(line);
      else sink.log?.(line);
      return record;
    }
    const suffix = Object.entries(scrub(fields))
      .filter(([key]) => !['ts', 'level', 'message'].includes(key))
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    const line = `${record.ts} ${level} ${record.message}${suffix ? ` ${suffix}` : ''}`;
    if (level === 'error') sink.error?.(line);
    else if (level === 'warn') sink.warn?.(line);
    else sink.log?.(line);
    return record;
  }

  return {
    format,
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    /** A completed request. `requestId` lets one line be found across services. */
    request: (fields = {}) =>
      emit(fields.status >= 500 ? 'error' : fields.status >= 400 ? 'warn' : 'info', 'request', {
        ...fields,
        route: routeOf(fields.route ?? fields.path),
        path: undefined,
      }),
    child: (base = {}) => ({
      info: (message, fields) => emit('info', message, { ...base, ...fields }),
      warn: (message, fields) => emit('warn', message, { ...base, ...fields }),
      error: (message, fields) => emit('error', message, { ...base, ...fields }),
    }),
  };
}

export function newRequestId() {
  return randomUUID();
}
