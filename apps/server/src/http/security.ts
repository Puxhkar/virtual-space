import type { MiddlewareHandler } from "hono";
import { env } from "../env.js";
import type { App } from "./middleware.js";

/**
 * Response security headers.
 *
 * This is an API, not a document server, so the policy is aggressive: nothing
 * here is meant to be framed, sniffed, or rendered. The frontend sets its own
 * policy separately, because it has genuinely different needs — it loads a
 * canvas, a WebSocket and a WebRTC connection.
 */
export const securityHeaders: MiddlewareHandler<App> = async (c, next) => {
  await next();

  // Nothing the API returns should ever be rendered or embedded.
  c.header(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("referrer-policy", "no-referrer");
  // Deny the powerful features outright — the API has no use for any of them.
  c.header(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  // Do not leak the stack.
  c.header("x-powered-by", "");

  if (env.NODE_ENV === "production") {
    // Only meaningful over HTTPS, and actively unhelpful in local development
    // where it would pin localhost to https for two years.
    c.header(
      "strict-transport-security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }
};
