/**
 * Points the process at the test database before anything imports `env`.
 *
 * `env.ts` parses process.env at module load, so this must run as a vitest
 * setupFile rather than inside a test — by the time a test body runs, the
 * server modules have already read their configuration.
 */
const DEV_URL =
  process.env["DATABASE_URL"] ??
  "postgres://vo:vo_local_dev_only@localhost:5432/virtual_office";

process.env["DATABASE_URL"] = DEV_URL.replace(
  /\/[^/?]+(\?|$)/,
  "/virtual_office_test$1",
);
process.env["NODE_ENV"] = "test";
process.env["PORT"] ??= "4001";
process.env["WEB_ORIGIN"] ??= "http://localhost:3100";
process.env["BETTER_AUTH_URL"] ??= "http://localhost:4001";
process.env["BETTER_AUTH_SECRET"] ??=
  "test-only-secret-not-used-in-any-real-environment";

// Dummy LiveKit credentials. A token is a JWT signed with the secret, so it
// can be minted and verified entirely offline — no LiveKit account is needed
// to prove the grants are correct. Skipping these tests when unconfigured
// would mean the assertions that matter never run.
process.env["LIVEKIT_URL"] ??= "wss://livekit.test";
process.env["LIVEKIT_API_KEY"] ??= "test-api-key";
process.env["LIVEKIT_API_SECRET"] ??=
  "test-api-secret-at-least-32-characters-long";
