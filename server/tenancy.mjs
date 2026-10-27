// Tenancy: organizations, workspaces, membership and the permission matrix.
//
// The rule this module exists to enforce: *the organization an operation touches comes
// from the authenticated principal's membership, never from the request.* A caller may
// put any organization id in a URL; the only question the server asks is "is this
// principal a member of that organization, with a role that allows this?".
//
// Three failure modes, deliberately distinguishable:
//   404 not_found          — you are not a member (or it does not exist). Identical on
//                            purpose: a 403 here would confirm that an id is real.
//   403 forbidden          — you are a member, but your role does not allow this.
//   403 last_owner         — the operation would leave an organization owner-less.

import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { countryCode, idToken, languageTag, text, timeZone, currencyCode } from './validate.mjs';

/** Roles, lowest privilege first. Order is the rank used by the "no self-promotion" rules. */
export const ORG_ROLES = ['viewer', 'analyst', 'editor', 'admin', 'owner'];

const RANK = Object.fromEntries(ORG_ROLES.map((role, i) => [role, i + 1]));

/**
 * Permission matrix. Every route names a permission, never a role, so adding a role
 * does not mean editing every handler.
 *
 *   data.read        read reports/datasets
 *   report.export    export CSV/JSON
 *   research.read    read topics/questions
 *   research.write   create/edit topics
 *   campaign.read    read campaign registry
 *   campaign.write   create/edit campaigns + UTM links
 *   lead.read        read leads
 *   lead.qualify     mark a lead qualified (a human decision, recorded with the actor)
 *   workspace.write  create/edit workspaces, brands and defaults
 *   workspace.delete delete a workspace and its data
 *   member.manage    invite/remove members and change roles
 *   source.manage    connect/disconnect data sources and rotate their keys
 *   adaccount.push   write to a live advertising account (existing hint push)
 */
export const PERMISSIONS = [
  'data.read',
  'report.export',
  'research.read',
  'research.write',
  'campaign.read',
  'campaign.write',
  'lead.read',
  'lead.qualify',
  'workspace.write',
  'workspace.delete',
  'member.manage',
  'source.manage',
  'adaccount.push',
  // Private research: send clusters to a provider with the caller's own key. Granted only
  // to the roles that already hold `research.write`, because a model-named hint set is
  // research output and those roles already own that output.
  'research.private',
];

const MATRIX = {
  viewer: ['data.read', 'research.read', 'campaign.read', 'lead.read'],
  analyst: ['data.read', 'research.read', 'campaign.read', 'lead.read', 'report.export'],
  editor: [
    'data.read',
    'research.read',
    'research.write',
    'research.private',
    'campaign.read',
    'campaign.write',
    'lead.read',
    'lead.qualify',
    'report.export',
  ],
  admin: [
    'data.read',
    'research.read',
    'research.write',
    'research.private',
    'campaign.read',
    'campaign.write',
    'lead.read',
    'lead.qualify',
    'workspace.write',
    'member.manage',
    'source.manage',
    'adaccount.push',
    'report.export',
  ],
  owner: [...PERMISSIONS],
};

/** The permissions of one role, as an array in matrix order. */
export function permissionsFor(role) {
  return [...(MATRIX[role] ?? [])];
}

export function can(role, permission) {
  return Boolean(role && MATRIX[role]?.includes(permission));
}

export function assertPermission(role, permission, { resource = 'this action' } = {}) {
  if (!can(role, permission)) {
    throw new ApiError(
      403,
      'forbidden',
      `Your role (${role ?? 'none'}) cannot ${resource}. It needs the "${permission}" permission; ask an organization admin.`,
    );
  }
}

/** Throws unless the role may grant/assign `target`. Admins cannot mint owners. */
export function assertCanAssignRole(actorRole, targetRole) {
  if (!ORG_ROLES.includes(targetRole)) {
    throw new ApiError(400, 'invalid_role', `Role must be one of: ${ORG_ROLES.join(', ')}.`);
  }
  const actor = RANK[actorRole] ?? 0;
  const target = RANK[targetRole] ?? 0;
  if (target > actor) {
    throw new ApiError(403, 'role_escalation', `You cannot grant "${targetRole}" with role "${actorRole}".`);
  }
  if (targetRole === 'owner' && actorRole !== 'owner') {
    throw new ApiError(403, 'role_escalation', 'Only an owner can grant ownership.');
  }
}

const orgId = () => `org_${randomBytes(9).toString('base64url')}`;
const workspaceId = () => `ws_${randomBytes(9).toString('base64url')}`;

/**
 * opts.store — anything implementing store.records (memory or Firestore)
 * opts.now   — clock injection for tests
 */
export function createTenancy({ store, now = () => Date.now() } = {}) {
  if (!store?.records) throw new Error('createTenancy requires a store with records.');

  const stamp = () => now();
  const auditId = () => `aud_${randomBytes(9).toString('base64url')}`;

  /**
   * Write an org-scoped audit entry. Kept apart from the ad-group push audit
   * (`store.audit`) because that one is keyed by ad group and read by the push UI;
   * this one answers "who changed tenancy or qualified this lead", and never holds
   * request payloads or secrets.
   */
  async function audit(entry) {
    const record = {
      id: auditId(),
      at: stamp(),
      action: entry.action,
      organizationId: entry.organizationId,
      workspaceId: entry.workspaceId ?? null,
      actor: entry.actor ?? 'unknown',
      actorRole: entry.actorRole ?? null,
      target: entry.target ?? null,
      ok: entry.ok !== false,
      detail: entry.detail ?? null,
    };
    await store.records.put('auditLog', record.id, record, { orgId: entry.organizationId });
    return record;
  }

  // ------------------------------------------------------------------ membership

  async function membershipFor(userId, organization) {
    if (!userId || !organization) return null;
    return store.records.get('memberships', `${organization}__${userId}`);
  }

  /** Every organization this principal belongs to, with the role in each. */
  async function listOrgsFor(principal) {
    const memberships = await store.records.list('memberships', { where: { userId: principal.uid } });
    const out = [];
    for (const membership of memberships) {
      const org = await store.records.get('organizations', membership.organizationId);
      // `plan` was added after the first organizations were written, so a record that
      // predates it is normalised here rather than rendering an empty plan in the UI.
      if (org) out.push({ ...org, role: membership.role, plan: org.plan ?? 'free' });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Resolve a tenant context for a principal. Everything downstream takes the result
   * of this function, so no handler has to remember to check membership itself.
   */
  async function context(principal, organization, permission) {
    if (!principal?.uid) throw new ApiError(401, 'unauthenticated', 'Sign in to use this route.');
    const membership = await membershipFor(principal.uid, organization);
    if (!membership) throw new ApiError(404, 'not_found', 'No such organization.');
    const org = await store.records.get('organizations', organization);
    if (!org) throw new ApiError(404, 'not_found', 'No such organization.');
    if (permission) assertPermission(membership.role, permission);
    return { org, membership, role: membership.role, userId: principal.uid };
  }

  /** Resolve a workspace inside an already-authorised organization. */
  async function workspace(organization, id, { role } = {}) {
    if (!id) throw new ApiError(400, 'missing_workspace', 'workspaceId is required.');
    const ws = await store.records.get('workspaces', id, { orgId: organization });
    // A workspace from another organization simply does not exist at this path.
    if (!ws) throw new ApiError(404, 'not_found', 'No such workspace.');
    if (role) assertPermission(role, 'data.read');
    return ws;
  }

  // ----------------------------------------------------------------------- orgs

  async function createOrg(principal, body) {
    if (!principal?.uid) throw new ApiError(401, 'unauthenticated', 'Sign in to create an organization.');
    const name = text(body?.name, 'name', { max: 120 });
    const record = {
      organizationId: orgId(),
      name,
      // The slug is a label, not an identifier: ids are opaque so a URL cannot be guessed.
      slug: name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48),
      createdAt: stamp(),
      createdBy: principal.uid,
      // Billing plan is data, not policy: nothing enforces it yet (see docs/PRICING.md).
      // Every organization starts free; a later change promotes it.
      plan: 'free',
    };
    await store.records.put('organizations', record.organizationId, record);
    await store.records.put('memberships', `${record.organizationId}__${principal.uid}`, {
      organizationId: record.organizationId,
      userId: principal.uid,
      role: 'owner',
      createdAt: stamp(),
      invitedBy: principal.uid,
    });
    await audit({
      action: 'org.create',
      organizationId: record.organizationId,
      actor: principal.uid,
      actorRole: 'owner',
      target: record.organizationId,
      detail: { name },
    });
    return { ...record, role: 'owner' };
  }

  async function listMembers(principal, organization) {
    const ctx = await context(principal, organization, 'data.read');
    const members = await store.records.list('memberships', { where: { organizationId: ctx.org.organizationId } });
    return members
      .map((m) => ({ userId: m.userId, role: m.role, createdAt: m.createdAt, invitedBy: m.invitedBy ?? null }))
      .sort((a, b) => ORG_ROLES.indexOf(b.role) - ORG_ROLES.indexOf(a.role) || a.userId.localeCompare(b.userId));
  }

  async function setMember(principal, organization, body) {
    const ctx = await context(principal, organization, 'member.manage');
    const userId = idToken(body?.userId, 'userId', { max: 128 });
    const role = body?.role;
    assertCanAssignRole(ctx.role, role);

    // An organization must keep at least one owner: demoting the last one locks
    // everyone out permanently, with no recovery route inside the product.
    const existing = await membershipFor(userId, ctx.org.organizationId);
    const owners = (
      await store.records.list('memberships', { where: { organizationId: ctx.org.organizationId } })
    ).filter((m) => m.role === 'owner');
    if (existing?.role === 'owner' && role !== 'owner' && owners.length <= 1) {
      throw new ApiError(409, 'last_owner', 'An organization must keep at least one owner.');
    }

    // Memberships are global on purpose: the document *is* the link between a user and
    // an organization, and "which organizations am I in?" is a question asked without
    // knowing one yet. The composite id keeps the pair unique.
    await store.records.put('memberships', `${ctx.org.organizationId}__${userId}`, {
      organizationId: ctx.org.organizationId,
      userId,
      role,
      createdAt: existing?.createdAt ?? stamp(),
      invitedBy: principal.uid,
    });
    await audit({
      action: existing ? 'member.role_change' : 'member.add',
      organizationId: ctx.org.organizationId,
      actor: principal.uid,
      actorRole: ctx.role,
      target: userId,
      detail: { from: existing?.role ?? null, to: role },
    });
    return { userId, role };
  }

  async function removeMember(principal, organization, userId) {
    const ctx = await context(principal, organization, 'member.manage');
    const target = await membershipFor(userId, ctx.org.organizationId);
    if (!target) throw new ApiError(404, 'not_found', 'That user is not a member.');
    if (target.role === 'owner') {
      const owners = (
        await store.records.list('memberships', { where: { organizationId: ctx.org.organizationId } })
      ).filter((m) => m.role === 'owner');
      if (owners.length <= 1) throw new ApiError(409, 'last_owner', 'An organization must keep at least one owner.');
      if (RANK[ctx.role] <= RANK.owner && target.userId !== ctx.userId && ctx.role !== 'owner') {
        throw new ApiError(403, 'forbidden', 'Only an owner can remove another owner.');
      }
    }
    await store.records.remove('memberships', `${ctx.org.organizationId}__${userId}`);
    await audit({
      action: 'member.remove',
      organizationId: ctx.org.organizationId,
      actor: principal.uid,
      actorRole: ctx.role,
      target: userId,
      detail: { role: target.role },
    });
    return { userId, removed: true };
  }

  // ------------------------------------------------------------------ workspaces

  async function listWorkspaces(principal, organization) {
    const ctx = await context(principal, organization, 'data.read');
    const list = await store.records.list('workspaces', { orgId: ctx.org.organizationId });
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * A workspace is one client/brand: its own domains, language, time zone, currency and
   * target markets. Defaults are explicit and required — never inherited from the
   * server, because the server's locale is not the customer's.
   */
  async function createWorkspace(principal, organization, body) {
    const ctx = await context(principal, organization, 'workspace.write');
    const markets = Array.isArray(body?.targetMarkets) ? body.targetMarkets : [];
    if (markets.length > 50) throw new ApiError(400, 'too_many_markets', 'At most 50 target markets.');
    const record = {
      workspaceId: workspaceId(),
      organizationId: ctx.org.organizationId,
      name: text(body?.name, 'name', { max: 120 }),
      clientName: text(body?.clientName ?? body?.name, 'clientName', { max: 120 }),
      domains: (Array.isArray(body?.domains) ? body.domains : []).map((d) => text(d, 'domains[]', { max: 253 })),
      defaultLanguage: languageTag(body?.defaultLanguage ?? 'en'),
      timeZone: timeZone(body?.timeZone ?? 'UTC'),
      currency: currencyCode(body?.currency ?? 'USD'),
      targetMarkets: markets.map((m) => ({
        countryCode: countryCode(m?.countryCode, 'targetMarkets[].countryCode'),
        region: m?.region ? text(m.region, 'targetMarkets[].region', { max: 120 }) : null,
        city: m?.city ? text(m.city, 'targetMarkets[].city', { max: 120 }) : null,
      })),
      createdAt: stamp(),
      createdBy: principal.uid,
    };
    await store.records.put('workspaces', record.workspaceId, record, { orgId: ctx.org.organizationId });
    await audit({
      action: 'workspace.create',
      organizationId: ctx.org.organizationId,
      workspaceId: record.workspaceId,
      actor: principal.uid,
      actorRole: ctx.role,
      detail: { name: record.name, timeZone: record.timeZone, currency: record.currency },
    });
    return record;
  }

  async function getWorkspace(principal, organization, id) {
    const ctx = await context(principal, organization, 'data.read');
    return workspace(ctx.org.organizationId, id, { role: ctx.role });
  }

  /**
   * Delete a workspace and every record that belongs to it.
   *
   * The cascade is explicit and ordered; a partial delete would leave events that no
   * workspace can read — invisible storage that still counts against retention.
   */
  async function deleteWorkspace(principal, organization, id) {
    const ctx = await context(principal, organization, 'workspace.delete');
    const ws = await workspace(ctx.org.organizationId, id, { role: ctx.role });

    // Revoke ingest keys *before* deleting the source rows. Ingest keys are a global
    // collection (so one lookup resolves a header to a tenant), which means deleting the
    // workspace would otherwise leave a working credential pointing at a tenant that no
    // longer exists. Deleting the pointer must also kill the key.
    const keys = await store.records.list('ingestKeys', { where: { workspaceId: ws.workspaceId } });
    const revokedKeys = [];
    for (const key of keys) {
      if (key.status !== 'active') continue;
      await store.records.update('ingestKeys', `${key.sourceConnectionId}.${key.keyVersion}`, {
        status: 'revoked',
        revokedAt: stamp(),
      });
      revokedKeys.push(`${key.sourceConnectionId}.${key.keyVersion}`);
    }

    const removed = {};
    for (const collection of ['campaigns', 'topics', 'events', 'leads', 'sources', 'auditLog']) {
      removed[collection] = await store.records.purgeWhere(
        collection,
        { workspaceId: ws.workspaceId },
        {
          orgId: ctx.org.organizationId,
        },
      );
    }
    await store.records.remove('workspaces', ws.workspaceId, { orgId: ctx.org.organizationId });
    await audit({
      action: 'workspace.delete',
      organizationId: ctx.org.organizationId,
      workspaceId: ws.workspaceId,
      actor: principal.uid,
      actorRole: ctx.role,
      detail: { name: ws.name, removed, revokedKeys },
    });
    return { workspaceId: ws.workspaceId, deleted: true, removed, revokedKeys };
  }

  return {
    // membership + authorisation
    listOrgsFor,
    context,
    membershipFor,
    workspace,
    // orgs
    createOrg,
    listMembers,
    setMember,
    removeMember,
    // workspaces
    listWorkspaces,
    createWorkspace,
    getWorkspace,
    deleteWorkspace,
    // audit
    audit,
  };
}
