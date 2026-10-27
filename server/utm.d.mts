export declare const UTM_KEYS: string[];
export declare function normalizeUtmValue(raw: unknown): string;
export declare function inspectUtm(url: string | URL): Record<string, string>;
export declare function buildUtmUrl(input: {
  destinationUrl: unknown;
  source?: unknown;
  medium?: unknown;
  campaign?: unknown;
  term?: unknown;
  content?: unknown;
}): {
  url: string;
  params: Record<string, string>;
  normalized: { key: string; from: string; to: string }[];
  preserved: string[];
};
export declare function utmField(key: string): string;
