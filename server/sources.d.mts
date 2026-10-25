export declare const PROVIDERS: string[];
export declare const WRITE_CAPABLE_PROVIDERS: Set<string>;
export declare function secretFingerprint(secret: string): string;

export interface Source {
  sourceConnectionId: string;
  organizationId: string;
  workspaceId: string;
  provider: string;
  label: string;
  capability: 'read' | 'write';
  status: string;
  trustedForQualification: boolean;
  lastSyncAt: number | null;
  createdAt: number;
}
export interface IssuedKey {
  keyId: string;
  keyVersion: string;
  secret: string;
}
export interface IngestKeyRecord {
  sourceConnectionId: string;
  organizationId: string;
  workspaceId: string;
  keyVersion: string;
  secret: string;
  fingerprint: string;
  status: 'active' | 'revoked';
  trustedForQualification: boolean;
}
export interface Sources {
  create(input: Record<string, any>): Promise<{ source: Source; key: IssuedKey }>;
  list(input: { principal: { uid: string }; organizationId: string; workspaceId: string }): Promise<Source[]>;
  rotate(input: {
    principal: { uid: string };
    organizationId: string;
    workspaceId: string;
    sourceConnectionId: string;
  }): Promise<{ sourceConnectionId: string; key: IssuedKey }>;
  revoke(input: {
    principal: { uid: string };
    organizationId: string;
    workspaceId: string;
    sourceConnectionId: string;
    keyVersion?: string;
  }): Promise<{ sourceConnectionId: string; revoked: string[] }>;
  disconnect(input: {
    principal: { uid: string };
    organizationId: string;
    workspaceId: string;
    sourceConnectionId: string;
  }): Promise<{ sourceConnectionId: string; revoked: string[]; status: string }>;
  resolveKey(keyHeader: string | undefined): Promise<IngestKeyRecord | null>;
  secretFingerprint(secret: string): string;
}
export declare function createSources(opts: {
  store: { records: unknown };
  tenancy: { context: Function; workspace: Function; audit: Function };
  now?: () => number;
}): Sources;
