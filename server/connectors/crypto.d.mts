/** A 32-byte AES-256-GCM key, accepted as 64 hex chars or base64. */
export declare function parseEncryptionKey(raw: string): Buffer;
export declare function tenantAad(input: {
  organizationId: string;
  workspaceId: string;
  sourceConnectionId: string;
}): string;
export declare function seal(plaintext: string, key: Buffer, options: { aad: string }): string;
export declare function open(sealed: string | null | undefined, key: Buffer, options: { aad: string }): string | null;
