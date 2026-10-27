export declare const ORG_ROLES: string[];
export declare const PERMISSIONS: string[];
export type OrgRole = 'viewer' | 'analyst' | 'editor' | 'admin' | 'owner';
export declare function permissionsFor(role: string): string[];
export declare function can(role: string, permission: string): boolean;
export declare function assertPermission(role: string, permission: string, opts?: { resource?: string }): void;
export declare function assertCanAssignRole(actorRole: string, targetRole: string): void;

export interface Org {
  organizationId: string;
  name: string;
  slug: string;
  createdAt: number;
  createdBy: string;
  role?: string;
  plan?: 'free' | 'pro';
}
export interface Membership {
  organizationId: string;
  userId: string;
  role: string;
  createdAt: number;
  invitedBy: string | null;
}
export interface Workspace {
  workspaceId: string;
  organizationId: string;
  name: string;
  clientName: string;
  domains: string[];
  defaultLanguage: string;
  timeZone: string;
  currency: string;
  targetMarkets: { countryCode: string | null; region: string | null; city: string | null }[];
  createdAt: number;
  createdBy: string;
}
export interface TenancyContext {
  org: Org;
  membership: Membership;
  role: string;
  userId: string;
}
export interface Tenancy {
  listOrgsFor(principal: { uid: string }): Promise<Org[]>;
  context(principal: { uid: string }, organization: string, permission?: string): Promise<TenancyContext>;
  membershipFor(userId: string, organization: string): Promise<Membership | null>;
  workspace(organization: string, id: string, opts?: { role?: string }): Promise<Workspace>;
  createOrg(principal: { uid: string }, body: { name?: unknown }): Promise<Org>;
  listMembers(principal: { uid: string }, organization: string): Promise<Membership[]>;
  setMember(
    principal: { uid: string },
    organization: string,
    body: { userId?: unknown; role?: string },
  ): Promise<Membership>;
  removeMember(
    principal: { uid: string },
    organization: string,
    userId: string,
  ): Promise<{ userId: string; removed: true }>;
  listWorkspaces(principal: { uid: string }, organization: string): Promise<Workspace[]>;
  createWorkspace(principal: { uid: string }, organization: string, body: Record<string, unknown>): Promise<Workspace>;
  getWorkspace(principal: { uid: string }, organization: string, id: string): Promise<Workspace>;
  deleteWorkspace(
    principal: { uid: string },
    organization: string,
    id: string,
  ): Promise<{ workspaceId: string; deleted: true; removed: Record<string, number> }>;
  audit(entry: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export declare function createTenancy(opts: { store: { records: unknown }; now?: () => number }): Tenancy;
