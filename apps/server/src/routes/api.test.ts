import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "../app.js";
import { db, closeDatabase } from "../db/client.js";
import { maps, member, offices, officeMembers, zones } from "../db/schema.js";
import { setupTestDatabase, truncateAll } from "../test/db.js";
import { resetRateLimits } from "../http/rateLimit.js";

/**
 * API-level authorization tests.
 *
 * These go through the real HTTP stack — middleware, session lookup, query
 * layer — because that is where an authorization bug would actually live. The
 * query layer is already covered by isolation.test.ts; what is tested here is
 * whether a request can reach data it should not.
 */

const app = createApp();

const call = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

/** Signs up a user and returns the cookie header for their session. */
async function signUp(email: string): Promise<string> {
  const res = await call("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: "a-sufficiently-long-password",
      name: email.split("@")[0],
    }),
  });

  if (!res.ok) {
    throw new Error(`sign-up failed (${res.status}): ${await res.text()}`);
  }

  const cookie = res.headers.getSetCookie().join("; ");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  return cookie;
}

async function createOrg(cookie: string, name: string): Promise<string> {
  const res = await call("/api/auth/organization/create", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name, slug: name }),
  });
  if (!res.ok) {
    throw new Error(`org create failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function setActiveOrg(cookie: string, organizationId: string) {
  const res = await call("/api/auth/organization/set-active", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ organizationId }),
  });
  if (!res.ok) {
    throw new Error(`set-active failed (${res.status}): ${await res.text()}`);
  }
}

/** Gives an org an office with one zone, and admits the user to it. */
async function seedOffice(orgId: string, userId: string, label: string) {
  const mapId = crypto.randomUUID();
  const officeId = crypto.randomUUID();

  await db.insert(maps).values({
    id: mapId,
    orgId,
    name: `${label} map`,
    version: 1,
    data: { layers: [] },
    tileSize: 16,
  });
  await db.insert(offices).values({
    id: officeId,
    orgId,
    name: `${label} office`,
    mapId,
    mapVersion: 1,
  });
  await db.insert(zones).values({
    id: crypto.randomUUID(),
    orgId,
    officeId,
    name: "Standup",
    kind: "meeting",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    capacity: null,
  });
  await db.insert(officeMembers).values({ officeId, userId, orgId });

  return officeId;
}

interface Tenant {
  cookie: string;
  userId: string;
  orgId: string;
  officeId: string;
}

async function createTenant(label: string): Promise<Tenant> {
  const cookie = await signUp(`${label}@example.test`);
  const orgId = await createOrg(cookie, label);
  await setActiveOrg(cookie, orgId);

  const rows = await db
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, orgId));
  const userId = rows[0]!.userId;

  const officeId = await seedOffice(orgId, userId, label);
  return { cookie, userId, orgId, officeId };
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  await setupTestDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  // Limits are process-global by design; each test starts with a fresh
  // budget so one suite cannot exhaust another's.
  resetRateLimits();
  await truncateAll(db);
  a = await createTenant("alpha");
  b = await createTenant("bravo");
});

describe("health", () => {
  it("healthz does not touch the database", async () => {
    const res = await call("/healthz");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  it("readyz reports the database", async () => {
    const res = await call("/readyz");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ database: true });
  });
});

describe("authentication", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await call("/api/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthenticated");
  });

  it("rejects a forged cookie", async () => {
    const res = await call("/api/me", {
      headers: { cookie: "better-auth.session_token=not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns the user and their organizations", async () => {
    const res = await call("/api/me", { headers: { cookie: a.cookie } });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      user: { email: string };
      activeOrgId: string;
      organizations: { orgId: string; role: string }[];
    };
    expect(body.user.email).toBe("alpha@example.test");
    expect(body.activeOrgId).toBe(a.orgId);
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]?.role).toBe("owner");
  });
});

describe("revoked access takes effect immediately", () => {
  it("a removed member loses access while their session is still valid", async () => {
    // The session still names the organization. Only the membership row is
    // gone. If access survived until session expiry, removing someone from a
    // workspace would take up to a week to mean anything.
    const before = await call("/api/offices", {
      headers: { cookie: a.cookie },
    });
    expect(before.status).toBe(200);

    await db.delete(member).where(eq(member.userId, a.userId));

    const after = await call("/api/offices", { headers: { cookie: a.cookie } });
    expect(after.status).toBe(403);

    const body = (await after.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("a session with no active organization cannot reach scoped routes", async () => {
    const cookie = await signUp("orphan@example.test");
    const res = await call("/api/offices", { headers: { cookie } });
    expect(res.status).toBe(403);
  });
});

describe("tenant isolation over HTTP", () => {
  it("lists only your own offices", async () => {
    const res = await call("/api/offices", { headers: { cookie: a.cookie } });
    const body = (await res.json()) as { offices: { id: string }[] };

    expect(body.offices).toHaveLength(1);
    expect(body.offices[0]?.id).toBe(a.officeId);
  });

  it("another org's office reads as absent, not forbidden", async () => {
    // 403 would confirm the office exists. 404 tells the caller nothing.
    const res = await call(`/api/offices/${b.officeId}`, {
      headers: { cookie: a.cookie },
    });
    expect(res.status).toBe(404);
  });

  it("your own office is readable with its zones", async () => {
    const res = await call(`/api/offices/${a.officeId}`, {
      headers: { cookie: a.cookie },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      office: { id: string };
      zones: { name: string }[];
    };
    expect(body.office.id).toBe(a.officeId);
    expect(body.zones).toHaveLength(1);
  });

  it("another org's map is not downloadable", async () => {
    const res = await call(`/api/offices/${b.officeId}/map`, {
      headers: { cookie: a.cookie },
    });
    expect(res.status).toBe(404);
  });

  it("another org's roster is not readable", async () => {
    const res = await call(`/api/offices/${b.officeId}/members`, {
      headers: { cookie: a.cookie },
    });
    expect(res.status).toBe(404);
  });

  it("org member list is scoped to the active organization", async () => {
    const res = await call("/api/org/members", {
      headers: { cookie: a.cookie },
    });
    const body = (await res.json()) as { members: { email: string }[] };

    expect(body.members).toHaveLength(1);
    expect(body.members[0]?.email).toBe("alpha@example.test");
  });
});

describe("input validation", () => {
  it("a malformed office id is invalid input, not a missing resource", async () => {
    const res = await call("/api/offices/not-a-uuid", {
      headers: { cookie: a.cookie },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });

  it("an unknown route returns the standard error shape", async () => {
    const res = await call("/api/nope", { headers: { cookie: a.cookie } });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});
