import type { Context, MiddlewareHandler } from "hono";
import type { OrgId, UserId } from "@vo/shared";
import { auth } from "../auth.js";
import { db } from "../db/client.js";
import { findMembership } from "../db/orgs.js";
import { ApiError } from "./errors.js";
import type { Scope } from "../scope.js";

/**
 * Turns a verified session into a Scope.
 *
 * The organization comes from `session.activeOrganizationId` — the server's own
 * record — and membership is re-checked against the database on every request.
 * It is never read from a body, header or path parameter the caller controls
 * (CLAUDE.md §12, §13).
 */

export interface AppVars {
  scope: Scope;
  userId: UserId;
  displayName: string;
  requestId: string;
}

export type App = { Variables: AppVars };

export const requestId: MiddlewareHandler<App> = async (c, next) => {
  const id = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
};

/** Requires a signed-in user. Does not require an organization. */
export const requireUser: MiddlewareHandler<App> = async (c, next) => {
  const session = await getSession(c);
  if (!session) throw new ApiError("unauthenticated");
  c.set("userId", session.user.id as UserId);
  c.set("displayName", session.user.name);
  await next();
};

/**
 * Requires a signed-in user with an active organization they still belong to.
 *
 * Membership is verified per request rather than trusted from the session, so
 * removing someone from an organization takes effect immediately instead of
 * when their session happens to expire.
 */
export const requireScope: MiddlewareHandler<App> = async (c, next) => {
  const session = await getSession(c);
  if (!session) throw new ApiError("unauthenticated");

  const userId = session.user.id as UserId;
  const orgId = session.session.activeOrganizationId as
    OrgId | null | undefined;

  if (!orgId) {
    throw new ApiError(
      "forbidden",
      "Choose an organization before continuing.",
    );
  }

  const role = await findMembership(db, userId, orgId);
  if (!role) {
    throw new ApiError("forbidden", "You are not a member of that workspace.");
  }

  c.set("userId", userId);
  c.set("displayName", session.user.name);
  c.set("scope", { orgId, userId, role });
  await next();
};

async function getSession(c: Context) {
  return auth.api.getSession({ headers: c.req.raw.headers });
}
