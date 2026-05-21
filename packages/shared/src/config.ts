/**
 * Tuning shared by client and server.
 *
 * These live here because both sides need the same numbers: the client drives
 * subscription and volume from them, and the server validates movement and
 * derives presence from them. Two copies would drift.
 */

export const REALTIME = {
  /** Position broadcasts per second. Not per frame (CLAUDE.md §15). */
  MOVEMENT_BROADCAST_HZ: 12,
  HEARTBEAT_INTERVAL_MS: 10_000,
  /** Missed heartbeats past this and the server marks the player offline. */
  HEARTBEAT_TIMEOUT_MS: 30_000,
  AWAY_AFTER_MS: 5 * 60_000,
  /** Server rejects position deltas implying more than this. */
  MAX_SPEED_PX_PER_SEC: 240,
} as const;

/**
 * Proximity radii, in world pixels.
 *
 * The two-radius pattern is the whole reason connection churn does not happen:
 * a track is subscribed at AUDIO_SUBSCRIBE and only dropped once past
 * AUDIO_UNSUBSCRIBE, so someone pacing on the boundary does not flap.
 * Invariant: SUBSCRIBE < UNSUBSCRIBE, and FULL_VOLUME < SUBSCRIBE.
 */
export const PROXIMITY = {
  RECOMPUTE_HZ: 8,

  /*
   * Radii are in world pixels, chosen so they correspond to a sensible number
   * of tiles at the current art pack's 32px grid: roughly four tiles at full
   * volume, ten to pick someone up, twelve to drop them.
   *
   * They are not derived from tile size automatically, and that is a trap:
   * moving from a 16px pack to a 32px one silently halved every range in tile
   * terms until these were doubled. Revisit them whenever the grid changes.
   */
  AUDIO_FULL_VOLUME_RADIUS: 128,
  AUDIO_SUBSCRIBE_RADIUS: 320,
  AUDIO_UNSUBSCRIBE_RADIUS: 400,

  VIDEO_SUBSCRIBE_RADIUS: 224,
  VIDEO_UNSUBSCRIBE_RADIUS: 288,

  /** Nearest-N cap on simultaneous video subscriptions. */
  MAX_CONCURRENT_VIDEO: 6,
} as const;

/**
 * Linear volume falloff between the full-volume radius and the drop radius.
 * Returns 1 inside the core, 0 at or beyond the unsubscribe radius.
 */
export function volumeForDistance(distance: number): number {
  const { AUDIO_FULL_VOLUME_RADIUS, AUDIO_UNSUBSCRIBE_RADIUS } = PROXIMITY;
  if (distance <= AUDIO_FULL_VOLUME_RADIUS) return 1;
  if (distance >= AUDIO_UNSUBSCRIBE_RADIUS) return 0;
  const span = AUDIO_UNSUBSCRIBE_RADIUS - AUDIO_FULL_VOLUME_RADIUS;
  return 1 - (distance - AUDIO_FULL_VOLUME_RADIUS) / span;
}
