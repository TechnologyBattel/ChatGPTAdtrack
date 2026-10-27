// Authentication and authorisation.
//
// Two verifiers, both pluggable so tests never need a network or a real token:
//   dev      — a shared dev token minted by POST /api/dev/session (never in production)
//   firebase — Firebase ID tokens, verified with the official Admin SDK
//
// Failure is always closed: an unknown mode, a missing verifier or a missing
// token rejects the request. Nothing here falls back to "allow".

import { timingSafeEqual, randomBytes } from 'node:crypto';
import { ApiError } from './errors.mjs';

// The *principal* role is the global claim on the token. Per-organization
// authorization lives in server/tenancy.mjs, which is what the agency routes use;
// this list only has to accept every role a token may legitimately carry.
export const ROLES = ['viewer', 'analyst', 'editor', 'admin', 'owner'];

/** Roles that may change something on the ad account. */
export const WRITE_ROLES = new Set(['admin', 'owner']);

export function hasRole(principal, allowed) {
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  return Boolean(principal && set.has(principal.role));
}

/**
 * Constant-time comparison for opaque tokens. Length differences are compared
 * first because timingSafeEqual throws on mismatched lengths.
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function bearerToken(headers = {}) {
  const raw = headers.authorization ?? headers.Authorization;
  if (typeof raw !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
}

/**
 * firebase-admin is an *optional* dependency: the demo, the tests and any
 * dev-auth deployment must work without it installed. It is imported lazily, on
 * first use, and only when AUTH_MODE=firebase. `importAdmin` is injectable so a
 * test can simulate "not installed" without touching node_modules.
 */
export function createAdminLoader({ projectId, credential, adminModule, importAdmin } = {}) {
  let ready = null;

  return async function loadAdmin() {
    if (ready) return ready;
    ready = (async () => {
      let admin = adminModule;
      if (!admin) {
        try {
          const importer = importAdmin ?? ((name) => import(name));
          admin = await importer('firebase-admin');
        } catch (error) {
          const reason =
            error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String(error?.message))
              ? 'not installed'
              : String(error?.message ?? error);
          throw new ApiError(
            500,
            'auth_not_configured',
            `AUTH_MODE=firebase but firebase-admin is ${reason}. It is an optionalDependency: install it only where Firebase auth is used.`,
          );
        }
      }
      if (!projectId) {
        throw new ApiError(500, 'auth_not_configured', 'AUTH_MODE=firebase but FIREBASE_PROJECT_ID is not set.');
      }
      if (!admin.apps?.length) {
        admin.initializeApp({ projectId, ...(credential ? { credential } : {}) });
      }
      return admin;
    })();
    return ready;
  };
}

/** Firebase ID token verification via firebase-admin. */
export function createFirebaseVerifier({ projectId, credential, adminModule, importAdmin } = {}) {
  const load = createAdminLoader({ projectId, credential, adminModule, importAdmin });

  return async function verifyFirebase(token) {
    const admin = await load();
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(token, true); // checkRevoked
    } catch (error) {
      throw new ApiError(401, 'invalid_token', `ID token rejected: ${error?.message ?? 'unknown reason'}`);
    }
    const role = ROLES.includes(decoded.role) ? decoded.role : 'viewer';
    return { uid: decoded.uid ?? decoded.sub, role, via: 'firebase' };
  };
}

/**
 * Build the auth gate.
 *
 * opts.mode          'dev' | 'firebase'
 * opts.devToken      opaque token accepted in dev mode
 * opts.devRole       role granted to the dev token (default 'owner')
 * opts.verifyToken   (token) => Promise<principal>; injected by tests
 */
export function createAuth({ mode, devToken, devRole = 'owner', verifyToken } = {}) {
  if (mode !== 'dev' && mode !== 'firebase') {
    throw new Error(`Unsupported AUTH_MODE: ${mode}. Refusing to start.`);
  }
  if (mode === 'dev' && !devToken) {
    throw new Error('Dev auth mode requires a token. Refusing to start with anonymous access.');
  }
  if (mode === 'firebase' && typeof verifyToken !== 'function') {
    throw new Error('Firebase auth mode requires a token verifier.');
  }
  if (!ROLES.includes(devRole)) {
    throw new Error(`Unknown dev role: ${devRole}`);
  }

  return {
    mode,

    /** Throws 401 when there is no valid credential. */
    async authenticate(headers) {
      const token = bearerToken(headers);
      if (!token) throw new ApiError(401, 'unauthenticated', 'Authorization: Bearer <token> is required.');
      if (mode === 'dev') {
        if (!safeEqual(token, devToken)) throw new ApiError(401, 'invalid_token', 'Dev token is not valid.');
        return { uid: 'dev-user', role: devRole, via: 'dev' };
      }
      return verifyToken(token);
    },

    /** Throws 403 when the principal lacks a write role. */
    requireWrite(principal) {
      if (!hasRole(principal, WRITE_ROLES)) {
        throw new ApiError(
          403,
          'forbidden',
          `This action requires a write role (${[...WRITE_ROLES].join(' or ')}); you have ${principal?.role ?? 'none'}.`,
        );
      }
      return principal;
    },

    /** Only meaningful in dev mode. Returns null in firebase mode. */
    issueDevSession() {
      if (mode !== 'dev') return null;
      return { token: devToken, role: devRole, expiresAt: null };
    },
  };
}

export function generateDevToken() {
  return `dev_${randomBytes(24).toString('hex')}`;
}
