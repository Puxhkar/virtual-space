import * as z from "zod";
import { UserIdSchema } from "./ids.js";

/**
 * Chat.
 *
 * The office is empty at three in the morning; chat is what makes it worth
 * opening anyway. Messages travel over the same socket as movement, because a
 * second transport would be a second thing to authenticate, reconnect and
 * debug (CLAUDE.md §7).
 */

export const ChannelIdSchema = z.uuid().brand<"ChannelId">();
export type ChannelId = z.infer<typeof ChannelIdSchema>;

export const MessageIdSchema = z.uuid().brand<"MessageId">();
export type MessageId = z.infer<typeof MessageIdSchema>;

/** Long enough for a real thought, short enough not to be a document. */
export const MESSAGE_MAX_LENGTH = 4000;

export const ChannelKindSchema = z.enum(["public", "private", "direct"]);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

export const ChannelSchema = z.object({
  id: ChannelIdSchema,
  kind: ChannelKindSchema,
  /** Null for a direct message, which is named by its participants. */
  name: z.string().nullable(),
  topic: z.string().nullable(),
  unread: z.int().min(0),
});
export type Channel = z.infer<typeof ChannelSchema>;

export const ChatMessageSchema = z.object({
  id: MessageIdSchema,
  channelId: ChannelIdSchema,
  parentId: MessageIdSchema.nullable(),
  /** Null when the author's account was deleted. The message stays. */
  authorId: UserIdSchema.nullable(),
  authorName: z.string(),
  body: z.string(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const SendMessagePayloadSchema = z.object({
  channelId: ChannelIdSchema,
  parentId: MessageIdSchema.nullable().default(null),
  // Trimmed before length is checked, so whitespace is not a message.
  body: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
});
export type SendMessagePayload = z.infer<typeof SendMessagePayloadSchema>;

export const MarkReadPayloadSchema = z.object({
  channelId: ChannelIdSchema,
});
export type MarkReadPayload = z.infer<typeof MarkReadPayloadSchema>;
