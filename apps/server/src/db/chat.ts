import { and, asc, count, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { ChannelId, ChatMessage, MessageId, UserId } from "@vo/shared";
import type { Db } from "./client.js";
import type { Scope } from "../scope.js";
import { channelMembers, channels, messages, user } from "./schema.js";

/**
 * Chat reads and writes.
 *
 * Same rule as everywhere else: every query is scoped by organization, and
 * membership of a private channel is checked rather than assumed. A channel id
 * is not a capability (CLAUDE.md §13).
 */

/** Channels the caller can see, with an unread count for each. */
export async function listChannels(db: Db, scope: Scope) {
  const rows = await db
    .select({
      id: channels.id,
      kind: channels.kind,
      name: channels.name,
      topic: channels.topic,
      lastReadAt: channelMembers.lastReadAt,
    })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(
      and(
        eq(channelMembers.userId, scope.userId),
        eq(channelMembers.orgId, scope.orgId),
      ),
    )
    .orderBy(asc(channels.name));

  // Counted per channel rather than with one grouped query, because the list
  // is short and the grouped version is much harder to read for no measurable
  // gain at this size.
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id as ChannelId,
      kind: row.kind,
      name: row.name,
      topic: row.topic,
      unread: await unreadCount(db, scope, row.id as ChannelId, row.lastReadAt),
    })),
  );
}

async function unreadCount(
  db: Db,
  scope: Scope,
  channelId: ChannelId,
  since: Date | null,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.orgId, scope.orgId),
        isNull(messages.deletedAt),
        // Your own messages are never unread.
        sql`${messages.authorId} is distinct from ${scope.userId}`,
        since ? gt(messages.createdAt, since) : undefined,
      ),
    );
  return row?.n ?? 0;
}

/** Whether the caller is a member of a channel in their own organization. */
export async function canReadChannel(
  db: Db,
  scope: Scope,
  channelId: ChannelId,
): Promise<boolean> {
  const rows = await db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.userId, scope.userId),
        eq(channelMembers.orgId, scope.orgId),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * A page of history, newest first.
 *
 * Cursor-based rather than offset-based: with an offset, a message arriving
 * while someone scrolls shifts every later page by one and they see a
 * duplicate or miss a line.
 */
export async function listMessages(
  db: Db,
  scope: Scope,
  channelId: ChannelId,
  options: { before?: Date | undefined; limit?: number } = {},
): Promise<ChatMessage[]> {
  const limit = Math.min(options.limit ?? 50, 100);

  const rows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      parentId: messages.parentId,
      authorId: messages.authorId,
      authorName: user.name,
      body: messages.body,
      editedAt: messages.editedAt,
      deletedAt: messages.deletedAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(user, eq(user.id, messages.authorId))
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.orgId, scope.orgId),
        options.before ? lt(messages.createdAt, options.before) : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows.map(toChatMessage);
}

export async function postMessage(
  db: Db,
  scope: Scope,
  input: { channelId: ChannelId; parentId: MessageId | null; body: string },
): Promise<ChatMessage> {
  const [inserted] = await db
    .insert(messages)
    .values({
      orgId: scope.orgId,
      channelId: input.channelId,
      parentId: input.parentId,
      authorId: scope.userId,
      body: input.body,
    })
    .returning();

  if (!inserted) throw new Error("insert returned no row");

  const [author] = await db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, scope.userId));

  return toChatMessage({ ...inserted, authorName: author?.name ?? null });
}

export async function markRead(
  db: Db,
  scope: Scope,
  channelId: ChannelId,
): Promise<void> {
  await db
    .update(channelMembers)
    .set({ lastReadAt: new Date() })
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.userId, scope.userId),
        eq(channelMembers.orgId, scope.orgId),
      ),
    );
}

/** Everyone who should receive a message posted to a channel. */
export async function channelAudience(
  db: Db,
  scope: Scope,
  channelId: ChannelId,
): Promise<UserId[]> {
  const rows = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.orgId, scope.orgId),
      ),
    );
  return rows.map((r) => r.userId as UserId);
}

/* ------------------------------------------------------------------ */

interface MessageRow {
  id: string;
  channelId: string;
  parentId: string | null;
  authorId: string | null;
  authorName: string | null;
  body: string;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

function toChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id as MessageId,
    channelId: row.channelId as ChannelId,
    parentId: row.parentId as MessageId | null,
    authorId: row.authorId as UserId | null,
    // A deleted account leaves its messages behind; removing a person should
    // not silently rewrite a conversation others took part in.
    authorName: row.authorName ?? "Former member",
    // The row survives deletion so replies keep their context, but the text
    // does not travel.
    body: row.deletedAt ? "" : row.body,
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
