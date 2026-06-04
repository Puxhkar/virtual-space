import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { createApp } from "./app.js";
import { closeDatabase } from "./db/client.js";
import { env } from "./env.js";
import { MemoryPresenceStore } from "./realtime/PresenceStore.js";
import { attachRealtime } from "./realtime/gateway.js";

const server = serve({ fetch: createApp().fetch, port: env.PORT }, (info) => {
  console.warn(
    `server listening on http://localhost:${info.port} (${env.NODE_ENV})`,
  );
});

/**
 * Realtime shares the HTTP server, so one port serves both the API and the
 * socket. State is in memory for now; Redis becomes a second implementation of
 * PresenceStore when a second instance exists (decision 004).
 */
const realtime = attachRealtime(server as unknown as HttpServer, {
  store: new MemoryPresenceStore(),
});

/**
 * Graceful shutdown.
 *
 * Stop accepting connections, let in-flight requests finish, then close the
 * pool. Killing the pool first would fail requests that were already mid-query
 * (CLAUDE.md §13 reliability).
 */
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(`${signal} received, shutting down`);

    // `io.close()` also closes the HTTP server it is attached to, so this is
    // the whole shutdown: stop ticking, cut sockets, stop listening, then
    // release the pool. Closing the pool first would fail requests that were
    // already mid-query.
    void (async () => {
      try {
        await realtime.close();
        await closeDatabase();
        process.exit(0);
      } catch {
        process.exit(1);
      }
    })();

    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
