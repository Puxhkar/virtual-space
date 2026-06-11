import { Hono } from "hono";
import { db } from "../db/client.js";
import { listMemberships, listOrgMembers } from "../db/orgs.js";
import { auth } from "../auth.js";
import { ApiError } from "../http/errors.js";
import { requireScope, requireUser, type App } from "../http/middleware.js";

export const meRoutes = new Hono<App>();

/**
 * Everything the client needs on load: who you are and which workspaces you
 * belong to. Deliberately one request, because the alternative is three
 * round-trips before the office can render.
 */
meRoutes.get("/me", requireUser, async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiError("unauthenticated");

  const organizations = await listMemberships(db, c.get("userId"));

  return c.json({
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      image: session.user.image ?? null,
    },
    activeOrgId: session.session.activeOrganizationId ?? null,
    organizations,
  });
});

/** Members of the active organization. */
meRoutes.get("/org/members", requireScope, async (c) => {
  const members = await listOrgMembers(db, c.get("scope").orgId);
  return c.json({ members });
});
