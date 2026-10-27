// Content-Security-Policy for the app shell.
//
// One policy object, used by the Vite dev/preview servers (which serve the HTML
// during development and preview) and by the checks in scripts/check-server.mjs.
// Static hosting must send the same `production` string — docs/SECURITY.md says
// where, so the header has exactly one definition in this repo.
//
// Production forbids inline script entirely. That is only possible because
// index.html ships no inline <script> and the build emits external modules.
//
// Development has to relax two things: the React refresh preamble is an inline
// script, and Vite injects styles as inline <style> tags until the CSS is built.
// The dev policy therefore allows 'unsafe-inline' for script and style, and ws:
// for HMR. It is never served in production, and the difference is asserted by a
// test rather than trusted.

const PROD_CONNECT = [
  "'self'",
  // Firebase Auth REST endpoints, for builds configured with VITE_FIREBASE_API_KEY.
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
];

export function contentSecurityPolicy({ dev = false } = {}) {
  const directives = {
    'default-src': ["'self'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': dev ? [...PROD_CONNECT, 'ws:', 'wss:'] : PROD_CONNECT,
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  const policy = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
  return {
    'Content-Security-Policy': policy,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
}

/** The exact header set a static host must send in production. */
export const productionHeaders = Object.freeze(contentSecurityPolicy({ dev: false }));
