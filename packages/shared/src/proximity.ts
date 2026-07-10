import { PROXIMITY, volumeForDistance } from "./config.js";
import { distanceSquared, type Vec2 } from "./geometry.js";
import type { PresenceStatus } from "./presence.js";

/**
 * Who you can hear, and how loudly.
 *
 * This is the whole of "walk near someone and talk", and it is deliberately a
 * pure function: given where everyone is and what is currently subscribed, it
 * returns the changes to make. No SDK, no sockets, no rendering — so the rules
 * can be tested exhaustively rather than observed by walking around.
 *
 * The output is expressed as *subscription* changes, never as connections.
 * Everyone in an office shares one SFU room; proximity toggles which tracks a
 * client subscribes to. Connecting and disconnecting peers at a boundary would
 * renegotiate every time someone paced at the edge of a radius — the churn
 * problem this design exists to avoid.
 */

export interface ProximityPeer {
  userId: string;
  position: Vec2;
  /** Zone the peer stands in, if any. */
  zoneId: string | null;
}

export interface ProximitySelf {
  position: Vec2;
  zoneId: string | null;
  presence: PresenceStatus;
}

/** What the client is subscribed to right now. */
export interface ProximityState {
  audio: ReadonlySet<string>;
  video: ReadonlySet<string>;
}

export interface ProximityDecision {
  audio: {
    subscribe: string[];
    unsubscribe: string[];
    /** userId -> 0..1. Only for peers that should be audible. */
    volume: Map<string, number>;
  };
  video: {
    subscribe: string[];
    unsubscribe: string[];
  };
}

const EMPTY: ProximityState = { audio: new Set(), video: new Set() };

export function decideProximity(
  self: ProximitySelf,
  peers: readonly ProximityPeer[],
  current: ProximityState = EMPTY,
): ProximityDecision {
  const wantAudio = new Map<string, number>();
  const wantVideo = new Set<string>();

  if (self.zoneId !== null) {
    /*
     * Inside a zone, the room replaces distance entirely: everyone in it hears
     * everyone else at full volume regardless of where they stand, and nobody
     * outside is audible. A meeting where people at opposite ends of the table
     * fade out would not be a meeting.
     */
    for (const peer of peers) {
      if (peer.zoneId === self.zoneId) {
        wantAudio.set(peer.userId, 1);
        wantVideo.add(peer.userId);
      }
    }
  } else if (self.presence !== "focus") {
    /*
     * In the open, distance decides — with two radii. A peer is picked up at
     * the inner radius and only dropped past the outer one, so someone pacing
     * on the boundary does not flap between subscribed and not.
     */
    const candidates: { userId: string; distance: number }[] = [];

    for (const peer of peers) {
      // Someone inside a zone is in a meeting; they are not overheard from the
      // open floor.
      if (peer.zoneId !== null) continue;

      const distance = Math.sqrt(distanceSquared(self.position, peer.position));
      const threshold = current.audio.has(peer.userId)
        ? PROXIMITY.AUDIO_UNSUBSCRIBE_RADIUS
        : PROXIMITY.AUDIO_SUBSCRIBE_RADIUS;

      if (distance <= threshold) {
        wantAudio.set(peer.userId, volumeForDistance(distance));
        candidates.push({ userId: peer.userId, distance });
      }
    }

    /*
     * Video is capped as well as bounded. Ten inbound video tracks is a real
     * cost on a laptop, and the people furthest away are the ones you are
     * least likely to be talking to.
     */
    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates) {
      if (wantVideo.size >= PROXIMITY.MAX_CONCURRENT_VIDEO) break;

      const threshold = current.video.has(candidate.userId)
        ? PROXIMITY.VIDEO_UNSUBSCRIBE_RADIUS
        : PROXIMITY.VIDEO_SUBSCRIBE_RADIUS;

      if (candidate.distance <= threshold) wantVideo.add(candidate.userId);
    }
  }
  // presence === "focus" and no zone: wantAudio and wantVideo stay empty, so
  // everything currently subscribed is dropped below.

  return {
    audio: {
      subscribe: [...wantAudio.keys()].filter((id) => !current.audio.has(id)),
      unsubscribe: [...current.audio].filter((id) => !wantAudio.has(id)),
      volume: wantAudio,
    },
    video: {
      subscribe: [...wantVideo].filter((id) => !current.video.has(id)),
      unsubscribe: [...current.video].filter((id) => !wantVideo.has(id)),
    },
  };
}

/** Applies a decision to a state, for callers that track it themselves. */
export function applyDecision(
  current: ProximityState,
  decision: ProximityDecision,
): ProximityState {
  const audio = new Set(current.audio);
  for (const id of decision.audio.unsubscribe) audio.delete(id);
  for (const id of decision.audio.subscribe) audio.add(id);

  const video = new Set(current.video);
  for (const id of decision.video.unsubscribe) video.delete(id);
  for (const id of decision.video.subscribe) video.add(id);

  return { audio, video };
}
