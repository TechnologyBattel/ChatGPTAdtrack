// Sessions and measurement consent.
//
// Who can obtain a consent id
// ---------------------------
// Anyone who can reach POST /api/session from an allowed origin, followed by
// POST /api/consent with `granted: true`. That is deliberate: the visitor's own
// browser is the only party that can grant consent, and we cannot authenticate a
// visitor we have no account for. What makes it safe is not secrecy but constraints:
//
//   * a session is required first, is bound to the browser that created it (a
//     SHA-256 of the user agent, so no raw UA string is stored), and expires in
//     SESSION_TTL_SECONDS (default 30 min). A consent id presented from a different
//     user agent is refused; a changed IP is recorded as a soft signal and does not
//     refuse, because mobile clients legitimately switch networks;
//   * a consent id is bound to that one session, carries an explicit scope set, and
//     expires in CONSENT_TTL_SECONDS (default 15 min);
//   * it is single use. The first delivery attempt *claims* it; the claim becomes a
//     consumption only when the upstream API accepts the event (see store.mjs). A
//     second claim is refused as in-flight, a replay after delivery as replayed;
//   * both routes are rate limited per IP and origin-checked;
//   * signatures are HMAC-SHA256 with a versioned key, so rotation does not
//     invalidate ids that are still inside their short TTL.
//
// The grant is persisted through the storage interface, which is what makes the
// claim/consume split real rather than advisory.

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

/** Sessions bind to a browser, not to an IP: hash the user agent, never store it. */
export function userAgentHash(userAgent) {
  return createHash('sha256')
    .update(String(userAgent ?? ''))
    .digest('base64url')
    .slice(0, 32);
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
  async function createSession({ ip, userAgent } = {}) {
    const sessionId = `sess_${randomBytes(18).toString('base64url')}`;
    const createdAt = now();
    const expiresAt = createdAt + sessionTtlSeconds * 1000;
    const record = {
      sessionId,
      ip: ip ?? null,
      uaHash: userAgentHash(userAgent),
      createdAt,
      expiresAt,
    };
    // Persisted before the caller sees the id, so a race cannot mint one we cannot verify.
    await store.sessions.create(record);
    return {
      sessionId,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlSeconds: sessionTtlSeconds,
    };
  }

  /**
   * Resolve a session and check that it belongs to this browser.
   *
   * The user agent hash is enforced: a consent id stolen from another browser is
   * useless. The IP is *not* enforced — it is returned as `ipChanged` so the caller
   * can log it, because refusing on IP change breaks real visitors on mobile
   * networks, and a shared NAT makes the IP a weak signal anyway.
   */
  async function requireSession(sessionId, { ip, userAgent } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.startsWith('sess_')) {
      throw new ApiError(403, 'session_required', 'A tracking session is required before consent can be recorded.');
    }
    const session = await store.sessions.get(sessionId);
    if (!session) throw new ApiError(403, 'session_invalid', 'Session is unknown or has expired. Start a new session.');
    if (session.uaHash && userAgent !== undefined && userAgentHash(userAgent) !== session.uaHash) {
      throw new ApiError(
        403,
        'session_client_mismatch',
        'This session belongs to a different client. Start a new session.',
      );
    }
    return { ...session, ipChanged: Boolean(session.ip && ip && session.ip !== ip) };
  }

  // ------------------------------------------------------------------- consent
  async function grant({ sessionId, scopes = ['measurement'], subjectHash, ip, userAgent } = {}) {
    const session = await requireSession(sessionId, { ip, userAgent });
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
      pendingAt: null,
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
   * Verify and *reserve* a consent id for one delivery attempt. Nothing is consumed
   * here: if the upstream call fails, the id stays usable for the retry.
   */
  async function claim({ consentId, sessionId, scope = 'measurement', ip, userAgent, owner = 'direct' } = {}) {
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
    if (sessionId) await requireSession(sessionId, { ip, userAgent });

    const record = await store.consents.claim({ consentId, sessionId, owner });
    return {
      scopes: record.scopes ?? payload.scopes,
      grantedAt: new Date((record.issuedAt ?? payload.iat * 1000) || payload.iat * 1000).toISOString(),
      expiresAt: new Date((record.expiresAt ?? payload.exp * 1000) || payload.exp * 1000).toISOString(),
      subject: record.subject ?? payload.sub ?? null,
      keyVersion: payload.kv,
      claimedAt: new Date(record.pendingAt ?? now()).toISOString(),
    };
  }

  /**
   * Mark the claim delivered. Called only after the upstream API accepted the event.
   *
   * `allowExpired` is for the outbox: an event captured inside the consent window may
   * be delivered after it, and the grant was valid when it was captured. The direct
   * path leaves it false, so an id that expired mid-flight is refused rather than
   * quietly accepted.
   */
  async function consume({ consentId, sessionId, scope = 'measurement', allowExpired = false } = {}) {
    // Verify the signature and lifetime here too: consuming an id we never signed (or
    // one signed with a retired key) must fail for the same reasons as claiming it.
    const payload = decode(consentId);
    if (!allowExpired && (typeof payload.exp !== 'number' || payload.exp * 1000 <= now())) {
      throw new ApiError(403, 'consent_expired', 'Consent has expired; ask the visitor again.');
    }
    if (!Array.isArray(payload.scopes) || !payload.scopes.includes(scope)) {
      throw new ApiError(403, 'consent_scope_missing', `Consent does not include the "${scope}" scope.`);
    }
    if (payload.sid !== sessionId) {
      throw new ApiError(403, 'consent_session_mismatch', 'Consent id belongs to a different session.');
    }
    const record = await store.consents.consume({ consentId, sessionId, allowExpired });
    return {
      scopes: record.scopes,
      grantedAt: new Date(record.issuedAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
      subject: record.subject ?? null,
      keyVersion: record.keyVersion,
      consumedAt: new Date(record.consumedAt).toISOString(),
    };
  }

  /** Give the claim back without marking it used — used when the event can never be delivered. */
  async function release({ consentId } = {}) {
    return store.consents.release({ consentId });
  }

  return {
    createSession,
    requireSession,
    grant,
    claim,
    consume,
    release,
    secrets: () => secrets.map((s) => s.version),
    currentVersion,
  };
}
