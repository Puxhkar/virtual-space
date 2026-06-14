import * as z from "zod";
import { OfficeIdSchema, UserIdSchema, ZoneIdSchema } from "./ids.js";
import { FacingSchema, Vec2Schema } from "./geometry.js";
import { PlayerStateSchema } from "./player.js";
import { PresenceStatusSchema, RequestablePresenceSchema } from "./presence.js";
import { ZoneSchema } from "./zone.js";
import {
  ChatMessageSchema,
  MarkReadPayloadSchema,
  SendMessagePayloadSchema,
  type MarkReadPayload,
  type SendMessagePayload,
} from "./chat.js";

/**
 * The realtime contract.
 *
 * Every inbound payload has a schema and the server parses it before acting —
 * a socket is an untrusted input surface exactly like an HTTP body
 * (CLAUDE.md §12, §14). Event names are namespaced by direction so a misrouted
 * handler is a compile error rather than a silent no-op.
 */

/* ------------------------------------------------------------------ */
/* Client -> Server                                                    */
/* ------------------------------------------------------------------ */

export const JoinOfficePayloadSchema = z.object({
  officeId: OfficeIdSchema,
});
export type JoinOfficePayload = z.infer<typeof JoinOfficePayloadSchema>;

export const MovePayloadSchema = z.object({
  position: Vec2Schema,
  facing: FacingSchema,
  /** Client clock, used only to rate-limit and to reject implausible speed. */
  sentAt: z.int().min(0),
});
export type MovePayload = z.infer<typeof MovePayloadSchema>;

export const StopPayloadSchema = z.object({
  position: Vec2Schema,
  facing: FacingSchema,
});
export type StopPayload = z.infer<typeof StopPayloadSchema>;

export const SetPresencePayloadSchema = z.object({
  status: RequestablePresenceSchema,
});
export type SetPresencePayload = z.infer<typeof SetPresencePayloadSchema>;

export const CLIENT_EVENT = {
  JOIN_OFFICE: "client:join_office",
  MOVE: "client:move",
  STOP: "client:stop",
  HEARTBEAT: "client:heartbeat",
  SET_PRESENCE: "client:set_presence",
  SEND_MESSAGE: "client:send_message",
  MARK_READ: "client:mark_read",
} as const;
export type ClientEventName = (typeof CLIENT_EVENT)[keyof typeof CLIENT_EVENT];

/** Server-side validation table. Keyed by event name so no handler is missed. */
export const CLIENT_EVENT_SCHEMA = {
  [CLIENT_EVENT.JOIN_OFFICE]: JoinOfficePayloadSchema,
  [CLIENT_EVENT.MOVE]: MovePayloadSchema,
  [CLIENT_EVENT.STOP]: StopPayloadSchema,
  [CLIENT_EVENT.HEARTBEAT]: z.object({}),
  [CLIENT_EVENT.SET_PRESENCE]: SetPresencePayloadSchema,
  [CLIENT_EVENT.SEND_MESSAGE]: SendMessagePayloadSchema,
  [CLIENT_EVENT.MARK_READ]: MarkReadPayloadSchema,
} as const;

/* ------------------------------------------------------------------ */
/* Server -> Client                                                    */
/* ------------------------------------------------------------------ */

/**
 * Full state on join and on every reconnect. Reconnect replays a snapshot
 * rather than a diff, because a client that missed events cannot know what it
 * missed (CLAUDE.md §14).
 */
export const SnapshotPayloadSchema = z.object({
  officeId: OfficeIdSchema,
  selfUserId: UserIdSchema,
  players: z.array(PlayerStateSchema),
  zones: z.array(ZoneSchema),
  serverTime: z.int().min(0),
});
export type SnapshotPayload = z.infer<typeof SnapshotPayloadSchema>;

export const PlayerJoinedPayloadSchema = z.object({
  player: PlayerStateSchema,
});
export type PlayerJoinedPayload = z.infer<typeof PlayerJoinedPayloadSchema>;

export const PlayerLeftPayloadSchema = z.object({
  userId: UserIdSchema,
});
export type PlayerLeftPayload = z.infer<typeof PlayerLeftPayloadSchema>;

export const PlayerMovedPayloadSchema = z.object({
  userId: UserIdSchema,
  position: Vec2Schema,
  facing: FacingSchema,
});
export type PlayerMovedPayload = z.infer<typeof PlayerMovedPayloadSchema>;

export const PresenceChangedPayloadSchema = z.object({
  userId: UserIdSchema,
  presence: PresenceStatusSchema,
});
export type PresenceChangedPayload = z.infer<
  typeof PresenceChangedPayloadSchema
>;

export const ZoneChangedPayloadSchema = z.object({
  userId: UserIdSchema,
  zoneId: ZoneIdSchema.nullable(),
});
export type ZoneChangedPayload = z.infer<typeof ZoneChangedPayloadSchema>;

export const MessagePostedPayloadSchema = z.object({
  message: ChatMessageSchema,
});
export type MessagePostedPayload = z.infer<typeof MessagePostedPayloadSchema>;

export const RealtimeErrorCodeSchema = z.enum([
  "unauthenticated",
  "forbidden",
  "office_not_found",
  "channel_not_found",
  "zone_full",
  "invalid_payload",
  "rate_limited",
  "internal",
]);
export type RealtimeErrorCode = z.infer<typeof RealtimeErrorCodeSchema>;

export const RealtimeErrorPayloadSchema = z.object({
  code: RealtimeErrorCodeSchema,
  /** Safe to show a user. Never contains internal detail (CLAUDE.md §12). */
  message: z.string(),
});
export type RealtimeErrorPayload = z.infer<typeof RealtimeErrorPayloadSchema>;

export const SERVER_EVENT = {
  SNAPSHOT: "server:snapshot",
  PLAYER_JOINED: "server:player_joined",
  PLAYER_LEFT: "server:player_left",
  PLAYER_MOVED: "server:player_moved",
  PRESENCE_CHANGED: "server:presence_changed",
  ZONE_CHANGED: "server:zone_changed",
  MESSAGE_POSTED: "server:message_posted",
  ERROR: "server:error",
} as const;
export type ServerEventName = (typeof SERVER_EVENT)[keyof typeof SERVER_EVENT];

/* ------------------------------------------------------------------ */
/* Socket.IO typing                                                    */
/* ------------------------------------------------------------------ */

export interface ClientToServerEvents {
  [CLIENT_EVENT.JOIN_OFFICE]: (payload: JoinOfficePayload) => void;
  [CLIENT_EVENT.MOVE]: (payload: MovePayload) => void;
  [CLIENT_EVENT.STOP]: (payload: StopPayload) => void;
  [CLIENT_EVENT.HEARTBEAT]: () => void;
  [CLIENT_EVENT.SET_PRESENCE]: (payload: SetPresencePayload) => void;
  [CLIENT_EVENT.SEND_MESSAGE]: (payload: SendMessagePayload) => void;
  [CLIENT_EVENT.MARK_READ]: (payload: MarkReadPayload) => void;
}

export interface ServerToClientEvents {
  [SERVER_EVENT.SNAPSHOT]: (payload: SnapshotPayload) => void;
  [SERVER_EVENT.PLAYER_JOINED]: (payload: PlayerJoinedPayload) => void;
  [SERVER_EVENT.PLAYER_LEFT]: (payload: PlayerLeftPayload) => void;
  [SERVER_EVENT.PLAYER_MOVED]: (payload: PlayerMovedPayload) => void;
  [SERVER_EVENT.PRESENCE_CHANGED]: (payload: PresenceChangedPayload) => void;
  [SERVER_EVENT.ZONE_CHANGED]: (payload: ZoneChangedPayload) => void;
  [SERVER_EVENT.MESSAGE_POSTED]: (payload: MessagePostedPayload) => void;
  [SERVER_EVENT.ERROR]: (payload: RealtimeErrorPayload) => void;
}

/**
 * Per-connection state the server attaches after authenticating the socket.
 *
 * Everything here is derived from the verified session, never from anything
 * the client sent.
 */
export interface SocketData {
  userId: string;
  orgId: string;
  officeId: string | null;
  displayName: string;
  role: "owner" | "admin" | "member";
}
