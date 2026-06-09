import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // env must be redirected to the test database before any server module
    // reads process.env.
    setupFiles: ["./src/test/setup-env.ts"],
    // Tests share one Postgres database and truncate between files, so they
    // must not run concurrently.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
