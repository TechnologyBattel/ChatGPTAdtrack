import type { Dataset } from '../src/lib/types';
export declare function createDatasetLoader(options: {
  env: Record<string, unknown>;
  firstPartySource?: string | null;
}): (days: number) => Promise<Dataset & Record<string, unknown>>;
