import { Hono } from "hono";
import * as z from "zod";
import { ChannelIdSchema } from "@vo/shared";
import { db } from "../db/client.js";
import { canReadChannel, listChannels, listMessages } from "../db/chat.js";
import { ApiError, notFound } from "../http/errors.js";
import { requireScope, type App } from "../http/middleware.js";

/**
 * Chat history over REST.
 *
 * Reading the past is a request; receiving the present is a socket event
 * (CLAUDE.md §15). Paging through a year of history over a WebSocket would be
 * the wrong tool.
 */
export const chatRoutes = new Hono<App>();

chatRoutes.use("*", requireScope);

chatRoutes.get("/", async (c) => {
  const channels = await listChannels(db, c.get("scope"));
  return c.json({ channels });
});

const historyQuery = z.object({
  // Cursor, not offset: a message arriving mid-scroll must not shift the page.
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

chatRoutes.get("/:channelId/messages", async (c) => {
  const scope = c.get("scope");

  const params = ChannelIdSchema.safeParse(c.req.param("channelId"));
  if (!params.success) {
    throw new ApiError("invalid_input", "That channel id is not valid.");
  }
  const channelId = params.data;

  // Membership, not existence. A channel id is not a capability.
  if (!(await canReadChannel(db, scope, channelId))) {
    throw notFound("That channel does not exist.");
  }

  const query = historyQuery.safeParse({
    before: c.req.query("before"),
    limit: c.req.query("limit"),
  });
  if (!query.success) {
    throw new ApiError(
      "invalid_input",
      "Those query parameters are not valid.",
    );
  }

  const messages = await listMessages(db, scope, channelId, {
    before: query.data.before ? new Date(query.data.before) : undefined,
    limit: query.data.limit ?? 50,
  });

  return c.json({
    messages,
    // The caller does not have to know how paging works.
    nextBefore: messages.at(-1)?.createdAt ?? null,
  });
});
