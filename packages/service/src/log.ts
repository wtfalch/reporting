import type { Logger } from '@wtfalch/reporting-core';

export type { Logger };

/** One JSON line per entry on stdout/stderr, so a refusal always leaves a trace. */
export const consoleLogger: Logger = {
  info: (meta, message) => console.info(JSON.stringify({ level: 'info', message, meta })),
  warn: (meta, message) => console.warn(JSON.stringify({ level: 'warn', message, meta })),
  error: (meta, message) => console.error(JSON.stringify({ level: 'error', message, meta })),
};

/** The error's name and nothing else: a message can quote the value that failed. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Core's capture logs `{ err: "<name>: <message>" }` (writer.ts `describe`),
 * and a database error's message can quote a value from the report. This
 * keeps the fixed text and the part before the first colon, the name, and
 * drops every other field, so nothing a sender sent reaches the log.
 */
export function namesOnly(log: Logger, onError?: () => void): Logger {
  const strip = (meta: object): object => {
    const err = (meta as { err?: unknown }).err;
    return typeof err === 'string' ? { err: err.split(':', 1)[0] } : {};
  };
  return {
    info: (meta, message) => log.info(strip(meta), message),
    warn: (meta, message) => log.warn(strip(meta), message),
    error: (meta, message) => {
      onError?.();
      log.error(strip(meta), message);
    },
  };
}
