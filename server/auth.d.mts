export type Role = 'viewer' | 'analyst' | 'admin' | 'owner';
export interface Principal {
  uid: string;
  role: Role | string;
  via?: 'dev' | 'firebase' | string;
}
export interface AuthGate {
  mode: 'dev' | 'firebase';
  authenticate(headers?: Record<string, string | undefined>): Promise<Principal>;
  requireWrite(principal: Principal): Principal;
  issueDevSession(): { token: string; role: string; expiresAt: null } | null;
}
export declare const ROLES: Role[];
export declare const WRITE_ROLES: Set<string>;
export declare function hasRole(principal: { role?: string } | null | undefined, allowed: Iterable<string>): boolean;
export declare function safeEqual(a: unknown, b: unknown): boolean;
export declare function bearerToken(headers?: Record<string, string | undefined>): string | null;
export declare function createAuth(opts: {
  mode: 'dev' | 'firebase';
  devToken?: string;
  devRole?: string;
  verifyToken?: (token: string) => Promise<Principal>;
}): AuthGate;
export declare function createAdminLoader(opts?: {
  projectId?: string;
  credential?: unknown;
  adminModule?: unknown;
  importAdmin?: (name: string) => Promise<any>;
}): () => Promise<any>;
export declare function createFirebaseVerifier(opts?: {
  projectId?: string;
  credential?: unknown;
  adminModule?: unknown;
  importAdmin?: (name: string) => Promise<any>;
}): (token: string) => Promise<Principal>;
export declare function generateDevToken(): string;
