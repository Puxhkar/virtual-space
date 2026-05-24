import * as z from "zod";

/**
 * Presence is derived server-side and never asserted by the client
 * (CLAUDE.md §12). The client may *request* focus; everything else is
 * computed from connection state, heartbeat freshness and zone membership.
 */

export const PresenceStatusSchema = z.enum([
  /** Socket alive, heartbeat fresh. */
  "online",
  /** No input for longer than AWAY_AFTER_MS. */
  "away",
  /** Inside a zone with other members. */
  "in_meeting",
  /** Manually set. Suppresses proximity audio. */
  "focus",
  /** Heartbeat expired or socket closed. */
  "offline",
]);
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;

/** The only statuses a client is allowed to ask for. */
export const RequestablePresenceSchema = z.enum(["online", "focus"]);
export type RequestablePresence = z.infer<typeof RequestablePresenceSchema>;
