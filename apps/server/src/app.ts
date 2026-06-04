import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth.js";
import { env } from "./env.js";
import { ApiError, errorResponse } from "./http/errors.js";
import { requestId, type App } from "./http/middleware.js";
import { increment, observe } from "./observability/metrics.js";
import { log } from "./observability/logger.js";
import { rateLimit } from "./http/rateLimit.js";
import { securityHeaders } from "./http/security.js";
import { healthRoutes } from "./routes/health.js";
import { metricsRoutes } from "./routes/metrics.js";
import { meRoutes } from "./routes/me.js";
import { officeRoutes } from "./routes/offices.js";
import { chatRoutes } from "./routes/chat.js";

export function createApp() {
  const app = new Hono<App>();

  app.use("*", requestId);
  app.use("*", securityHeaders);

  /**
   * Request metrics.
   *
   * The route pattern is recorded rather than the path, so an office id does
   * not become a distinct metric name — that is how a metrics endpoint turns
   * into a memory leak.
   */
  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();

    const route = c.req.routePath ?? "unmatched";
    const duration = performance.now() - started;

    increment(`http.requests.total`);
    increment(`http.status.${Math.floor(c.res.status / 100)}xx`);
    observe(`http.duration_ms`, duration);

    if (c.res.status >= 500) {
      log.error("request failed", {
        requestId: c.get("requestId"),
        route,
        method: c.req.method,
        status: c.res.status,
        durationMs: Math.round(duration),
      });
    }
  });

  // Exactly one origin, and credentials are required for the session cookie.
  // A wildcard origin cannot be combined with credentials, and should not be.
  app.use(
    "*",
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
      allowHeaders: ["content-type", "x-request-id"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Health is deliberately unlimited: a load balancer polls it constantly and
  // rate-limiting it would take the service out of rotation under load.
  app.route("/", healthRoutes);
  app.route("/", metricsRoutes);

  /*
   * Only the endpoints that accept credentials are tightly limited.
   *
   * Limiting all of /api/auth/* was wrong: it also covers `get-session`,
   * which every client polls, so a ten-person team behind one office NAT
   * would throttle itself at nine in the morning. Keyed by IP because by
   * definition there is no session yet.
   *
   * This protects the server from a flood. Protection for an individual
   * account against guessing is a per-account concern, not a per-IP one.
   */
  for (const path of [
    "/api/auth/sign-in/*",
    "/api/auth/sign-up/*",
    "/api/auth/forget-password/*",
    "/api/auth/reset-password/*",
  ]) {
    app.use(
      path,
      rateLimit({ name: "credentials", limit: 60, windowMs: 60_000 }),
    );
  }

  // Better Auth owns its own routes. We do not reimplement sign-in, callbacks
  // or session refresh (CLAUDE.md §9).
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.use("/api/*", rateLimit({ name: "api", limit: 300, windowMs: 60_000 }));

  app.route("/api", meRoutes);
  app.route("/api/offices", officeRoutes);
  app.route("/api/channels", chatRoutes);

  app.notFound(() =>
    Response.json(
      { error: { code: "not_found", message: "That does not exist." } },
      { status: 404 },
    ),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      // Expected failures are not incidents; log them quietly, without a stack.
      increment(`http.errors.${err.code}`);
      if (err.code === "internal") {
        log.error("handled error", {
          requestId: c.get("requestId"),
          route: c.req.routePath ?? c.req.path,
          code: err.code,
          detail: String(err.detail ?? err.message),
        });
      }
      return errorResponse(c, err);
    }

    // Anything else is a bug. Log it in full; tell the client nothing.
    increment("http.errors.unhandled");
    log.error("unhandled error", {
      requestId: c.get("requestId"),
      route: c.req.routePath ?? c.req.path,
      message: err.message,
      stack: err.stack,
    });
    return errorResponse(c, new ApiError("internal"));
  });

  return app;
}
