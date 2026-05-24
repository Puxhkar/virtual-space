import * as z from "zod";
import { ZoneIdSchema } from "./ids.js";
import { RectSchema } from "./geometry.js";

/**
 * Zones come from the map JSON as object rectangles (phase 03) and override
 * the distance rules of the proximity engine (phase 10).
 */

export const ZoneKindSchema = z.enum([
  /** Everyone inside hears everyone inside, regardless of distance. */
  "meeting",
  /** Same as meeting, but capacity-limited. */
  "booth",
  /** Solo. Proximity audio suppressed while seated. */
  "desk",
  /** No audio at all. */
  "quiet",
]);
export type ZoneKind = z.infer<typeof ZoneKindSchema>;

export const ZoneSchema = z.object({
  id: ZoneIdSchema,
  name: z.string().min(1).max(64),
  kind: ZoneKindSchema,
  bounds: RectSchema,
  /** null means no limit. Enforced server-side on enter. */
  capacity: z.int().min(1).nullable(),
});
export type Zone = z.infer<typeof ZoneSchema>;
