import { and, eq } from "drizzle-orm";
import type { OrgId, UserId } from "@vo/shared";
import type { Db } from "./client.js";
import { isOrgRole, type OrgRole } from "../scope.js";
import { member, organization, user } from "./schema.js";

/** Organizations the user belongs to, with their role in each. */
export async function listMemberships(db: Db, userId: UserId) {
  const rows = await db
    .select({
      orgId: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId));

  return rows.map((r) => ({
    ...r,
    // Better Auth stores role as free text. Anything unrecognised is treated
    // as the least privileged role rather than trusted.
    role: isOrgRole(r.role) ? r.role : ("member" as OrgRole),
  }));
}

/**
 * The caller's role in one organization, or undefined if they are not a
 * member. This is the check that turns a session into a Scope.
 */
export async function findMembership(
  db: Db,
  userId: UserId,
  orgId: OrgId,
): Promise<OrgRole | undefined> {
  const rows = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
    .limit(1);

  const role = rows[0]?.role;
  if (role === undefined) return undefined;
  return isOrgRole(role) ? role : "member";
}

/** Members of an organization. Caller must already be scoped to it. */
export async function listOrgMembers(db: Db, orgId: OrgId) {
  return db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: member.role,
      joinedAt: member.createdAt,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId));
}
