// Sessions and measurement consent.
//
// Who can obtain a consent id
// ---------------------------
// Anyone who can reach POST /api/session from an allowed origin, followed by
// POST /api/consent with `granted: true`. That is deliberate: the visitor's own
// browser is the only party that can grant consent, and we cannot authenticate a
// visitor we have no account for. What makes it safe is not secrecy but constraints:
//
//   * a session is required first, is bound to the request IP and user agent, and
//     expires in SESSION_TTL_SECONDS (default 30 min);
//   * a consent id is bound to that one session, carries an explicit scope set, and
//     expires in CONSENT_TTL_SECONDS (default 15 min);
//   * it is single-use: the first /api/track call consumes it. A replay, or use
//     from another session, is refused;
//   * both routes are rate limited per IP and origin-checked;
//   * signatures are HMAC-SHA256 with a versioned key, so rotation does not
//     invalidate ids that are still inside their short TTL.
//
// The grant is persisted through the storage interface, which is what makes replay
// detection real rather than advisory.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.mjs';

export const CONSENT_SCOPES = ['measurement'];
const TOKEN_VERSION = 1;

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function hmac(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function sameSignature(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/**
 * opts.secrets        [{version:'v2', secret:'…'}, {version:'v1', secret:'…'}]
 * opts.currentVersion version used to sign new ids
 * opts.store          storage interface (sessions, consents)
 */
export function createConsentService({
  secrets,
  currentVersion,
  store,
  sessionTtlSeconds = 30 * 60,
  consentTtlSeconds = 15 * 60,
  now = () => Date.now(),
} = {}) {
  if (!store) throw new Error('createConsentService requires a store.');
  if (!Array.isArray(secrets) || secrets.length === 0)
    throw new Error('createConsentService requires at least one signing secret.');
  if (!secrets.some((s) => s.version === currentVersion)) {
    throw new Error(`Current consent secret version ${currentVersion} is not in the secret list.`);
  }

  const secretFor = (version) => secrets.find((s) => s.version === version)?.secret ?? null;

  // ------------------------------------------------------------------ sessions
  function createSession({ ip, userAgent } = {}) {
    const sessionId = `sess_${randomBytes(18).toString('base64url')}`;
    const createdAt = now();
    const expiresAt = createdAt + sessionTtlSeconds * 1000;
    // Persisted before the caller sees the id, so a race cannot mint one we cannot verify.
    const created = store.sessions.create({
      sessionId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      createdAt,
      expiresAt,
    });
    return Promise.resolve(created).then(() => ({
      sessionId,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlSeconds: sessionTtlSeconds,
    }));
  }

  async function requireSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.startsWith('sess_')) {
      throw new ApiError(403, 'session_required', 'A tracking session is required before consent can be recorded.');
    }
    const session = await store.sessions.get(sessionId);
    if (!session) throw new ApiError(403, 'session_invalid', 'Session is unknown or has expired. Start a new session.');
    return session;
  }

  // ------------------------------------------------------------------- consent
  async function grant({ sessionId, scopes = ['measurement'], subjectHash } = {}) {
    const session = await requireSession(sessionId);
    const clean = scopes.filter((s) => CONSENT_SCOPES.includes(s));
    if (clean.length === 0) {
      throw new ApiError(400, 'no_valid_scope', `Consent needs at least one of: ${CONSENT_SCOPES.join(', ')}.`);
    }

    const issuedAt = now();
    const expiresAt = issuedAt + consentTtlSeconds * 1000;
    const payload = {
      v: TOKEN_VERSION,
      kv: currentVersion,
      sid: session.sessionId,
      scopes: clean,
      sub: subjectHash ?? null,
      iat: Math.floor(issuedAt / 1000),
      exp: Math.floor(expiresAt / 1000),
      jti: randomBytes(12).toString('base64url'),
    };
    const encoded = b64url(JSON.stringify(payload));
    const consentId = `${encoded}.${hmac(secretFor(currentVersion), encoded)}`;

    await store.consents.save({
      consentId,
      sessionId: session.sessionId,
      scopes: clean,
      subject: payload.sub,
      keyVersion: currentVersion,
      issuedAt,
      expiresAt,
      consumedAt: null,
    });

    return { consentId, scopes: clean, expiresAt: new Date(expiresAt).toISOString(), ttlSeconds: consentTtlSeconds };
  }

  function decode(consentId) {
    if (typeof consentId !== 'string' || consentId.length < 20) {
      throw new ApiError(403, 'consent_required', 'A server-issued consent id is required; a boolean is not consent.');
    }
    const [encoded, signature] = consentId.split('.');
    if (!encoded || !signature) throw new ApiError(403, 'consent_required', 'Consent id is malformed.');

    let payload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new ApiError(403, 'consent_invalid', 'Consent id payload is unreadable.');
    }
    if (!payload || typeof payload !== 'object' || payload.v !== TOKEN_VERSION) {
      throw new ApiError(403, 'consent_invalid', 'Consent id has an unsupported version.');
    }
    const secret = secretFor(payload.kv);
    if (!secret) {
      // A retired key. Treated as invalid rather than unknown, so rotation cannot
      // be used to probe which versions once existed.
      throw new ApiError(
        403,
        'consent_invalid',
        'Consent id was signed with a key version this server no longer accepts.',
      );
    }
    if (!sameSignature(signature, hmac(secret, encoded))) {
      throw new ApiError(403, 'consent_invalid', 'Consent id signature is not valid.');
    }
    return payload;
  }

  /**
   * Verify and burn a consent id in one step. Everything is checked before the
   * event is forwarded, so a failure here means no upstream call at all.
   */
  async function consume({ consentId, sessionId, scope = 'measurement' } = {}) {
    const payload = decode(consentId);

    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now()) {
      throw new ApiError(403, 'consent_expired', 'Consent has expired; ask the visitor again.');
    }
    if (!Array.isArray(payload.scopes) || !payload.scopes.includes(scope)) {
      throw new ApiError(403, 'consent_scope_missing', `Consent does not include the "${scope}" scope.`);
    }
    // The signed session id and the presented one must agree before we touch storage.
    if (payload.sid !== sessionId) {
      throw new ApiError(403, 'consent_session_mismatch', 'Consent id belongs to a different session.');
    }
    const record = await store.consents.consume({ consentId, sessionId });

    return {
      scopes: record.scopes ?? payload.scopes,
      grantedAt: new Date((record.issuedAt ?? payload.iat * 1000) || payload.iat * 1000).toISOString(),
      expiresAt: new Date((record.expiresAt ?? payload.exp * 1000) || payload.exp * 1000).toISOString(),
      subject: record.subject ?? payload.sub ?? null,
      keyVersion: payload.kv,
      consumedAt: new Date(record.consumedAt ?? now()).toISOString(),
    };
  }

  return {
    createSession,
    requireSession,
    grant,
    consume,
    secrets: () => secrets.map((s) => s.version),
    currentVersion,
  };
}
