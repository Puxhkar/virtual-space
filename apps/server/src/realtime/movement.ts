import { REALTIME, type Vec2 } from "@vo/shared";

/**
 * Server-side movement validation.
 *
 * The client is authoritative over its own input but not over its position —
 * a modified client could otherwise teleport across the office, into a private
 * zone, or on top of someone (CLAUDE.md §12, §14).
 *
 * This is deliberately permissive about small overshoots: latency and frame
 * jitter mean an honest client sometimes reports slightly more movement than
 * the elapsed time strictly allows. It rejects the implausible, not the
 * imperfect.
 */

/** Slack for jitter, as a multiple of the theoretical maximum distance. */
const TOLERANCE = 1.6;
/** Below this, treat elapsed time as this long — guards against divide-by-zero
 *  and against a burst of events sharing one millisecond. */
const MIN_ELAPSED_MS = 50;

export interface MoveCheck {
  ok: boolean;
  reason?: "too_fast" | "out_of_bounds";
}

export function validateMove(
  from: Vec2,
  to: Vec2,
  elapsedMs: number,
  bounds: { width: number; height: number },
): MoveCheck {
  if (to.x < 0 || to.y < 0 || to.x > bounds.width || to.y > bounds.height) {
    return { ok: false, reason: "out_of_bounds" };
  }

  const seconds = Math.max(elapsedMs, MIN_ELAPSED_MS) / 1000;
  const maxDistance = REALTIME.MAX_SPEED_PX_PER_SEC * seconds * TOLERANCE;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx * dx + dy * dy > maxDistance * maxDistance) {
    return { ok: false, reason: "too_fast" };
  }

  return { ok: true };
}
