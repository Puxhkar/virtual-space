import { Hono } from "hono";
import { snapshot } from "../observability/metrics.js";
import type { App } from "../http/middleware.js";

/**
 * Metrics.
 *
 * Unauthenticated on purpose, like the health endpoints: a monitor should not
 * need a session, and in production this port is not exposed publicly. Nothing
 * here identifies a person or an organization — only counts.
 */
export const metricsRoutes = new Hono<App>();

metricsRoutes.get("/metrics", (c) => {
  c.header("cache-control", "no-store");
  return c.json(snapshot());
});
