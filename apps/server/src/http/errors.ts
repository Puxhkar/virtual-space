import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * One error shape for the whole API.
 *
 * Messages are safe to show a user and never carry internal detail — no stack,
 * no SQL, no row counts (CLAUDE.md §12). Anything a developer needs goes to
 * the log, keyed by request id.
 */

export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_input",
  "conflict",
  "rate_limited",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 422,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  unauthenticated: "You need to sign in to do that.",
  forbidden: "You do not have access to that.",
  not_found: "That does not exist.",
  invalid_input: "Some of the details were not valid.",
  conflict: "That conflicts with something that already exists.",
  rate_limited: "Too many requests. Try again shortly.",
  internal: "Something went wrong on our side.",
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    /** Logged, never sent to the client. Not `cause` — that is Error's own. */
    readonly detail?: unknown,
  ) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = "ApiError";
  }
}

export function errorResponse(c: Context, error: ApiError) {
  return c.json(
    { error: { code: error.code, message: error.message } },
    STATUS[error.code],
  );
}

/**
 * A resource the caller cannot see is reported as absent, not forbidden.
 *
 * Returning 403 for another organization's office would confirm it exists,
 * which leaks across the tenant boundary (CLAUDE.md §13).
 */
export function notFound(what = "That does not exist."): ApiError {
  return new ApiError("not_found", what);
}
