/**
 * Public runtime configuration.
 *
 * NEXT_PUBLIC_ values are compiled into the browser bundle, so nothing secret
 * belongs here (CLAUDE.md §12). The API origin is the only thing the client
 * needs to know.
 */
export const API_URL =
  process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000";
