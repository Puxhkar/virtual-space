import type { OrgId, UserId } from "@vo/shared";

/**
 * The tenant scope for a request.
 *
 * Every data-access function takes this as its first argument. That is the
 * point: forgetting to scope a query becomes a compile error rather than a
 * cross-tenant leak (CLAUDE.md §13).
 *
 * A Scope is only ever constructed from a verified session — never from a
 * request body, query string, or path parameter the caller controls.
 */
export interface Scope {
  readonly orgId: OrgId;
  readonly userId: UserId;
  readonly role: OrgRole;
}

export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

/** owner > admin > member. */
const RANK: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1 };

export function hasAtLeast(scope: Scope, required: OrgRole): boolean {
  return RANK[scope.role] >= RANK[required];
}
