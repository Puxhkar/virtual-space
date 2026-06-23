import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { auth } from "../auth.js";
import { db, closeDatabase } from "../db/client.js";
import {
  channelMembers,
  channels,
  maps,
  member,
  messages,
  offices,
  officeMembers,
  organization,
  user,
  zones,
} from "../db/schema.js";
import { env } from "../env.js";

/**
 * Development seed.
 *
 * Creates one organization, one office from the generated map, and a few
 * members so the office is not empty. Idempotent — running it twice does not
 * duplicate anything.
 *
 *   pnpm --filter @vo/server seed
 *
 * Refuses to run against production. A seed script that can be pointed at a
 * live database is a data-loss incident waiting for a tired evening.
 */

const MAP_PATH = join(
  process.cwd(),
  "..",
  "web",
  "public",
  "maps",
  "office.json",
);

const ORG_SLUG = "acme";
const PASSWORD = "development-password-123";

/**
 * Ten people, because ten is the number V1 has to survive: the load test
 * needs real accounts, not synthetic sockets, so that it exercises auth,
 * membership and media tokens the same way a real morning would.
 */
const PEOPLE = [
  { email: "ada@example.com", name: "Ada" },
  { email: "grace@example.com", name: "Grace" },
  { email: "alan@example.com", name: "Alan" },
  { email: "edsger@example.com", name: "Edsger" },
  { email: "barbara@example.com", name: "Barbara" },
  { email: "donald@example.com", name: "Donald" },
  { email: "margaret@example.com", name: "Margaret" },
  { email: "linus@example.com", name: "Linus" },
  { email: "katherine@example.com", name: "Katherine" },
  { email: "tim@example.com", name: "Tim" },
];

interface TiledObject {
  name?: string;
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  properties?: { name: string; value: unknown }[];
}

async function main() {
  if (env.NODE_ENV === "production") {
    console.error("refusing to seed a production database");
    process.exit(1);
  }

  const mapData = JSON.parse(readFileSync(MAP_PATH, "utf8")) as {
    tilewidth: number;
    layers: { type: string; objects?: TiledObject[] }[];
  };

  /* ---- organization ---- */
  let [org] = await db
    .select()
    .from(organization)
    .where(eq(organization.slug, ORG_SLUG));

  if (!org) {
    const rows = await db
      .insert(organization)
      .values({
        id: crypto.randomUUID(),
        name: "Acme",
        slug: ORG_SLUG,
        createdAt: new Date(),
      })
      .returning();
    org = rows[0]!;
    console.warn(`created organization ${org.slug}`);
  }

  /* ---- people ---- */
  const userIds: string[] = [];
  for (const person of PEOPLE) {
    const [existing] = await db
      .select()
      .from(user)
      .where(eq(user.email, person.email));

    let userId = existing?.id;
    if (!userId) {
      // Through the auth API so the password is hashed the way sign-in expects.
      const created = await auth.api.signUpEmail({
        body: { email: person.email, password: PASSWORD, name: person.name },
      });
      userId = created.user.id;
      console.warn(`created user ${person.email}`);
    }
    userIds.push(userId);

    const [membership] = await db
      .select()
      .from(member)
      .where(eq(member.userId, userId));

    if (!membership) {
      await db.insert(member).values({
        id: crypto.randomUUID(),
        organizationId: org.id,
        userId,
        role: person === PEOPLE[0] ? "owner" : "member",
        createdAt: new Date(),
      });
    }
  }

  /* ---- map and office ---- */
  let [office] = await db
    .select()
    .from(offices)
    .where(eq(offices.orgId, org.id));

  let mapId = office?.mapId;
  let mapChanged = false;

  if (!mapId) {
    mapId = crypto.randomUUID();
    await db.insert(maps).values({
      id: mapId,
      orgId: org.id,
      name: "Head office",
      version: 1,
      data: mapData,
      tileSize: mapData.tilewidth,
    });
    mapChanged = true;
  } else {
    // Re-running the seed after editing generate-map.mjs must actually change
    // the office. An idempotent seed that ignores a changed map means map work
    // silently has no effect, which is a miserable thing to debug.
    const [existing] = await db.select().from(maps).where(eq(maps.id, mapId));
    if (JSON.stringify(existing?.data) !== JSON.stringify(mapData)) {
      await db
        .update(maps)
        .set({
          data: mapData,
          tileSize: mapData.tilewidth,
          version: (existing?.version ?? 1) + 1,
        })
        .where(eq(maps.id, mapId));
      mapChanged = true;
      console.warn("map changed — updated and bumped version");
    }
  }

  if (!office) {
    const rows = await db
      .insert(offices)
      .values({
        id: crypto.randomUUID(),
        orgId: org.id,
        name: "Head office",
        mapId,
        mapVersion: 1,
      })
      .returning();
    office = rows[0]!;
    console.warn(`created office ${office.name}`);
  }

  if (mapChanged) {
    const [current] = await db.select().from(maps).where(eq(maps.id, mapId));
    await db
      .update(offices)
      .set({ mapVersion: current?.version ?? 1 })
      .where(eq(offices.id, office.id));

    // Zones are extracted from the map so the realtime layer never parses map
    // JSON on the hot path (CLAUDE.md §16). Replaced wholesale, because a
    // zone removed from the map must disappear from the office too.
    await db.delete(zones).where(eq(zones.officeId, office.id));

    const objects =
      mapData.layers.find((l) => l.type === "objectgroup")?.objects ?? [];

    for (const object of objects.filter((o) => o.type === "zone")) {
      const kind = String(
        object.properties?.find((p) => p.name === "kind")?.value ?? "meeting",
      );
      const capacityRaw = Number(
        object.properties?.find((p) => p.name === "capacity")?.value ?? 0,
      );

      await db.insert(zones).values({
        id: crypto.randomUUID(),
        orgId: org.id,
        officeId: office.id,
        name: object.name ?? "Zone",
        kind: kind as "meeting" | "booth" | "desk" | "quiet",
        bounds: {
          x: object.x,
          y: object.y,
          width: object.width ?? 0,
          height: object.height ?? 0,
        },
        // 0 in the map file means unlimited.
        capacity: capacityRaw > 0 ? capacityRaw : null,
      });
      console.warn(`  zone: ${object.name} (${kind})`);
    }
  }

  /* ---- admit everyone to the office ---- */
  for (const userId of userIds) {
    await db
      .insert(officeMembers)
      .values({ officeId: office.id, userId, orgId: org.id })
      .onConflictDoNothing();
  }

  console.warn("");
  /* ---- chat ---- */
  // One general channel everyone belongs to, so the office is not silent on
  // first run and the chat panel has something to show.
  let [general] = await db
    .select()
    .from(channels)
    .where(eq(channels.orgId, org.id));

  if (!general) {
    const rows = await db
      .insert(channels)
      .values({
        orgId: org.id,
        kind: "public",
        name: "general",
        topic: "Everything and nothing",
        createdBy: userIds[0] ?? null,
      })
      .returning();
    general = rows[0]!;
    console.warn("created channel #general");

    await db.insert(messages).values({
      orgId: org.id,
      channelId: general.id,
      authorId: userIds[0] ?? null,
      body: "Morning. Standup in the room at the top right when you are ready.",
    });
  }

  for (const userId of userIds) {
    await db
      .insert(channelMembers)
      .values({ channelId: general.id, userId, orgId: org.id })
      .onConflictDoNothing();
  }

  console.warn(
    `seed complete: ${PEOPLE.length} people, password "${PASSWORD}"`,
  );
  console.warn(`  ${PEOPLE.map((p) => p.email).join("\n  ")}`);
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(error);
    await closeDatabase();
    process.exit(1);
  });
