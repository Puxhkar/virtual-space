import * as z from "zod";
import { UserIdSchema, ZoneIdSchema } from "./ids.js";
import { FacingSchema, Vec2Schema } from "./geometry.js";
import { PresenceStatusSchema } from "./presence.js";

/**
 * What every client knows about another person in the office.
 *
 * Deliberately minimal: this shape is broadcast on every state snapshot, so
 * anything that is not needed to render or to compute proximity belongs in a
 * REST call instead (CLAUDE.md §15).
 */
export const PlayerStateSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string().min(1).max(64),
  avatarKey: z.string().min(1).max(64),
  position: Vec2Schema,
  facing: FacingSchema,
  presence: PresenceStatusSchema,
  zoneId: ZoneIdSchema.nullable(),
});
export type PlayerState = z.infer<typeof PlayerStateSchema>;
