import { Hono } from "hono";
import * as z from "zod";
import { OfficeIdSchema, SaveMapInputSchema } from "@vo/shared";
import { db } from "../db/client.js";
import {
  canEnterOffice,
  getOffice,
  getOfficeMap,
  listOfficeMembers,
  listOfficesForUser,
  listZones,
} from "../db/offices.js";
import { ApiError, notFound } from "../http/errors.js";
import { mediaEnabled, mintOfficeToken } from "../media/tokens.js";
import { MapValidationError, saveOfficeMap } from "../db/maps.js";
import { hasAtLeast } from "../scope.js";
import { requireScope, type App } from "../http/middleware.js";
import { rateLimit } from "../http/rateLimit.js";

const officeParam = z.object({ officeId: OfficeIdSchema });

/**
 * Office routes.
 *
 * Every handler takes its Scope from middleware and passes it into the query
 * layer, which cannot be called without one. A route that forgot to scope
 * would not compile.
 */
export const officeRoutes = new Hono<App>();

officeRoutes.use("*", requireScope);

officeRoutes.get("/", async (c) => {
  const offices = await listOfficesForUser(db, c.get("scope"));
  return c.json({ offices });
});

officeRoutes.get("/:officeId", async (c) => {
  const scope = c.get("scope");
  const { officeId } = parseParams(c.req.param());

  const office = await getOffice(db, scope, officeId);
  if (!office) throw notFound("That office does not exist.");

  const zones = await listZones(db, scope, officeId);
  return c.json({ office, zones });
});

officeRoutes.get("/:officeId/map", async (c) => {
  const scope = c.get("scope");
  const { officeId } = parseParams(c.req.param());

  // Entering is a stricter check than viewing: the map is the office's
  // contents, not its name.
  if (!(await canEnterOffice(db, scope, officeId))) {
    throw notFound("That office does not exist.");
  }

  const map = await getOfficeMap(db, scope, officeId);
  if (!map) throw notFound("That office has no map.");

  // Maps are immutable per version, so they cache well and are re-fetched only
  // when the office pins a new version.
  c.header("cache-control", "private, max-age=300");
  return c.json({ map });
});

officeRoutes.get("/:officeId/members", async (c) => {
  const scope = c.get("scope");
  const { officeId } = parseParams(c.req.param());

  if (!(await getOffice(db, scope, officeId))) {
    throw notFound("That office does not exist.");
  }

  const members = await listOfficeMembers(db, scope, officeId);
  return c.json({ members });
});

/**
 * Mints a short-lived LiveKit token.
 *
 * POST rather than GET: it is not idempotent in any useful sense, it must
 * never be cached, and it must not end up in a browser history or a proxy log.
 */
officeRoutes.post(
  "/:officeId/token",
  // A media token is a credential. One per join, a handful per reconnect
  // storm — nothing legitimate needs more than this.
  rateLimit({ name: "media-token", limit: 30, windowMs: 60_000 }),
  async (c) => {
    const scope = c.get("scope");
    const { officeId } = parseParams(c.req.param());

    if (!(await canEnterOffice(db, scope, officeId))) {
      throw notFound("That office does not exist.");
    }

    const credentials = await mintOfficeToken(
      scope,
      officeId,
      c.get("displayName"),
    );

    c.header("cache-control", "no-store");
    return c.json(credentials);
  },
);

/** Lets the client hide media controls entirely when the server has no keys. */
officeRoutes.get("/:officeId/media-status", async (c) => {
  const scope = c.get("scope");
  const { officeId } = parseParams(c.req.param());

  if (!(await canEnterOffice(db, scope, officeId))) {
    throw notFound("That office does not exist.");
  }
  return c.json({ enabled: mediaEnabled() });
});

/**
 * Publishes an edited office.
 *
 * Owners and admins only — the office is shared, so one person's layout is
 * everyone's workspace. The body is layers and zones, never a whole map
 * document; the server builds that (CLAUDE.md §12).
 */
officeRoutes.put(
  "/:officeId/map",
  rateLimit({ name: "map-save", limit: 30, windowMs: 60_000 }),
  async (c) => {
    const scope = c.get("scope");
    const { officeId } = parseParams(c.req.param());

    if (!hasAtLeast(scope, "admin")) {
      throw new ApiError(
        "forbidden",
        "Only an owner or admin can change the office layout.",
      );
    }

    if (!(await canEnterOffice(db, scope, officeId))) {
      throw notFound("That office does not exist.");
    }

    const parsed = SaveMapInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new ApiError(
        "invalid_input",
        parsed.error.issues[0]?.message ?? "That layout is not valid.",
      );
    }

    try {
      const result = await saveOfficeMap(db, scope, officeId, parsed.data);
      return c.json(result);
    } catch (error) {
      if (error instanceof MapValidationError) {
        // These are the messages an admin needs to fix their layout, so they
        // are shown rather than swallowed.
        throw new ApiError("invalid_input", error.message);
      }
      throw error;
    }
  },
);

function parseParams(params: Record<string, string>) {
  const parsed = officeParam.safeParse(params);
  if (!parsed.success) {
    // A malformed id is not a lookup failure; say so rather than 404ing, which
    // would suggest the id was well-formed but absent.
    throw new ApiError("invalid_input", "That office id is not valid.");
  }
  return parsed.data;
}
