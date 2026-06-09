import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { OfficeId, OrgId, UserId } from "@vo/shared";
import {
  closeTestDatabase,
  setupTestDatabase,
  truncateAll,
} from "../test/db.js";
import {
  canEnterOffice,
  getOffice,
  listOfficesForUser,
  listZones,
} from "./offices.js";
import {
  maps,
  member,
  officeMembers,
  offices,
  organization,
  user,
  zones,
} from "./schema.js";
import type { Scope } from "../scope.js";

/**
 * The test that decides whether multi-tenancy works.
 *
 * Two organizations, fully seeded, and then every read path is checked from
 * the wrong side of the boundary. If any of these start failing, stop and fix
 * it before shipping anything else (CLAUDE.md §13, §22).
 */

type Db = Awaited<ReturnType<typeof setupTestDatabase>>;

let db: Db;

const uuid = () => crypto.randomUUID();

interface Tenant {
  orgId: OrgId;
  userId: UserId;
  officeId: OfficeId;
  zoneId: string;
  scope: Scope;
}

async function seedTenant(name: string): Promise<Tenant> {
  const orgId = uuid();
  const userId = uuid();
  const mapId = uuid();
  const officeId = uuid();
  const zoneId = uuid();
  const now = new Date();

  await db
    .insert(organization)
    .values({ id: orgId, name, slug: name, createdAt: now });

  await db.insert(user).values({
    id: userId,
    name: `${name} user`,
    email: `${name}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(member).values({
    id: uuid(),
    organizationId: orgId,
    userId,
    role: "owner",
    createdAt: now,
  });

  await db.insert(maps).values({
    id: mapId,
    orgId,
    name: `${name} map`,
    version: 1,
    data: { layers: [] },
    tileSize: 16,
  });

  await db.insert(offices).values({
    id: officeId,
    orgId,
    name: `${name} office`,
    mapId,
    mapVersion: 1,
  });

  await db.insert(zones).values({
    id: zoneId,
    orgId,
    officeId,
    name: "Standup",
    kind: "meeting",
    bounds: { x: 0, y: 0, width: 320, height: 240 },
    capacity: null,
  });

  await db.insert(officeMembers).values({ officeId, userId, orgId });

  return {
    orgId: orgId as OrgId,
    userId: userId as UserId,
    officeId: officeId as OfficeId,
    zoneId,
    scope: {
      orgId: orgId as OrgId,
      userId: userId as UserId,
      role: "owner",
    },
  };
}

beforeAll(async () => {
  db = await setupTestDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

let a: Tenant;
let b: Tenant;

beforeEach(async () => {
  await truncateAll(db);
  a = await seedTenant("orga");
  b = await seedTenant("orgb");
});

describe("tenant isolation", () => {
  it("each tenant is seeded and visible to itself", async () => {
    const forA = await listOfficesForUser(db, a.scope);
    const forB = await listOfficesForUser(db, b.scope);

    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0]?.id).toBe(a.officeId);
    expect(forB[0]?.id).toBe(b.officeId);
  });

  it("listing offices never returns another org's office", async () => {
    const forA = await listOfficesForUser(db, a.scope);
    expect(forA.map((o) => o.id)).not.toContain(b.officeId);
  });

  it("fetching another org's office by id returns nothing", async () => {
    // The id is known and valid. Unguessability is not the control.
    const leaked = await getOffice(db, a.scope, b.officeId);
    expect(leaked).toBeUndefined();
  });

  it("fetching your own office by id still works", async () => {
    const own = await getOffice(db, a.scope, a.officeId);
    expect(own?.id).toBe(a.officeId);
  });

  it("listing zones of another org's office returns nothing", async () => {
    const leaked = await listZones(db, a.scope, b.officeId);
    expect(leaked).toHaveLength(0);
  });

  it("listing zones of your own office works", async () => {
    const own = await listZones(db, a.scope, a.officeId);
    expect(own).toHaveLength(1);
    expect(own[0]?.name).toBe("Standup");
  });

  it("cannot enter another org's office", async () => {
    expect(await canEnterOffice(db, a.scope, b.officeId)).toBe(false);
  });

  it("can enter your own office", async () => {
    expect(await canEnterOffice(db, a.scope, a.officeId)).toBe(true);
  });

  it("a user in the right org but not the office cannot enter it", async () => {
    // Same organization, second office, no office_members row.
    const otherOfficeId = uuid();
    const mapId = uuid();
    await db.insert(maps).values({
      id: mapId,
      orgId: a.orgId,
      name: "second map",
      version: 1,
      data: {},
      tileSize: 16,
    });
    await db.insert(offices).values({
      id: otherOfficeId,
      orgId: a.orgId,
      name: "second office",
      mapId,
      mapVersion: 1,
    });

    expect(await canEnterOffice(db, a.scope, otherOfficeId as OfficeId)).toBe(
      false,
    );
  });
});

describe("database constraints", () => {
  it("rejects a duplicate membership", async () => {
    // Billing counts seats from this table, so the database enforces it.
    await expect(
      db.insert(member).values({
        id: uuid(),
        organizationId: a.orgId,
        userId: a.userId,
        role: "member",
        createdAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("deleting an organization cascades to its offices and zones", async () => {
    await db.delete(organization).where(eq(organization.id, a.orgId));

    const remainingOffices = await db
      .select()
      .from(offices)
      .where(eq(offices.orgId, a.orgId));
    const remainingZones = await db
      .select()
      .from(zones)
      .where(eq(zones.orgId, a.orgId));

    expect(remainingOffices).toHaveLength(0);
    expect(remainingZones).toHaveLength(0);
  });

  it("deleting one organization leaves the other intact", async () => {
    await db.delete(organization).where(eq(organization.id, a.orgId));

    const forB = await listOfficesForUser(db, b.scope);
    expect(forB).toHaveLength(1);
    expect(forB[0]?.id).toBe(b.officeId);
  });

  it("a map in use cannot be deleted", async () => {
    const office = await getOffice(db, a.scope, a.officeId);
    await expect(
      db.delete(maps).where(eq(maps.id, office!.mapId)),
    ).rejects.toThrow();
  });
});
