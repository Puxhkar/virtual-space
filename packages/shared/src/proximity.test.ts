import { describe, expect, it } from "vitest";
import { PROXIMITY } from "./config.js";
import {
  applyDecision,
  decideProximity,
  type ProximityPeer,
  type ProximitySelf,
  type ProximityState,
} from "./proximity.js";

/**
 * The rules of "walk near someone and talk".
 *
 * Every one of these is a behaviour a person would notice: audio that cuts out
 * mid-sentence, a meeting overheard from the corridor, a laptop fan spinning
 * up because ten video tracks arrived at once.
 */

const ORIGIN = { x: 0, y: 0 };

const self = (over: Partial<ProximitySelf> = {}): ProximitySelf => ({
  position: ORIGIN,
  zoneId: null,
  presence: "online",
  ...over,
});

const peer = (
  userId: string,
  x: number,
  zoneId: string | null = null,
): ProximityPeer => ({ userId, position: { x, y: 0 }, zoneId });

const state = (audio: string[] = [], video: string[] = []): ProximityState => ({
  audio: new Set(audio),
  video: new Set(video),
});

describe("distance", () => {
  it("picks up someone who walks into range", () => {
    const d = decideProximity(self(), [peer("a", 100)], state());
    expect(d.audio.subscribe).toEqual(["a"]);
  });

  it("ignores someone beyond the pick-up radius", () => {
    const d = decideProximity(
      self(),
      [peer("a", PROXIMITY.AUDIO_SUBSCRIBE_RADIUS + 1)],
      state(),
    );
    expect(d.audio.subscribe).toEqual([]);
  });

  it("drops someone who walks away", () => {
    const d = decideProximity(self(), [peer("a", 500)], state(["a"]));
    expect(d.audio.unsubscribe).toEqual(["a"]);
  });

  it("is louder up close than far away", () => {
    const near = decideProximity(self(), [peer("a", 20)], state());
    const far = decideProximity(self(), [peer("a", 150)], state());
    expect(near.audio.volume.get("a")!).toBeGreaterThan(
      far.audio.volume.get("a")!,
    );
  });

  it("is at full volume inside the core radius", () => {
    const d = decideProximity(
      self(),
      [peer("a", PROXIMITY.AUDIO_FULL_VOLUME_RADIUS - 1)],
      state(),
    );
    expect(d.audio.volume.get("a")).toBe(1);
  });
});

describe("hysteresis", () => {
  /*
   * The reason two radii exist. Without them, someone standing exactly on the
   * boundary flips between subscribed and not on every tick, and the audio
   * stutters.
   */
  const BETWEEN =
    (PROXIMITY.AUDIO_SUBSCRIBE_RADIUS + PROXIMITY.AUDIO_UNSUBSCRIBE_RADIUS) / 2;

  it("stays subscribed in the band between the two radii", () => {
    const d = decideProximity(self(), [peer("a", BETWEEN)], state(["a"]));
    expect(d.audio.unsubscribe).toEqual([]);
    expect(d.audio.volume.has("a")).toBe(true);
  });

  it("does not pick up in that same band when not already subscribed", () => {
    const d = decideProximity(self(), [peer("a", BETWEEN)], state());
    expect(d.audio.subscribe).toEqual([]);
  });

  it("a peer pacing across the boundary never churns", () => {
    // Walk back and forth across the inner radius and count the changes.
    let current = state();
    let changes = 0;

    for (const x of [150, 165, 150, 170, 155, 168, 152]) {
      const d = decideProximity(self(), [peer("a", x)], current);
      changes += d.audio.subscribe.length + d.audio.unsubscribe.length;
      current = applyDecision(current, d);
    }

    // One subscribe on the way in, and nothing after.
    expect(changes).toBe(1);
    expect(current.audio.has("a")).toBe(true);
  });
});

describe("zones", () => {
  it("inside a zone, everyone in it is at full volume regardless of distance", () => {
    const d = decideProximity(
      self({ zoneId: "standup" }),
      [peer("a", 5000, "standup")],
      state(),
    );
    expect(d.audio.subscribe).toEqual(["a"]);
    expect(d.audio.volume.get("a")).toBe(1);
  });

  it("inside a zone, someone standing right outside it is inaudible", () => {
    const d = decideProximity(
      self({ zoneId: "standup" }),
      [peer("a", 1, null)],
      state(),
    );
    expect(d.audio.volume.has("a")).toBe(false);
  });

  it("entering a zone drops everyone you could previously hear", () => {
    const d = decideProximity(
      self({ zoneId: "standup" }),
      [peer("a", 10, null)],
      state(["a"], ["a"]),
    );
    expect(d.audio.unsubscribe).toEqual(["a"]);
    expect(d.video.unsubscribe).toEqual(["a"]);
  });

  it("a meeting is not overheard from the open floor", () => {
    // Standing right next to the meeting room is not the same as being in it.
    const d = decideProximity(self(), [peer("a", 10, "standup")], state());
    expect(d.audio.subscribe).toEqual([]);
  });

  it("two different zones do not hear each other", () => {
    const d = decideProximity(
      self({ zoneId: "standup" }),
      [peer("a", 10, "lounge")],
      state(),
    );
    expect(d.audio.volume.has("a")).toBe(false);
  });
});

describe("focus", () => {
  it("suppresses proximity audio entirely", () => {
    const d = decideProximity(
      self({ presence: "focus" }),
      [peer("a", 10)],
      state(),
    );
    expect(d.audio.subscribe).toEqual([]);
  });

  it("drops anyone already audible when focus begins", () => {
    const d = decideProximity(
      self({ presence: "focus" }),
      [peer("a", 10)],
      state(["a"]),
    );
    expect(d.audio.unsubscribe).toEqual(["a"]);
  });

  it("does not silence a meeting you are actually in", () => {
    // Focus is about the open floor. Being in a room is a deliberate act.
    const d = decideProximity(
      self({ presence: "focus", zoneId: "standup" }),
      [peer("a", 10, "standup")],
      state(),
    );
    expect(d.audio.subscribe).toEqual(["a"]);
  });
});

describe("video budget", () => {
  it("never exceeds the concurrent video cap", () => {
    const crowd = Array.from({ length: 20 }, (_, i) => peer(`p${i}`, i * 2));
    const d = decideProximity(self(), crowd, state());
    expect(d.video.subscribe.length).toBeLessThanOrEqual(
      PROXIMITY.MAX_CONCURRENT_VIDEO,
    );
  });

  it("keeps the nearest people, not an arbitrary set", () => {
    const crowd = [peer("far", 100), peer("near", 4), peer("mid", 40)];
    const d = decideProximity(self(), crowd, state());
    expect(d.video.subscribe[0]).toBe("near");
  });

  it("audio is not capped — a crowd is still audible", () => {
    // Audio is cheap and being unable to hear someone standing next to you
    // because five other people were closer would be absurd.
    const crowd = Array.from({ length: 20 }, (_, i) => peer(`p${i}`, i * 2));
    const d = decideProximity(self(), crowd, state());
    expect(d.audio.subscribe.length).toBeGreaterThan(
      PROXIMITY.MAX_CONCURRENT_VIDEO,
    );
  });

  it("video uses a tighter radius than audio", () => {
    const d = decideProximity(
      self(),
      [peer("a", PROXIMITY.VIDEO_SUBSCRIBE_RADIUS + 10)],
      state(),
    );
    expect(d.audio.subscribe).toEqual(["a"]);
    expect(d.video.subscribe).toEqual([]);
  });
});

describe("stability", () => {
  it("a settled state produces no changes", () => {
    const peers = [peer("a", 50), peer("b", 80)];
    let current = state();

    current = applyDecision(current, decideProximity(self(), peers, current));
    const second = decideProximity(self(), peers, current);

    expect(second.audio.subscribe).toEqual([]);
    expect(second.audio.unsubscribe).toEqual([]);
    expect(second.video.subscribe).toEqual([]);
    expect(second.video.unsubscribe).toEqual([]);
  });

  it("someone leaving is unsubscribed", () => {
    const d = decideProximity(self(), [], state(["gone"], ["gone"]));
    expect(d.audio.unsubscribe).toEqual(["gone"]);
    expect(d.video.unsubscribe).toEqual(["gone"]);
  });
});
