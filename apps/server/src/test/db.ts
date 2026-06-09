import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "../db/schema.js";

/**
 * Tests run against a real Postgres, in a database separate from development.
 *
 * A real database is the point: the constraints being verified — the unique
 * membership index, the cascade rules, the org filters — live in Postgres, and
 * a mock would assert nothing about them (CLAUDE.md §22).
 */

const DEV_URL =
  process.env["DATABASE_URL"] ??
  "postgres://vo:vo_local_dev_only@localhost:5432/virtual_office";

const TEST_DB = "virtual_office_test";
const TEST_URL = DEV_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

let pool: pg.Pool | undefined;

/** Creates the test database if absent, then migrates it. Idempotent. */
export async function setupTestDatabase() {
  const admin = new pg.Pool({ connectionString: DEV_URL });
  try {
    const { rows } = await admin.query(
      "select 1 from pg_database where datname = $1",
      [TEST_DB],
    );
    if (rows.length === 0) {
      // Identifier cannot be parameterised; TEST_DB is a constant, not input.
      await admin.query(`create database "${TEST_DB}"`);
    }
  } finally {
    await admin.end();
  }

  pool = new pg.Pool({ connectionString: TEST_URL, max: 4 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

export async function closeTestDatabase() {
  await pool?.end();
  pool = undefined;
}

/** Wipes every table between tests. Order does not matter with CASCADE. */
export async function truncateAll(db: ReturnType<typeof drizzle>) {
  await db.execute(
    sql`truncate table
      "messages", "channel_members", "channels",
      "audit_log", "office_members", "zones", "offices", "maps",
      "invitation", "member", "session", "account", "verification",
      "organization", "user"
      restart identity cascade`,
  );
}
