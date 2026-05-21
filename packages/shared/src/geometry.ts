import * as z from "zod";

/**
 * World-space geometry. All coordinates are in map pixels, not tiles, so the
 * proximity engine does not have to know the tile size (which lives in the
 * asset manifest and changes when the art pack changes).
 *
 * z.number() rejects NaN and Infinity by default in Zod 4, so no extra guard.
 */

export const FacingSchema = z.enum(["up", "down", "left", "right"]);
export type Facing = z.infer<typeof FacingSchema>;

export const Vec2Schema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Vec2 = z.infer<typeof Vec2Schema>;

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(0),
  height: z.number().min(0),
});
export type Rect = z.infer<typeof RectSchema>;

/** Squared distance. Avoids a sqrt in the proximity loop (CLAUDE.md §19). */
export function distanceSquared(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function containsPoint(rect: Rect, point: Vec2): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}
