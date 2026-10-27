// @vitest-environment node
//
// Tenancy: organizations, workspaces, members, and the permission matrix.
//
// These are the acceptance criteria from the agency brief, written as executable
// assertions. The important ones are the *negative* cases: a second organization must
// not be readable by guessing an id, and a read-only role must not write, whatever the
// UI happens to render.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../server/app.mjs';
import { createAuth } from '../../../server/auth.mjs';
import { createConsentService } from '../../../server/consent.mjs';
import { createMemoryStore } from '../../../server/store.mjs';
import { createRateLimiter } from '../../../server/limits.mjs';
import { createTenancy, can, permissionsFor, assertCanAssignRole, ORG_ROLES } from '../../../server/tenancy.mjs';
import { createSources } from '../../../server/sources.mjs';
import { createEventIngest } from '../../../server/events-v2.mjs';
import { createAgencyApi } from '../../../server/agency.mjs';

const SECRET = 'consent-secret-for-tenancy-tests';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function harness() {
  const clock = { t: 1_760_000_000_000 };
  const now = () => clock.t;
  const store = createMemoryStore({ now });

  // A verifier per token, so tests can act as several users without a Firebase project.
  const users: Record<string, { uid: string; role: string }> = {
    'tok-owner': { uid: 'u_owner', role: 'owner' },
    'tok-viewer': { uid: 'u_viewer', role: 'viewer' },
    'tok-editor': { uid: 'u_editor', role: 'editor' },
    'tok-outsider': { uid: 'u_outsider', role: 'owner' },
  };
  const auth = createAuth({
    mode: 'firebase',
    verifyToken: async (token: string) => {
      const user = users[token];
      if (!user) throw new Error('unknown token');
      return { ...user, via: 'test' };
    },
  });
  const consent = createConsentService({
    secrets: [{ version: 'v1', secret: SECRET }],
    currentVersion: 'v1',
    store,
    now,
  });
  const tenancy = createTenancy({ store, now });
  const sources = createSources({ store, tenancy, now });
  const ingestV2 = createEventIngest({ store, now });
  const agency = createAgencyApi({ tenancy, store, sources, now });

  const app = createApp({
    env: { adsKey: 'k', capiKey: 'c', pixelId: 'p', trackOrigins: ['https://app.test'] },
    auth,
    consent,
    store,
    agency,
    sources,
    ingestV2,
    rateLimit: createRateLimiter({ limit: 1000 }),
    dataset: async () => ({ rows: [] }),
    logger: quiet,
    now,
  });

  const as = (token: string) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  });

  async function call(token: string, method: string, path: string, body?: unknown, query?: Record<string, string>) {
    return app.handle({
      method,
      path,
      headers: as(token),
      body: body as Record<string, unknown>,
      query,
      ip: '1.1.1.1',
    });
  }

  return { app, store, tenancy, sources, ingestV2, clock, now, call, users };
}

/** Owner + one workspace, the minimum for most tests. */
async function seed(h: ReturnType<typeof harness>, name = 'Acme Agency', token = 'tok-owner') {
  const org = await h.call(token, 'POST', '/api/orgs', { name });
  expect(org.status).toBe(201);
  const ws = await h.call(token, 'POST', `/api/orgs/${org.body.organizationId}/workspaces`, {
    name: 'Acme India',
    clientName: 'Acme',
    domains: ['acme.example'],
    defaultLanguage: 'en-IN',
    timeZone: 'Asia/Kolkata',
    currency: 'INR',
    targetMarkets: [{ countryCode: 'IN', region: 'Maharashtra', city: 'Pune' }],
  });
  expect(ws.status).toBe(201);
  return {
    orgId: org.body.organizationId as string,
    workspaceId: ws.body.workspaceId as string,
    org: org.body,
    ws: ws.body,
  };
}

describe('permission matrix', () => {
  it('is a closed list of permissions per role, ordered by privilege', () => {
    for (const role of ORG_ROLES) expect(permissionsFor(role).length).toBeGreaterThan(0);
    // Every permission a viewer has, an owner also has.
    for (const permission of permissionsFor('viewer')) expect(can('owner', permission)).toBe(true);
  });

  it('keeps read-only roles out of every write, and editors out of tenancy', () => {
    for (const role of ['viewer', 'analyst']) {
      for (const permission of [
        'campaign.write',
        'research.write',
        'lead.qualify',
        'member.manage',
        'workspace.write',
      ]) {
        expect(can(role, permission)).toBe(false);
      }
    }
    expect(can('editor', 'campaign.write')).toBe(true);
    expect(can('editor', 'lead.qualify')).toBe(true);
    expect(can('editor', 'member.manage')).toBe(false);
    expect(can('editor', 'workspace.delete')).toBe(false);
    // Advertising-account writes stay with admin/owner, matching WRITE_ROLES.
    expect(can('editor', 'adaccount.push')).toBe(false);
    expect(can('admin', 'adaccount.push')).toBe(true);
  });

  it('refuses to let a role grant itself more privilege', () => {
    expect(() => assertCanAssignRole('admin', 'owner')).toThrow(/owner/i);
    expect(() => assertCanAssignRole('editor', 'admin')).toThrow(/cannot grant/);
    expect(() => assertCanAssignRole('owner', 'owner')).not.toThrow();
    expect(() => assertCanAssignRole('admin', 'viewer')).not.toThrow();
  });
});

describe('organizations and workspaces', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('creates an organization whose creator is its owner', async () => {
    const org = await h.call('tok-owner', 'POST', '/api/orgs', { name: 'Acme Agency' });
    expect(org.status).toBe(201);
    expect(org.body.role).toBe('owner');

    const mine = await h.call('tok-owner', 'GET', '/api/orgs');
    expect(mine.body.orgs).toHaveLength(1);
    expect(mine.body.orgs[0].organizationId).toBe(org.body.organizationId);
  });

  it('puts a new organization on the free plan, and says so on every read', async () => {
    const created = await h.call('tok-owner', 'POST', '/api/orgs', { name: 'Free Co' });
    expect(created.body.plan).toBe('free');

    const mine = await h.call('tok-owner', 'GET', '/api/orgs');
    expect(mine.body.orgs[0].plan).toBe('free');
  });

  it('reports free for an organization written before the plan field existed', async () => {
    // A record from before this field shipped has no `plan`; it must not render blank.
    const store = h.store;
    await store.records.put('organizations', 'org_legacy', { organizationId: 'org_legacy', name: 'Legacy' });
    await store.records.put('memberships', 'org_legacy__u_owner', {
      organizationId: 'org_legacy',
      userId: 'u_owner',
      role: 'owner',
    });
    const mine = await h.call('tok-owner', 'GET', '/api/orgs');
    const legacy = mine.body.orgs.find((o: { organizationId: string }) => o.organizationId === 'org_legacy');
    expect(legacy.plan).toBe('free');
  });

  it('stores geography, language, zone and currency as structured fields', async () => {
    const { ws } = await seed(h);
    expect(ws).toMatchObject({
      timeZone: 'Asia/Kolkata',
      currency: 'INR',
      defaultLanguage: 'en-IN',
      targetMarkets: [{ countryCode: 'IN', region: 'Maharashtra', city: 'Pune' }],
    });
  });

  it('rejects an invalid zone, currency or country instead of guessing', async () => {
    const org = await h.call('tok-owner', 'POST', '/api/orgs', { name: 'Acme' });
    const base = { name: 'W', timeZone: 'Asia/Kolkata', currency: 'INR' };
    const badZone = await h.call('tok-owner', 'POST', `/api/orgs/${org.body.organizationId}/workspaces`, {
      ...base,
      timeZone: 'IST',
    });
    expect(badZone.status).toBe(400);
    expect(badZone.body.error.code).toBe('invalid_time_zone');

    const badCurrency = await h.call('tok-owner', 'POST', `/api/orgs/${org.body.organizationId}/workspaces`, {
      ...base,
      currency: 'XYZ',
    });
    expect(badCurrency.body.error.code).toBe('invalid_currency');

    const badCountry = await h.call('tok-owner', 'POST', `/api/orgs/${org.body.organizationId}/workspaces`, {
      ...base,
      targetMarkets: [{ countryCode: 'India' }],
    });
    expect(badCountry.body.error.code).toBe('invalid_country_code');
  });

  it('needs authentication, and returns 404 (not 403) for a tenant you are not in', async () => {
    const { orgId } = await seed(h);
    const anonymous = await h.app.handle({ method: 'GET', path: `/api/orgs/${orgId}/workspaces`, headers: {} });
    expect(anonymous.status).toBe(401);

    // The outsider holds a valid owner token — of a different organization.
    const probe = await h.call('tok-outsider', 'GET', `/api/orgs/${orgId}/workspaces`);
    expect(probe.status).toBe(404);
    expect(probe.body.error.code).toBe('not_found');
  });
});

describe('tenant isolation (the acceptance gate)', () => {
  let h: ReturnType<typeof harness>;
  let a: Awaited<ReturnType<typeof seed>>;
  let b: Awaited<ReturnType<typeof seed>>;

  beforeEach(async () => {
    h = harness();
    a = await seed(h, 'Agency A', 'tok-owner');
    // A second, genuinely separate organization: created by a different user, with no
    // membership shared with the first.
    b = await seed(h, 'Agency B', 'tok-outsider');
  });

  it('creates two independent organizations that cannot see each other', async () => {
    const mine = await h.call('tok-owner', 'GET', '/api/orgs');
    expect(mine.body.orgs.map((o: any) => o.organizationId)).toEqual([a.orgId]);

    const theirs = await h.call('tok-outsider', 'GET', '/api/orgs');
    expect(theirs.body.orgs.map((o: any) => o.organizationId)).toEqual([b.orgId]);
  });

  it.each([
    ['GET', '/api/orgs/{b}/workspaces'],
    ['GET', '/api/orgs/{b}/members'],
    ['GET', '/api/orgs/{b}/workspaces/{bws}/summary'],
    ['GET', '/api/orgs/{b}/workspaces/{bws}/campaigns'],
    ['GET', '/api/orgs/{b}/workspaces/{bws}/topics'],
    ['GET', '/api/orgs/{b}/workspaces/{bws}/leads'],
    ['GET', '/api/orgs/{b}/workspaces/{bws}/sources'],
  ])('denies a cross-tenant read: %s %s', async (method, template) => {
    const path = template.replace('{b}', b.orgId).replace('{bws}', b.workspaceId);
    const res = await h.call('tok-owner', method, path);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('denies a cross-tenant write, including through a nested resource id', async () => {
    // Campaign created in B, then addressed through B's org by A's owner.
    const campaign = await h.call(
      'tok-outsider',
      'POST',
      `/api/orgs/${b.orgId}/workspaces/${b.workspaceId}/campaigns`,
      {
        name: 'B campaign',
        destinationUrl: 'https://b.example/landing',
        utm: { source: 'google', medium: 'cpc', campaign: 'b-launch' },
      },
    );
    expect(campaign.status).toBe(201);

    const patch = await h.call(
      'tok-owner',
      'PATCH',
      `/api/orgs/${b.orgId}/workspaces/${b.workspaceId}/campaigns/${campaign.body.campaignId}`,
      { status: 'archived' },
    );
    expect(patch.status).toBe(404);

    // Even knowing both ids, a workspace from A cannot be reached under B's org.
    const crossed = await h.call('tok-outsider', 'GET', `/api/orgs/${b.orgId}/workspaces/${a.workspaceId}/summary`);
    expect(crossed.status).toBe(404);
  });

  it('ignores a workspace id smuggled into a request body', async () => {
    const res = await h.call('tok-owner', 'POST', `/api/orgs/${a.orgId}/workspaces/${a.workspaceId}/campaigns`, {
      name: 'Smuggled',
      destinationUrl: 'https://a.example/x',
      utm: { source: 'google', medium: 'cpc', campaign: 'a' },
      workspaceId: b.workspaceId,
    });
    // The route path decides the workspace; the body field is simply not read.
    expect(res.status).toBe(201);
    expect(res.body.workspaceId).toBe(a.workspaceId);
    const inB = await h.call('tok-outsider', 'GET', `/api/orgs/${b.orgId}/workspaces/${b.workspaceId}/campaigns`);
    expect(inB.body.campaigns).toHaveLength(0);
  });

  it('does not leak existence: unknown and foreign ids look identical', async () => {
    const foreign = await h.call('tok-owner', 'GET', `/api/orgs/${b.orgId}/workspaces`);
    const missing = await h.call('tok-owner', 'GET', '/api/orgs/org_does_not_exist/workspaces');
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });
});

describe('roles are enforced on the server, not in the UI', () => {
  let h: ReturnType<typeof harness>;
  let a: Awaited<ReturnType<typeof seed>>;

  beforeEach(async () => {
    h = harness();
    a = await seed(h);
    // owner adds a viewer and an editor
    await h.call('tok-owner', 'PUT', `/api/orgs/${a.orgId}/members`, { userId: 'u_viewer', role: 'viewer' });
    await h.call('tok-owner', 'PUT', `/api/orgs/${a.orgId}/members`, { userId: 'u_editor', role: 'editor' });
  });

  const campaign = () => ({
    name: 'GST filing',
    destinationUrl: 'https://acme.example/gst',
    utm: { source: 'google', medium: 'cpc', campaign: 'gst-q4' },
  });

  it('lets a viewer read but not write', async () => {
    expect(
      (await h.call('tok-viewer', 'GET', `/api/orgs/${a.orgId}/workspaces/${a.workspaceId}/campaigns`)).status,
    ).toBe(200);
    const write = await h.call(
      'tok-viewer',
      'POST',
      `/api/orgs/${a.orgId}/workspaces/${a.workspaceId}/campaigns`,
      campaign(),
    );
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('forbidden');
  });

  it('lets an editor run campaigns and research but not manage people', async () => {
    expect(
      (await h.call('tok-editor', 'POST', `/api/orgs/${a.orgId}/workspaces/${a.workspaceId}/campaigns`, campaign()))
        .status,
    ).toBe(201);
    const member = await h.call('tok-editor', 'PUT', `/api/orgs/${a.orgId}/members`, {
      userId: 'u_viewer',
      role: 'admin',
    });
    expect(member.status).toBe(403);
    // Nor can an editor promote themselves: the permission is checked before the
    // escalation rule, so the answer is "forbidden" rather than a hint about the rule.
    const self = await h.call('tok-editor', 'PUT', `/api/orgs/${a.orgId}/members`, {
      userId: 'u_editor',
      role: 'owner',
    });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('forbidden');
  });

  it('refuses to remove the last owner', async () => {
    const res = await h.call('tok-owner', 'DELETE', `/api/orgs/${a.orgId}/members/u_owner`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('last_owner');
  });

  it('records membership changes in the audit log with the actor', async () => {
    await h.call('tok-owner', 'PUT', `/api/orgs/${a.orgId}/members`, { userId: 'u_viewer', role: 'analyst' });
    const entries = await h.store.records.list('auditLog', { orgId: a.orgId, where: { action: 'member.role_change' } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: 'u_owner', actorRole: 'owner', target: 'u_viewer' });
    expect(entries[0].detail).toEqual({ from: 'viewer', to: 'analyst' });
  });
});

describe('workspace deletion', () => {
  it('removes the workspace and every record that belonged to it', async () => {
    const h = harness();
    const { orgId, workspaceId } = await seed(h);
    await h.call('tok-owner', 'POST', `/api/orgs/${orgId}/workspaces/${workspaceId}/campaigns`, {
      name: 'C1',
      destinationUrl: 'https://acme.example/1',
      utm: { source: 'google', medium: 'cpc', campaign: 'c1' },
    });
    const before = await h.store.records.list('campaigns', { orgId, where: { workspaceId } });
    expect(before).toHaveLength(1);

    const res = await h.call('tok-owner', 'DELETE', `/api/orgs/${orgId}/workspaces/${workspaceId}`);
    expect(res.status).toBe(200);
    expect(res.body.removed.campaigns).toBe(1);

    expect(await h.store.records.get('workspaces', workspaceId, { orgId })).toBeNull();
    expect(await h.store.records.list('campaigns', { orgId, where: { workspaceId } })).toHaveLength(0);
  });

  it('revokes every ingest key of the workspace it deletes', async () => {
    // Deleting the tenant must also kill the credential that pointed at it. Without
    // this, a deleted workspace leaves a working key writing into a tenant that no
    // longer exists — the row lookup survives because keys are a global collection.
    const h = harness();
    const { orgId, workspaceId } = await seed(h);
    const created = await h.call('tok-owner', 'POST', `/api/orgs/${orgId}/workspaces/${workspaceId}/sources`, {
      provider: 'crm',
      label: 'CRM sync',
      trustedForQualification: true,
    });
    expect(created.status).toBe(201);
    const key = created.body.key as { keyId: string; keyVersion: string; secret: string };
    expect(await h.sources.resolveKey(key.keyId)).not.toBeNull();

    const res = await h.call('tok-owner', 'DELETE', `/api/orgs/${orgId}/workspaces/${workspaceId}`);
    expect(res.status).toBe(200);
    expect(res.body.revokedKeys).toEqual([key.keyId]);

    // The key no longer resolves, so ingest refuses it before any body is read.
    expect(await h.sources.resolveKey(key.keyId)).toBeNull();
    const ingest = await h.app.handle({
      method: 'POST',
      path: '/api/events',
      headers: { 'content-type': 'application/json', 'x-adtrack-key': key.keyId },
      rawBody: JSON.stringify({ schema_version: 2 }),
      body: { schema_version: 2 },
      ip: '1.2.3.4',
    });
    expect(ingest.status).toBe(401);
    expect(ingest.body.error.code).toBe('ingest_unauthenticated');
  });

  it('is an owner-only action', async () => {
    const h = harness();
    const { orgId, workspaceId } = await seed(h);
    await h.call('tok-owner', 'PUT', `/api/orgs/${orgId}/members`, { userId: 'u_editor', role: 'editor' });
    const res = await h.call('tok-editor', 'DELETE', `/api/orgs/${orgId}/workspaces/${workspaceId}`);
    expect(res.status).toBe(403);
  });
});

describe('the health endpoint reports capability honestly', () => {
  it('says whether tenancy and tenant ingest are wired', async () => {
    const h = harness();
    const res = await h.call('tok-owner', 'GET', '/api/health');
    // `privateResearch` joined this block on 2026-10-27 (Private Research Mode slice 1).
    // This harness does not wire the module, so the capability must read as absent — the UI
    // relies on that to hide the control.
    expect(res.body.features).toEqual({
      tenancy: true,
      tenantIngest: true,
      legacyIngest: false,
      privateResearch: false,
    });
  });
});

describe('no route trusts a role from the request', () => {
  it('ignores a role field in a membership body from a non-owner', async () => {
    const h = harness();
    const { orgId } = await seed(h);
    await h.call('tok-owner', 'PUT', `/api/orgs/${orgId}/members`, { userId: 'u_editor', role: 'editor' });
    // The editor posts a role change with a body claiming to be an owner.
    const res = await h.call('tok-editor', 'PUT', `/api/orgs/${orgId}/members`, {
      userId: 'u_editor',
      role: 'owner',
      actorRole: 'owner',
      principal: { role: 'owner' },
    });
    expect(res.status).toBe(403);
    expect(h.store.records.list).toBeDefined();
  });
});

// A guard against the matrix drifting away from the docs as files change.
describe('matrix snapshot', () => {
  it('matches the documented permissions exactly', () => {
    expect(permissionsFor('viewer')).toEqual(['data.read', 'research.read', 'campaign.read', 'lead.read']);
    expect(permissionsFor('analyst')).toContain('report.export');
    // 13 -> 14 on 2026-10-27: `research.private` was added for Private Research Mode slice 1
    // (docs/PRIVATE_RESEARCH_MODE.md §2.4). An owner holds every permission by construction,
    // and the new one is granted to editor/admin/owner only — the roles that already hold
    // `research.write`.
    expect(permissionsFor('owner')).toHaveLength(14);
    expect(permissionsFor('editor')).toContain('research.private');
    expect(permissionsFor('admin')).toContain('research.private');
    expect(permissionsFor('viewer')).not.toContain('research.private');
    expect(permissionsFor('analyst')).not.toContain('research.private');
    vi.restoreAllMocks();
  });
});
