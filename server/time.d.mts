export declare function partsInZone(
  instantMs: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number };
export declare function offsetMinutes(instantMs: number, timeZone: string): number;
export declare function startOfZonedDay(instantMs: number, timeZone: string): number;
export declare function zonedDayRange(
  instantMs: number,
  timeZone: string,
): { startMs: number; endMs: number; timeZone: string; localDate: string; hours: number };
export declare function formatInZone(instantMs: number, timeZone: string, locale?: string): string;
export declare function bucketByLocalDay(
  events: { occurredAt?: number }[],
  opts: { timeZone: string; fromMs: number; toMs: number },
): { date: string; count: number }[];
