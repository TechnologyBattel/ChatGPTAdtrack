export declare function routeOf(path?: string | null): string;
export declare function newRequestId(): string;
export type LogFields = Record<string, unknown>;
export interface LogRecord {
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  [key: string]: unknown;
}
export interface Logger {
  format: 'text' | 'json';
  info(message: string, fields?: LogFields): LogRecord;
  warn(message: string, fields?: LogFields): LogRecord;
  error(message: string, fields?: LogFields): LogRecord;
  request(fields?: LogFields & { status?: number; route?: string; path?: string }): LogRecord;
  child(base?: LogFields): Pick<Logger, 'info' | 'warn' | 'error'>;
}
export declare function createLogger(options?: {
  format?: 'text' | 'json';
  sink?: { log?: (line: string) => void; warn?: (line: string) => void; error?: (line: string) => void };
  now?: () => number;
}): Logger;
