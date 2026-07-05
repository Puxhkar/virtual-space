import { io, type Socket } from "socket.io-client";
import {
  CLIENT_EVENT,
  REALTIME,
  SERVER_EVENT,
  type ClientToServerEvents,
  type Facing,
  type PlayerState,
  type RealtimeErrorPayload,
  type ServerToClientEvents,
  type SnapshotPayload,
  type ChatMessage,
  type Vec2,
  type Zone,
} from "@vo/shared";
import { API_URL } from "@/lib/env";

/**
 * The client half of the realtime contract.
 *
 * Kept out of the Phaser scene so the scene stays about rendering and this
 * stays about the wire. Reconnect is handled here, and a reconnect always
 * replays a full snapshot rather than a diff — a client that missed events
 * cannot know what it missed (CLAUDE.md §14).
 */

export type ConnectionStatus =
  "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";

/**
 * Handlers are partial and attachable because two owners share this client:
 * React wants connection status and errors, the Phaser scene wants game
 * events, and the scene does not exist until after the client is constructed.
 */
export interface RealtimeHandlers {
  onSnapshot(snapshot: SnapshotPayload): void;
  onPlayerJoined(player: PlayerState): void;
  onPlayerLeft(userId: string): void;
  onPlayerMoved(userId: string, position: Vec2, facing: Facing): void;
  onPresenceChanged(userId: string, presence: PlayerState["presence"]): void;
  onZoneChanged(userId: string, zoneId: string | null): void;
  onStatusChange(status: ConnectionStatus): void;
  onError(error: RealtimeErrorPayload): void;
  onMessage(message: ChatMessage): void;
}

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SEND_INTERVAL_MS = 1000 / REALTIME.MOVEMENT_BROADCAST_HZ;

export class RealtimeClient {
  private socket: ClientSocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  /** Latest local position, sent on the next tick rather than immediately. */
  private pending: { position: Vec2; facing: Facing } | undefined;
  private lastSentAt = 0;

  private handlers: Partial<RealtimeHandlers> = {};
  /** The most recent snapshot, replayed to a handler attached after it. */
  private lastSnapshot: SnapshotPayload | undefined;

  constructor(private readonly officeId: string) {}

  /** Merges handlers. Safe to call more than once, from different owners. */
  attach(handlers: Partial<RealtimeHandlers>): void {
    this.handlers = { ...this.handlers, ...handlers };
    // A scene that attaches after the snapshot arrived would otherwise render
    // an empty office until someone next moved.
    if (handlers.onSnapshot && this.lastSnapshot) {
      handlers.onSnapshot(this.lastSnapshot);
    }
  }

  connect(): void {
    this.handlers.onStatusChange?.("connecting");

    const socket: ClientSocket = io(API_URL, {
      withCredentials: true,
      transports: ["websocket"],
      reconnectionAttempts: 10,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    this.socket = socket;

    socket.on("connect", () => {
      this.handlers.onStatusChange?.("connected");
      // Re-join on every connect, including reconnects. The server answers
      // with a fresh snapshot, which is how state is repaired.
      socket.emit(CLIENT_EVENT.JOIN_OFFICE, {
        officeId: this.officeId as never,
      });
    });

    socket.io.on("reconnect_attempt", () =>
      this.handlers.onStatusChange?.("reconnecting"),
    );
    socket.io.on("reconnect_failed", () =>
      this.handlers.onStatusChange?.("failed"),
    );

    socket.on("connect_error", (error) => {
      // The handshake rejects with a reason; surface it rather than a generic
      // failure, because "you were removed from this workspace" and "the
      // server is down" need different responses from the user.
      this.handlers.onError?.({
        code: error.message === "forbidden" ? "forbidden" : "unauthenticated",
        message:
          error.message === "forbidden"
            ? "You no longer have access to this office."
            : "Your session has expired. Sign in again.",
      });
      this.handlers.onStatusChange?.("failed");
    });

    socket.on("disconnect", () =>
      this.handlers.onStatusChange?.("disconnected"),
    );

    socket.on(SERVER_EVENT.SNAPSHOT, (s) => {
      this.lastSnapshot = s;
      this.handlers.onSnapshot?.(s);
    });
    socket.on(SERVER_EVENT.PLAYER_JOINED, (p) =>
      this.handlers.onPlayerJoined?.(p.player),
    );
    socket.on(SERVER_EVENT.PLAYER_LEFT, (p) =>
      this.handlers.onPlayerLeft?.(p.userId),
    );
    socket.on(SERVER_EVENT.PLAYER_MOVED, (p) =>
      this.handlers.onPlayerMoved?.(p.userId, p.position, p.facing),
    );
    socket.on(SERVER_EVENT.PRESENCE_CHANGED, (p) =>
      this.handlers.onPresenceChanged?.(p.userId, p.presence),
    );
    socket.on(SERVER_EVENT.ZONE_CHANGED, (p) =>
      this.handlers.onZoneChanged?.(p.userId, p.zoneId),
    );
    socket.on(SERVER_EVENT.MESSAGE_POSTED, (p) =>
      this.handlers.onMessage?.(p.message),
    );
    socket.on(SERVER_EVENT.ERROR, (e) => this.handlers.onError?.(e));

    this.heartbeat = setInterval(() => {
      socket.emit(CLIENT_EVENT.HEARTBEAT);
    }, REALTIME.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Records local movement. Call it every frame — it batches.
   *
   * Sending on every frame would be 60 messages a second per person
   * (CLAUDE.md §15). This keeps the wire rate fixed regardless of frame rate.
   */
  reportMovement(position: Vec2, facing: Facing, nowMs: number): void {
    this.pending = { position, facing };
    if (nowMs - this.lastSentAt < SEND_INTERVAL_MS) return;
    this.flush(nowMs);
  }

  sendMessage(
    channelId: string,
    body: string,
    parentId: string | null = null,
  ): void {
    this.socket?.emit(CLIENT_EVENT.SEND_MESSAGE, {
      channelId: channelId as never,
      parentId: parentId as never,
      body,
    });
  }

  markRead(channelId: string): void {
    this.socket?.emit(CLIENT_EVENT.MARK_READ, {
      channelId: channelId as never,
    });
  }

  /** Sends the final position immediately, so a stop is not left hanging. */
  reportStop(position: Vec2, facing: Facing): void {
    this.pending = undefined;
    this.socket?.emit(CLIENT_EVENT.STOP, { position, facing });
  }

  private flush(nowMs: number): void {
    if (!this.pending || !this.socket?.connected) return;
    this.socket.emit(CLIENT_EVENT.MOVE, {
      position: this.pending.position,
      facing: this.pending.facing,
      sentAt: Math.floor(nowMs),
    });
    this.lastSentAt = nowMs;
    this.pending = undefined;
  }

  disconnect(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.socket?.disconnect();
    this.socket = undefined;
  }
}

export type { SnapshotPayload, Zone };
