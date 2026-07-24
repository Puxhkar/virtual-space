import { env } from "../env.js";

/**
 * Structured logging.
 *
 * One JSON object per line, so a log aggregator can index it and a human can
 * still read it with `jq`. Every line carries a request or socket id, because
 * the first question about any error is "what else happened on that request"
 * (CLAUDE.md §14).
 *
 * Never logs a token, a cookie, a password or a full email — a log file is a
 * copy of your data with weaker access control.
 */

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN: Level = env.NODE_ENV === "production" ? "info" : "debug";

/** Values that must never reach a log line, whatever the caller passes. */
const REDACT = /^(password|token|secret|cookie|authorization|apiKey)$/i;

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACT.test(key) ? "[redacted]" : value;
  }
  return out;
}

function write(level: Level, message: string, fields: Record<string, unknown>) {
  if (ORDER[level] < ORDER[MIN]) return;

  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...scrub(fields),
  });

  // warn and error go to stderr so a crash loop is visible even when stdout
  // is being collected somewhere else.
  if (level === "error" || level === "warn") console.error(line);
  else console.warn(line);
}

export const log = {
  debug: (message: string, fields: Record<string, unknown> = {}) =>
    write("debug", message, fields),
  info: (message: string, fields: Record<string, unknown> = {}) =>
    write("info", message, fields),
  warn: (message: string, fields: Record<string, unknown> = {}) =>
    write("warn", message, fields),
  error: (message: string, fields: Record<string, unknown> = {}) =>
    write("error", message, fields),
};
