// Server-verifiable measurement consent.
//
// A boolean in the request body is not consent: the client can always send
// `true`. Instead the browser records consent once (POST /api/consent) and gets
// back an opaque, HMAC-signed id. /api/track then requires that id, and the
// server verifies signature, scope and expiry before any event is forwarded.
//
// Stateless by design so the demo needs no database. Production should also
// persist the grant (subject, scopes, version, timestamp) for the audit trail
// required by DPDP/GDPR — see docs/PRIVACY.md.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.mjs';

export const CONSENT_SCOPES = ['measurement'];

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createConsentStore({ secret, ttlSeconds = 60 * 60 * 24 * 180, now = () => Date.now() } = {}) {
  if (!secret || String(secret).length < 16) {
    throw new Error('Consent signing needs a secret of at least 16 characters.');
  }

  function issue({ scopes = ['measurement'], subjectHash } = {}) {
    const clean = scopes.filter((s) => CONSENT_SCOPES.includes(s));
    if (clean.length === 0)
      throw new ApiError(400, 'no_valid_scope', `Consent needs at least one of: ${CONSENT_SCOPES.join(', ')}.`);
    const body = JSON.stringify({
      v: 1,
      jti: randomBytes(12).toString('base64url'),
      scopes: clean,
      sub: subjectHash ?? null,
      iat: Math.floor(now() / 1000),
      exp: Math.floor(now() / 1000) + ttlSeconds,
    });
    const encoded = base64url(body);
    const consentId = `${encoded}.${sign(secret, encoded)}`;
    return { consentId, scopes: clean, expiresAt: new Date(JSON.parse(body).exp * 1000).toISOString() };
  }

  function verify(consentId, requiredScope = 'measurement') {
    if (typeof consentId !== 'string' || consentId.length < 10) {
      throw new ApiError(403, 'consent_required', 'A server-issued consent id is required; a boolean is not consent.');
    }
    const [encoded, signature] = consentId.split('.');
    if (!encoded || !signature) {
      throw new ApiError(403, 'consent_required', 'Consent id is malformed.');
    }
    const expected = sign(secret, encoded);
    const given = Buffer.from(signature);
    const wanted = Buffer.from(expected);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      throw new ApiError(403, 'consent_invalid', 'Consent id signature is not valid.');
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new ApiError(403, 'consent_invalid', 'Consent id payload is unreadable.');
    }
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now()) {
      throw new ApiError(403, 'consent_expired', 'Consent has expired; ask the visitor again.');
    }
    if (!Array.isArray(payload.scopes) || !payload.scopes.includes(requiredScope)) {
      throw new ApiError(403, 'consent_scope_missing', `Consent does not include the "${requiredScope}" scope.`);
    }
    return {
      scopes: payload.scopes,
      grantedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      subject: payload.sub,
    };
  }

  return { issue, verify };
}
