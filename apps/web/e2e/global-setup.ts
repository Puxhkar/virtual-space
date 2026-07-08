import { execFileSync } from "node:child_process";

/**
 * Seeds the database before the suite runs.
 *
 * The tests sign in as a real user against a real office, because the parts
 * most likely to break — the handshake, org scoping, the map fetch — only
 * exist on that path. The seed is idempotent.
 */
export default function globalSetup() {
  execFileSync("pnpm", ["--filter", "@vo/server", "seed"], {
    cwd: "../..",
    stdio: "pipe",
  });
}
