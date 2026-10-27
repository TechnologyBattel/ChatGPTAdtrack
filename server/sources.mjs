// Source connections and their ingest keys.
//
// A source connection is one authorized integration for one workspace: the existing
// OpenAI Ads connection, a CRM that reports qualified leads, a Search Console import.
// Each connection owns its own keys, so revoking one customer's integration cannot
// affect another's, and rotation is per connection rather than per deployment.
//
// Key material: the secret is returned exactly once, at creation or rotation, and is
// stored on the server record. These records live in the server-side store, reached
// only with Admin credentials (firestore.rules denies all client access), so the
// secret never travels to a browser. A production deployment should hand the value
// straight into the customer's secret manager; this module cannot do that for them and
// does not pretend to.

import { randomBytes, createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { oneOf, text } from './validate.mjs';

export const PROVIDERS = ['openai_ads', 'crm', 'search_console', 'generic'];

/** Read-only unless the provider is one this product is allowed to write to. */
export const WRITE_CAPABLE_PROVIDERS = new Set(['openai_ads']);

const keyDocId = (sourceConnectionId, keyVersion) => `${sourceConnectionId}.${keyVersion}`;

function newSecret() {
  // 32 bytes of entropy, base64url: comfortably above the 32-character minimum the
  // global ingest keys require, and safe to paste into a header.
  return randomBytes(32).toString('base64url');
}

/** Non-reversible fingerprint, safe to show in a UI and to log. */
export function secretFingerprint(secret) {
  return `sha256:${createHash('sha256').update(String(secret)).digest('hex').slice(0, 12)}`;
}

export function createSources({ store, tenancy, now = () => Date.now() } = {}) {
  if (!store?.records) throw new Error('createSources requires a store with records.');

  async function create({ principal, organizationId, workspaceId, body }) {
    const ctx = await tenancy.context(principal, organizationId, 'source.manage');
    await tenancy.workspace(organizationId, workspaceId, { role: ctx.role });

    const provider = oneOf(body?.provider, PROVIDERS, 'provider');
    const capability = oneOf(body?.capability ?? 'read', ['read', 'write'], 'capability');
    if (capability === 'write' && !WRITE_CAPABLE_PROVIDERS.has(provider)) {
      throw new ApiError(
        400,
        'write_not_supported',
        `${provider} is connected read-only in this product. Writing to an advertising account is limited to ${[...WRITE_CAPABLE_PROVIDERS].join(', ')}.`,
      );
    }
    // Trusting a source to qualify leads is a real decision, so it is explicit and
    // recorded rather than inferred from the provider name.
    const trustedForQualification = body?.trustedForQualification === true;
    if (trustedForQualification && provider !== 'crm') {
      throw new ApiError(400, 'trusted_source_must_be_crm', 'Only a CRM source may be trusted to qualify leads.');
    }

    const sourceConnectionId = `src_${randomBytes(9).toString('base64url')}`;
    const version = 'v1';
    const secret = newSecret();
    const record = {
      sourceConnectionId,
      organizationId,
      workspaceId,
      provider,
      label: text(body?.label ?? `${provider} connection`, 'label', { max: 120 }),
      capability,
      status: 'connected',
      trustedForQualification,
      // Nothing has synced yet; saying "never" is honest, a timestamp would not be.
      lastSyncAt: null,
      createdAt: now(),
      createdBy: principal.uid,
    };
    await store.records.put('sources', sourceConnectionId, record, { orgId: organizationId });
    await store.records.put('ingestKeys', keyDocId(sourceConnectionId, version), {
      sourceConnectionId,
      organizationId,
      workspaceId,
      keyVersion: version,
      secret,
      fingerprint: secretFingerprint(secret),
      status: 'active',
      createdAt: now(),
      revokedAt: null,
      trustedForQualification,
    });
    await tenancy.audit({
      action: 'source.create',
      organizationId,
      workspaceId,
      actor: principal.uid,
      actorRole: ctx.role,
      target: sourceConnectionId,
      detail: { provider, capability, trustedForQualification },
    });
    return { source: record, key: { keyId: `${sourceConnectionId}.${version}`, keyVersion: version, secret } };
  }

  async function list({ principal, organizationId, workspaceId }) {
    const ctx = await tenancy.context(principal, organizationId, 'data.read');
    await tenancy.workspace(organizationId, workspaceId, { role: ctx.role });
    const list = await store.records.list('sources', { orgId: organizationId, where: { workspaceId } });
    // Never return key material, not even the fingerprint of a live secret.
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function rotate({ principal, organizationId, workspaceId, sourceConnectionId }) {
    const ctx = await tenancy.context(principal, organizationId, 'source.manage');
    const source = await store.records.get('sources', sourceConnectionId, { orgId: organizationId });
    if (!source || source.workspaceId !== workspaceId)
      throw new ApiError(404, 'not_found', 'No such source connection.');

    // Key records are global by design: `resolveKey` must find a key without first
    // knowing the tenant, and the record itself carries the tenant it unlocks.
    const keys = await store.records.list('ingestKeys', { where: { sourceConnectionId } });
    const active = keys.filter((k) => k.status === 'active');
    const nextVersion = `v${active.length + keys.length + 1}`;
    const secret = newSecret();
    await store.records.put('ingestKeys', keyDocId(sourceConnectionId, nextVersion), {
      sourceConnectionId,
      organizationId,
      workspaceId,
      keyVersion: nextVersion,
      secret,
      fingerprint: secretFingerprint(secret),
      status: 'active',
      createdAt: now(),
      revokedAt: null,
      trustedForQualification: source.trustedForQualification,
    });
    await tenancy.audit({
      action: 'source.rotate',
      organizationId,
      workspaceId,
      actor: principal.uid,
      actorRole: ctx.role,
      target: sourceConnectionId,
      // Old keys stay valid until revoked, so a rotation is not an outage.
      detail: { keyVersion: nextVersion, stillActive: active.map((k) => k.keyVersion) },
    });
    return {
      sourceConnectionId,
      key: { keyId: `${sourceConnectionId}.${nextVersion}`, keyVersion: nextVersion, secret },
    };
  }

  async function revoke({ principal, organizationId, workspaceId, sourceConnectionId, keyVersion }) {
    const ctx = await tenancy.context(principal, organizationId, 'source.manage');
    const source = await store.records.get('sources', sourceConnectionId, { orgId: organizationId });
    if (!source || source.workspaceId !== workspaceId)
      throw new ApiError(404, 'not_found', 'No such source connection.');

    const keys = await store.records.list('ingestKeys', { where: { sourceConnectionId } });
    const targets = keyVersion ? keys.filter((k) => k.keyVersion === keyVersion) : keys;
    if (!targets.length) throw new ApiError(404, 'not_found', 'No such key version.');
    for (const key of targets) {
      await store.records.update('ingestKeys', keyDocId(sourceConnectionId, key.keyVersion), {
        status: 'revoked',
        revokedAt: now(),
      });
    }
    if (!keyVersion) {
      await store.records.update('sources', sourceConnectionId, { status: 'revoked' }, { orgId: organizationId });
    }
    await tenancy.audit({
      action: 'source.revoke',
      organizationId,
      workspaceId,
      actor: principal.uid,
      actorRole: ctx.role,
      target: sourceConnectionId,
      detail: { keyVersion: keyVersion ?? 'all' },
    });
    return { sourceConnectionId, revoked: targets.map((k) => k.keyVersion) };
  }

  /** Disconnect: revoke every key and mark the connection disconnected. */
  async function disconnect({ principal, organizationId, workspaceId, sourceConnectionId }) {
    const result = await revoke({ principal, organizationId, workspaceId, sourceConnectionId });
    await store.records.update(
      'sources',
      sourceConnectionId,
      { status: 'disconnected', disconnectedAt: now() },
      { orgId: organizationId },
    );
    return { ...result, status: 'disconnected' };
  }

  /**
   * Resolve the key named by a request header. Returns the *stored* key record, whose
   * organization/workspace are the authoritative tenant for the event.
   *
   * The lookup is by `sourceConnectionId.keyVersion`, both opaque, so a caller cannot
   * enumerate tenants. A revoked key and a nonexistent key give the same 401.
   */
  async function resolveKey(keyHeader) {
    const raw = String(keyHeader ?? '').trim();
    if (!raw) return null;
    const record = await store.records.get('ingestKeys', raw);
    if (!record) return null;
    if (record.status !== 'active') return null;
    return record;
  }

  return { create, list, rotate, revoke, disconnect, resolveKey, secretFingerprint };
}
