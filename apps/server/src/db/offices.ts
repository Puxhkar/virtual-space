import { and, eq } from "drizzle-orm";
import type { OfficeId } from "@vo/shared";
import type { Db } from "./client.js";
import type { Scope } from "../scope.js";
import { maps, offices, officeMembers, user, zones } from "./schema.js";

/**
 * Office reads.
 *
 * Every query filters on `scope.orgId`. None of them accept an org id from the
 * caller — the scope comes from a verified session. An id being hard to guess
 * is not access control (CLAUDE.md §13).
 */

/** Offices in the caller's organization that the caller may actually enter. */
export async function listOfficesForUser(db: Db, scope: Scope) {
  return db
    .select({
      id: offices.id,
      name: offices.name,
      mapId: offices.mapId,
      mapVersion: offices.mapVersion,
    })
    .from(offices)
    .innerJoin(
      officeMembers,
      and(
        eq(officeMembers.officeId, offices.id),
        eq(officeMembers.userId, scope.userId),
      ),
    )
    .where(eq(offices.orgId, scope.orgId));
}

/**
 * Returns undefined both when the office does not exist and when it belongs to
 * another organization. The caller cannot distinguish the two, so this does not
 * leak existence across the tenant boundary.
 */
export async function getOffice(db: Db, scope: Scope, officeId: OfficeId) {
  const rows = await db
    .select()
    .from(offices)
    .where(and(eq(offices.id, officeId), eq(offices.orgId, scope.orgId)))
    .limit(1);

  return rows[0];
}

/** Zones of an office, scoped twice — by org and by office. */
export async function listZones(db: Db, scope: Scope, officeId: OfficeId) {
  return db
    .select()
    .from(zones)
    .where(and(eq(zones.officeId, officeId), eq(zones.orgId, scope.orgId)));
}

/** Whether the caller may enter a given office. */
export async function canEnterOffice(
  db: Db,
  scope: Scope,
  officeId: OfficeId,
): Promise<boolean> {
  const rows = await db
    .select({ officeId: officeMembers.officeId })
    .from(officeMembers)
    .where(
      and(
        eq(officeMembers.officeId, officeId),
        eq(officeMembers.userId, scope.userId),
        eq(officeMembers.orgId, scope.orgId),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * The map an office renders, at the version the office pins.
 *
 * Joined through `offices` so the org filter applies to the map as well —
 * fetching a map by id alone would bypass the tenant boundary.
 */
export async function getOfficeMap(db: Db, scope: Scope, officeId: OfficeId) {
  const rows = await db
    .select({
      mapId: maps.id,
      name: maps.name,
      version: maps.version,
      tileSize: maps.tileSize,
      data: maps.data,
    })
    .from(offices)
    .innerJoin(maps, eq(maps.id, offices.mapId))
    .where(and(eq(offices.id, officeId), eq(offices.orgId, scope.orgId)))
    .limit(1);

  return rows[0];
}

/** Roster for an office, with last-seen. */
export async function listOfficeMembers(
  db: Db,
  scope: Scope,
  officeId: OfficeId,
) {
  return db
    .select({
      userId: user.id,
      name: user.name,
      image: user.image,
      lastSeenAt: officeMembers.lastSeenAt,
    })
    .from(officeMembers)
    .innerJoin(user, eq(user.id, officeMembers.userId))
    .where(
      and(
        eq(officeMembers.officeId, officeId),
        eq(officeMembers.orgId, scope.orgId),
      ),
    );
}
