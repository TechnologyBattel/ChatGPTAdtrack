// Sealing for connector credentials (OAuth access/refresh tokens).
//
// Token storage is the one place in this product that holds a credential that can read a
// customer's CRM. It gets its own treatment:
//
//   * AES-256-GCM, so the ciphertext is authenticated and a modified byte is an error,
//     not a different token.
//   * The tenant ids are used as additional authenticated data (AAD). A sealed token
//     copied from one tenant's record into another's cannot be opened, because the
//     decryption is bound to the exact (org, workspace, source) it was sealed for.
//   * A version prefix (`v1.`) so a future scheme can be introduced without guessing at
//     what an old blob means.
//
// The key comes from CONNECTOR_ENCRYPTION_KEY (32 bytes, base64 or hex). It is never
// derived from another secret, never logged, and never leaves the process.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Parse CONNECTOR_ENCRYPTION_KEY. Returns a Buffer, or null when unset. */
export function parseEncryptionKey(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, 'hex');
  else {
    try {
      key = Buffer.from(value, 'base64');
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new Error('CONNECTOR_ENCRYPTION_KEY must be 32 bytes, encoded as base64 (44 chars) or hex (64 chars).');
  }
  return key;
}

/** AAD binds a sealed value to one tenant's record. */
export function tenantAad({ organizationId, workspaceId, sourceConnectionId }) {
  return Buffer.from(`${organizationId}:${workspaceId}:${sourceConnectionId}`, 'utf8');
}

export function seal(plaintext, key, { aad } = {}) {
  if (!key) throw new Error('connector encryption key is not configured');
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new Error('nothing to seal');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** Returns the plaintext, or null for anything that does not authenticate. */
export function open(sealed, key, { aad } = {}) {
  if (!key || typeof sealed !== 'string') return null;
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong tenant, truncated or tampered value: all indistinguishable.
    return null;
  }
}
