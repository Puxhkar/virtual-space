import { Hono } from "hono";
import { checkDatabase } from "../db/client.js";
import type { App } from "../http/middleware.js";

/**
 * Liveness and readiness are different questions and the load balancer needs
 * both: a process that is up but cannot reach Postgres should stop receiving
 * traffic without being restarted.
 */
export const healthRoutes = new Hono<App>();

/** Liveness. Deliberately touches nothing. */
healthRoutes.get("/healthz", (c) => c.json({ status: "ok" }));

/** Readiness. Actually queries the database. */
healthRoutes.get("/readyz", async (c) => {
  const database = await checkDatabase();
  return c.json(
    { status: database ? "ready" : "degraded", database },
    database ? 200 : 503,
  );
});
