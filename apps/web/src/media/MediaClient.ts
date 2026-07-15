import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import type { ProximityDecision } from "@vo/shared";

/**
 * Voice and video.
 *
 * Everyone in an office joins one room and subscribes to nothing. Proximity
 * decides which tracks are subscribed and at what volume; walking across the
 * office toggles subscriptions on an existing connection rather than
 * renegotiating one, which is why pacing at the edge of a radius costs nothing.
 *
 * Participant identity is the user id, set server-side in the token, so the
 * mapping from a person on the map to a track here needs no extra signalling.
 */

export type MediaState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "failed";

export interface MediaCredentials {
  url: string;
  token: string;
  room: string;
  identity: string;
}

/** A video track that is currently subscribed and worth showing. */
export interface VideoFeed {
  userId: string;
  name: string;
  source: "camera" | "screen";
  track: RemoteTrack;
}

export interface MediaHandlers {
  onStateChange(state: MediaState): void;
  onSpeakingChange(userIds: string[]): void;
  onDeviceError(message: string): void;
  /** Called whenever the set of visible video feeds changes. */
  onVideoChange(feeds: VideoFeed[]): void;
}

export class MediaClient {
  private room: Room | undefined;
  private handlers: Partial<MediaHandlers> = {};

  /** Last applied volume per user, so unchanged values are not reapplied. */
  private volumes = new Map<string, number>();

  /**
   * What proximity currently wants subscribed.
   *
   * Kept separately from what is actually subscribed because the two can
   * legitimately differ: a peer who has not published their microphone yet
   * cannot be subscribed to. Without this, turning a microphone on after
   * someone walked into range would never be heard — the decision does not
   * repeat, because from the engine's point of view nothing changed.
   */
  private readonly desired = {
    audio: new Set<string>(),
    video: new Set<string>(),
  };

  attach(handlers: Partial<MediaHandlers>): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  async connect(credentials: MediaCredentials): Promise<void> {
    this.handlers.onStateChange?.("connecting");

    const room = new Room({
      adaptiveStream: true,
      // Layers let a distant peer's video be fetched at a lower resolution
      // instead of full size.
      dynacast: true,
    });
    this.room = room;

    room
      .on(RoomEvent.Disconnected, () =>
        this.handlers.onStateChange?.("disconnected"),
      )
      .on(RoomEvent.Reconnecting, () =>
        this.handlers.onStateChange?.("reconnecting"),
      )
      .on(RoomEvent.Reconnected, () =>
        this.handlers.onStateChange?.("connected"),
      )
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) =>
        this.handlers.onSpeakingChange?.(speakers.map((s) => s.identity)),
      )
      // Reconcile when a track appears. This is the event that makes turning
      // a microphone on actually audible to people already in range.
      .on(RoomEvent.TrackPublished, (_publication, participant) =>
        this.reconcile(participant.identity),
      )
      .on(RoomEvent.ParticipantConnected, (participant) =>
        this.reconcile(participant.identity),
      )
      // Video appears and disappears as people walk in and out of range, so
      // the UI is told rather than left to poll.
      .on(RoomEvent.TrackSubscribed, () => this.publishVideo())
      .on(RoomEvent.TrackUnsubscribed, () => this.publishVideo())
      .on(RoomEvent.ParticipantDisconnected, () => this.publishVideo());

    try {
      await room.connect(credentials.url, credentials.token, {
        // The whole design in one option: join the room, subscribe to nobody.
        autoSubscribe: false,
      });
      this.handlers.onStateChange?.("connected");
    } catch (error) {
      this.handlers.onStateChange?.("failed");
      throw error;
    }
  }

  /**
   * Applies a proximity decision.
   *
   * Idempotent: a decision that changes nothing performs no work, which is why
   * it is safe to call several times a second.
   */
  applyDecision(decision: ProximityDecision): void {
    const room = this.room;
    if (!room) return;

    for (const userId of decision.audio.unsubscribe) {
      this.desired.audio.delete(userId);
      this.setSubscribed(userId, Track.Source.Microphone, false);
      this.volumes.delete(userId);
    }
    for (const userId of decision.video.unsubscribe) {
      this.desired.video.delete(userId);
      this.setSubscribed(userId, Track.Source.Camera, false);
    }
    for (const userId of decision.audio.subscribe) {
      this.desired.audio.add(userId);
      this.setSubscribed(userId, Track.Source.Microphone, true);
    }
    for (const userId of decision.video.subscribe) {
      this.desired.video.add(userId);
      this.setSubscribed(userId, Track.Source.Camera, true);
    }

    for (const [userId, volume] of decision.audio.volume) {
      // Volume changes every tick as people walk, so skip the no-ops rather
      // than touching the audio element sixty times a second.
      if (this.volumes.get(userId) === volume) continue;
      this.volumes.set(userId, volume);
      // remoteParticipants is keyed by identity and typed as RemoteParticipant,
      // unlike getParticipantByIdentity which widens to Participant.
      room.remoteParticipants.get(userId)?.setVolume(volume);
    }
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    await this.withDevice(
      () => this.room?.localParticipant.setMicrophoneEnabled(enabled),
      "microphone",
    );
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    await this.withDevice(
      () => this.room?.localParticipant.setCameraEnabled(enabled),
      "camera",
    );
  }

  /**
   * Input devices.
   *
   * Labels are only populated after permission has been granted, so a picker
   * shown before that lists anonymous entries. Callers should ask for the
   * device only once the user has already allowed the microphone.
   */
  static async listDevices(): Promise<{
    microphones: MediaDeviceInfo[];
    cameras: MediaDeviceInfo[];
  }> {
    try {
      const devices = await Room.getLocalDevices();
      return {
        microphones: devices.filter((d) => d.kind === "audioinput"),
        cameras: devices.filter((d) => d.kind === "videoinput"),
      };
    } catch {
      // A browser that refuses to enumerate is not an error worth surfacing —
      // the default device still works.
      return { microphones: [], cameras: [] };
    }
  }

  async selectMicrophone(deviceId: string): Promise<void> {
    await this.withDevice(
      () => this.room?.switchActiveDevice("audioinput", deviceId),
      "microphone",
    );
  }

  async selectCamera(deviceId: string): Promise<void> {
    await this.withDevice(
      () => this.room?.switchActiveDevice("videoinput", deviceId),
      "camera",
    );
  }

  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    await this.withDevice(
      () => this.room?.localParticipant.setScreenShareEnabled(enabled),
      "screen",
    );
  }

  get isMicrophoneEnabled(): boolean {
    return this.room?.localParticipant.isMicrophoneEnabled ?? false;
  }

  get isCameraEnabled(): boolean {
    return this.room?.localParticipant.isCameraEnabled ?? false;
  }

  /** The audio/video element for a peer, for the UI to mount. */
  trackFor(
    userId: string,
    source: Track.Source,
  ): RemoteTrackPublication | undefined {
    return this.room?.remoteParticipants
      .get(userId)
      ?.getTrackPublication(source);
  }

  /**
   * Collects the video tracks currently worth rendering.
   *
   * Screen shares come first: someone sharing is almost always the thing you
   * are meant to be looking at.
   */
  private publishVideo(): void {
    const room = this.room;
    if (!room) return;

    const feeds: VideoFeed[] = [];

    for (const participant of room.remoteParticipants.values()) {
      for (const [source, kind] of [
        [Track.Source.ScreenShare, "screen"],
        [Track.Source.Camera, "camera"],
      ] as const) {
        const publication = (
          participant as RemoteParticipant
        ).getTrackPublication(source);

        if (publication?.isSubscribed && publication.track) {
          feeds.push({
            userId: participant.identity,
            name: participant.name || participant.identity,
            source: kind,
            track: publication.track,
          });
        }
      }
    }

    feeds.sort((a, b) =>
      a.source === "screen" ? -1 : b.source === "screen" ? 1 : 0,
    );
    this.handlers.onVideoChange?.(feeds);
  }

  /**
   * Live room state, for end-to-end tests.
   *
   * Whether a track is subscribed is invisible from the DOM — the whole
   * proximity design lives inside the SFU connection — so without this a
   * browser test can only check that a button exists.
   */
  inspect(): {
    connected: boolean;
    participants: string[];
    subscribedAudio: string[];
    subscribedVideo: string[];
    desiredAudio: string[];
    volumes: Record<string, number>;
  } {
    const room = this.room;
    if (!room) {
      return {
        connected: false,
        participants: [],
        subscribedAudio: [],
        subscribedVideo: [],
        desiredAudio: [],
        volumes: {},
      };
    }

    const subscribed = (source: Track.Source) =>
      [...room.remoteParticipants.values()]
        .filter((p) => p.getTrackPublication(source)?.isSubscribed)
        .map((p) => p.identity);

    return {
      connected: room.state === "connected",
      participants: [...room.remoteParticipants.keys()],
      subscribedAudio: subscribed(Track.Source.Microphone),
      subscribedVideo: subscribed(Track.Source.Camera),
      desiredAudio: [...this.desired.audio],
      volumes: Object.fromEntries(this.volumes),
    };
  }

  async disconnect(): Promise<void> {
    this.volumes.clear();
    this.desired.audio.clear();
    this.desired.video.clear();
    this.handlers.onVideoChange?.([]);
    await this.room?.disconnect();
    this.room = undefined;
    this.handlers.onStateChange?.("idle");
  }

  /* ------------------------------------------------------------------ */

  /** Re-applies the desired state for one peer, once their tracks exist. */
  private reconcile(userId: string): void {
    this.setSubscribed(
      userId,
      Track.Source.Microphone,
      this.desired.audio.has(userId),
    );
    this.setSubscribed(
      userId,
      Track.Source.Camera,
      this.desired.video.has(userId),
    );

    const volume = this.volumes.get(userId);
    if (volume !== undefined) {
      this.room?.remoteParticipants.get(userId)?.setVolume(volume);
    }
  }

  private setSubscribed(
    userId: string,
    source: Track.Source,
    subscribed: boolean,
  ): void {
    const publication = this.trackFor(userId, source);
    // A peer who has not published yet is not an error — they may be muted,
    // or still joining. The next tick will pick them up.
    if (!publication) return;
    if (publication.isSubscribed === subscribed) return;
    publication.setSubscribed(subscribed);
  }

  /**
   * Device errors are the most common failure in this whole product and the
   * one users can actually fix, so they get a specific message rather than a
   * generic failure (CLAUDE.md §21).
   */
  private async withDevice(
    action: () => Promise<unknown> | undefined,
    device: "microphone" | "camera" | "screen",
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const label = device === "screen" ? "screen sharing" : `your ${device}`;

      this.handlers.onDeviceError?.(
        name === "NotAllowedError"
          ? `Access to ${label} was blocked. Allow it in your browser's address bar, then try again.`
          : name === "NotFoundError"
            ? `No ${device} was found. Check that one is connected.`
            : `Could not start ${label}.`,
      );
    }
  }
}
