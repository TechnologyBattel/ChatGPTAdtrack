export declare function countryCode(value: unknown, field?: string): string | null;
export declare function timeZone(value: unknown, field?: string): string;
export declare function currencyCode(value: unknown, field?: string): string;
export declare function languageTag(value: unknown, field?: string): string;
export declare function isoInstant(value: unknown, field?: string): { ms: number; raw: string };
export declare function webUrl(value: unknown, field?: string, opts?: { required?: boolean }): string | null;
export declare function idToken(
  value: unknown,
  field: string,
  opts?: { max?: number; required?: boolean },
): string | null;
export declare function text(
  value: unknown,
  field: string,
  opts?: { max?: number; required?: boolean; min?: number },
): string | null;
export declare function oneOf<T extends string>(value: unknown, allowed: readonly T[] | Set<T>, field: string): T;
export declare function assertKnownKeys(object: unknown, allowed: readonly string[], label?: string): void;
