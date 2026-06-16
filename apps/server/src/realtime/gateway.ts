import { Server as SocketServer } from "socket.io";
import type { Server as HttpServer } from "node:http";
import {
  CLIENT_EVENT,
  CLIENT_EVENT_SCHEMA,
  REALTIME,
  SERVER_EVENT,
  containsPoint,
  type ClientToServerEvents,
  type OfficeId,
  type OrgId,
  type PlayerState,
  type ServerToClientEvents,
  type SocketData,
  type UserId,
  type Zone,
  type ZoneId,
} from "@vo/shared";
import { auth } from "../auth.js";
import { db } from "../db/client.js";
import {
  canEnterOffice,
  getOffice,
  getOfficeMap,
  listZones,
} from "../db/offices.js";
import { findMembership } from "../db/orgs.js";
import {
  canReadChannel,
  channelAudience,
  markRead,
  postMessage,
} from "../db/chat.js";
import { env } from "../env.js";
import type { PlayerRecord, PresenceStore } from "./PresenceStore.js";
import { readMapInfo, type MapInfo } from "./mapData.js";
import { validateMove } from "./movement.js";
import type { Scope } from "../scope.js";
import { gauge, increment, observe } from "../observability/metrics.js";
import { log } from "../observability/logger.js";

/**
 * The realtime gateway.
 *
 * Movement never goes through REST (CLAUDE.md §15) and the socket is treated
 * as an untrusted input surface exactly like an HTTP body: every payload is
 * parsed, every position is validated, and the organization comes from the
 * verified session rather than the client (§12, §14).
 */

type Io = SocketServer<
  ClientToServerEvents,
  ServerToClientEvents,
  never,
  SocketData
>;

/** Socket.IO room name. Namespaced by org so a bug cannot cross tenants. */
function roomFor(orgId: string, officeId: string): string {
  return `org:${orgId}:office:${officeId}`;
}

/**
 * A room per person, so a chat message can be delivered to its audience
 * wherever they are — including someone signed in but not in an office.
 */
function personalRoom(orgId: string, userId: string): string {
  return `org:${orgId}:user:${userId}`;
}

function toPlayerState(record: PlayerRecord): PlayerState {
  return {
    userId: record.userId,
    displayName: record.displayName,
    avatarKey: record.avatarKey,
    position: record.position,
    facing: record.facing,
    presence: record.presence,
    zoneId: record.zoneId,
  };
}

export interface RealtimeDeps {
  store: PresenceStore;
  /** Injectable for tests. */
  now?: () => number;
}

export function attachRealtime(httpServer: HttpServer, deps: RealtimeDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());

  const io: Io = new SocketServer(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    // The client resends its position on reconnect, so there is nothing to
    // recover from a buffered session.
    connectionStateRecovery: { maxDisconnectionDuration: 0 },
  });

  /*
   * Zones and map geometry, cached per office *and map version*.
   *
   * Re-reading these on every movement event would put a query inside the hot
   * loop (CLAUDE.md §16), but caching by office alone meant an edited map
   * never took effect until the server restarted — people kept spawning at
   * the old point in a room that had moved. Keying by version makes a new
   * version miss the cache naturally, with no invalidation to remember.
   */
  const zoneCache = new Map<string, Zone[]>();
  const mapCache = new Map<string, MapInfo>();

  /** Cache key: an office at a specific map version. */
  function officeVersionKey(
    orgId: string,
    officeId: string,
    mapVersion: number,
  ): string {
    return `${roomFor(orgId, officeId)}:v${mapVersion}`;
  }

  /** Offices with movement to flush on the next tick. */
  const dirty = new Map<string, Set<string>>();

  /**
   * Per-socket event budget.
   *
   * An honest client sends movement at MOVEMENT_BROADCAST_HZ and a heartbeat
   * every ten seconds. This allows several times that, so latency spikes and
   * batched replays are fine, while a client spinning a tight emit loop is
   * cut off — one socket must not be able to saturate the office
   * (CLAUDE.md §12).
   */
  const EVENT_BUDGET = REALTIME.MOVEMENT_BROADCAST_HZ * 5;
  const budgets = new Map<string, { count: number; resetAt: number }>();

  function withinBudget(socketId: string): boolean {
    const t = now();
    const window = budgets.get(socketId);

    if (!window || window.resetAt <= t) {
      budgets.set(socketId, { count: 1, resetAt: t + 1000 });
      return true;
    }
    if (window.count >= EVENT_BUDGET) return false;
    window.count += 1;
    return true;
  }

  // Read on demand rather than pushed, so the number is always current.
  gauge("realtime.connected", () => store.size());
  gauge("realtime.offices_active", () => dirty.size);

  /* ------------------------------------------------------------------ */
  /* handshake                                                           */
  /* ------------------------------------------------------------------ */

  io.use(async (socket, next) => {
    try {
      const cookie = socket.handshake.headers.cookie;
      if (!cookie) return next(new Error("unauthenticated"));

      const session = await auth.api.getSession({
        headers: new Headers({ cookie }),
      });
      if (!session) {
        increment("realtime.handshake.unauthenticated");
        return next(new Error("unauthenticated"));
      }

      const userId = session.user.id as UserId;
      const orgId = session.session.activeOrganizationId as OrgId | null;
      if (!orgId) return next(new Error("no_active_organization"));

      // Membership is re-checked here rather than trusted from the session, so
      // a removed member cannot keep an open socket alive.
      const role = await findMembership(db, userId, orgId);
      if (!role) {
        increment("realtime.handshake.forbidden");
        return next(new Error("forbidden"));
      }

      socket.data.userId = userId;
      socket.data.orgId = orgId;
      socket.data.officeId = null;
      socket.data.displayName = session.user.name;
      socket.data.role = role;
      next();
    } catch (error) {
      increment("realtime.handshake.error");
      log.error("socket handshake failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      next(error instanceof Error ? error : new Error("internal"));
    }
  });

  /* ------------------------------------------------------------------ */
  /* connection                                                          */
  /* ------------------------------------------------------------------ */

  io.on("connection", (socket) => {
    increment("realtime.connections.opened");

    // Joined immediately, before entering any office: chat should reach
    // someone who is signed in but has not walked in yet.
    void socket.join(personalRoom(socket.data.orgId, socket.data.userId));
    const scopeOf = (): Scope => ({
      orgId: socket.data.orgId as OrgId,
      userId: socket.data.userId as UserId,
      role: socket.data.role,
    });

    socket.on(CLIENT_EVENT.JOIN_OFFICE, (raw) => {
      void (async () => {
        const parsed =
          CLIENT_EVENT_SCHEMA[CLIENT_EVENT.JOIN_OFFICE].safeParse(raw);
        if (!parsed.success) return fail(socket, "invalid_payload");

        const scope = scopeOf();
        const { officeId } = parsed.data;

        if (!(await canEnterOffice(db, scope, officeId))) {
          // Absent rather than forbidden: the same non-disclosure rule as the
          // HTTP layer.
          return fail(socket, "office_not_found");
        }

        const office = await getOffice(db, scope, officeId);
        if (!office) return fail(socket, "office_not_found");

        // One person, one avatar. A second tab evicts the first rather than
        // producing two of the same person walking around.
        for (const other of store.findOtherSockets(
          scope.orgId,
          scope.userId,
          socket.id,
        )) {
          io.sockets.sockets.get(other.socketId)?.disconnect(true);
          removeAndAnnounce(other);
        }

        const zones = await loadZones(scope, officeId, office.mapVersion);
        const info = await loadMapInfo(scope, officeId, office.mapVersion);

        const record = store.join({
          socketId: socket.id,
          orgId: scope.orgId,
          officeId,
          userId: scope.userId,
          displayName: socket.data.displayName,
          avatarKey: "green",
          position: info.spawn,
          facing: "down",
          now: now(),
        });

        socket.data.officeId = officeId;
        versionBySocket.set(socket.id, office.mapVersion);
        await socket.join(roomFor(scope.orgId, officeId));

        socket.emit(SERVER_EVENT.SNAPSHOT, {
          officeId,
          selfUserId: scope.userId,
          players: store.listOffice(scope.orgId, officeId).map(toPlayerState),
          zones,
          serverTime: now(),
        });

        socket
          .to(roomFor(scope.orgId, officeId))
          .emit(SERVER_EVENT.PLAYER_JOINED, { player: toPlayerState(record) });
      })();
    });

    socket.on(CLIENT_EVENT.MOVE, (raw) => {
      // Dropped silently rather than answered: replying to a flood is itself
      // work, and an honest client never reaches this.
      if (!withinBudget(socket.id)) {
        increment("realtime.rate_limited");
        return;
      }

      const parsed = CLIENT_EVENT_SCHEMA[CLIENT_EVENT.MOVE].safeParse(raw);
      if (!parsed.success) return fail(socket, "invalid_payload");

      const record = store.get(socket.id);
      if (!record) return fail(socket, "forbidden");

      const t = now();
      const info = mapInfoFor(record);
      const check = validateMove(
        record.position,
        parsed.data.position,
        t - record.lastSeenAt,
        info?.bounds ?? { width: 4096, height: 4096 },
      );
      if (!check.ok) {
        // Do not disconnect: a legitimate client on a bad connection can
        // produce one of these. Ignore the update and let the client
        // reconcile against the next broadcast.
        increment(`realtime.move.rejected.${check.reason ?? "unknown"}`);
        return;
      }

      // How stale the client's view was. A rising p95 here is the first sign
      // of a struggling connection, before anyone reports "it feels laggy".
      observe("realtime.move.client_lag_ms", t - parsed.data.sentAt);

      store.move(socket.id, parsed.data.position, parsed.data.facing, t);
      markDirty(record);
      applyZone(record);
    });

    socket.on(CLIENT_EVENT.STOP, (raw) => {
      if (!withinBudget(socket.id)) return;

      const parsed = CLIENT_EVENT_SCHEMA[CLIENT_EVENT.STOP].safeParse(raw);
      if (!parsed.success) return fail(socket, "invalid_payload");

      const record = store.get(socket.id);
      if (!record) return;

      store.move(socket.id, parsed.data.position, parsed.data.facing, now());
      markDirty(record);
      applyZone(record);
    });

    socket.on(CLIENT_EVENT.HEARTBEAT, () => {
      if (!withinBudget(socket.id)) return;
      store.heartbeat(socket.id, now());
    });

    socket.on(CLIENT_EVENT.SET_PRESENCE, (raw) => {
      const parsed =
        CLIENT_EVENT_SCHEMA[CLIENT_EVENT.SET_PRESENCE].safeParse(raw);
      if (!parsed.success) return fail(socket, "invalid_payload");

      const record = store.setPresence(socket.id, parsed.data.status);
      if (!record) return;

      io.to(roomFor(record.orgId, record.officeId)).emit(
        SERVER_EVENT.PRESENCE_CHANGED,
        { userId: record.userId, presence: record.presence },
      );
    });

    socket.on(CLIENT_EVENT.SEND_MESSAGE, (raw) => {
      void (async () => {
        if (!withinBudget(socket.id)) {
          increment("realtime.rate_limited");
          return;
        }

        const parsed =
          CLIENT_EVENT_SCHEMA[CLIENT_EVENT.SEND_MESSAGE].safeParse(raw);
        if (!parsed.success) return fail(socket, "invalid_payload");

        const scope = scopeOf();
        const { channelId, parentId, body } = parsed.data;

        // Membership, not existence — a channel id is not a capability.
        if (!(await canReadChannel(db, scope, channelId))) {
          return fail(socket, "channel_not_found");
        }

        const message = await postMessage(db, scope, {
          channelId,
          parentId,
          body,
        });

        /*
         * Delivered to each member's personal room rather than broadcast to
         * the office. A private channel's members are not the same set as the
         * people standing in a room, and conflating them would leak a
         * conversation to whoever happened to be nearby.
         */
        for (const userId of await channelAudience(db, scope, channelId)) {
          io.to(personalRoom(scope.orgId, userId)).emit(
            SERVER_EVENT.MESSAGE_POSTED,
            { message },
          );
        }

        increment("chat.messages.posted");
      })();
    });

    socket.on(CLIENT_EVENT.MARK_READ, (raw) => {
      void (async () => {
        if (!withinBudget(socket.id)) return;

        const parsed =
          CLIENT_EVENT_SCHEMA[CLIENT_EVENT.MARK_READ].safeParse(raw);
        if (!parsed.success) return fail(socket, "invalid_payload");

        await markRead(db, scopeOf(), parsed.data.channelId);
      })();
    });

    socket.on("disconnect", (reason) => {
      increment("realtime.connections.closed");
      increment(`realtime.disconnect.${reason.replace(/\s+/g, "_")}`);
      budgets.delete(socket.id);
      versionBySocket.delete(socket.id);
      const record = store.leave(socket.id);
      if (record) announceLeft(record);
    });
  });

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  function fail(
    socket: { emit: Io["emit"] },
    code: Parameters<ServerToClientEvents["server:error"]>[0]["code"],
  ) {
    socket.emit(SERVER_EVENT.ERROR, { code, message: errorMessage(code) });
  }

  async function loadZones(
    scope: Scope,
    officeId: OfficeId,
    mapVersion: number,
  ): Promise<Zone[]> {
    const key = officeVersionKey(scope.orgId, officeId, mapVersion);
    const cached = zoneCache.get(key);
    if (cached) return cached;

    const rows = await listZones(db, scope, officeId);
    const zones: Zone[] = rows.map((z) => ({
      id: z.id as ZoneId,
      name: z.name,
      kind: z.kind,
      bounds: z.bounds,
      capacity: z.capacity,
    }));
    zoneCache.set(key, zones);
    return zones;
  }

  async function loadMapInfo(
    scope: Scope,
    officeId: OfficeId,
    mapVersion: number,
  ): Promise<MapInfo> {
    const key = officeVersionKey(scope.orgId, officeId, mapVersion);
    const cached = mapCache.get(key);
    if (cached) return cached;

    const row = await getOfficeMap(db, scope, officeId);
    const info = readMapInfo(row?.data);
    mapCache.set(key, info);
    return info;
  }

  /** Recomputes which zone a player stands in and announces a change. */
  function applyZone(record: PlayerRecord) {
    const zones = zonesFor(record) ?? [];
    const found = zones.find((z) => containsPoint(z.bounds, record.position));
    const nextZone = found?.id ?? null;
    if (nextZone === record.zoneId) return;

    if (found && found.capacity !== null) {
      const occupants = store
        .listOffice(record.orgId, record.officeId)
        .filter((p) => p.zoneId === found.id).length;
      if (occupants >= found.capacity) {
        io.sockets.sockets.get(record.socketId)?.emit(SERVER_EVENT.ERROR, {
          code: "zone_full",
          message: `${found.name} is full.`,
        });
        return;
      }
    }

    const updated = store.setZone(record.socketId, nextZone);
    if (!updated) return;

    const room = roomFor(record.orgId, record.officeId);
    io.to(room).emit(SERVER_EVENT.ZONE_CHANGED, {
      userId: updated.userId,
      zoneId: updated.zoneId,
    });
    io.to(room).emit(SERVER_EVENT.PRESENCE_CHANGED, {
      userId: updated.userId,
      presence: updated.presence,
    });
  }

  /*
   * A connected player's office is pinned to the version they joined at, so
   * these lookups do not need the version threaded through every call site.
   */
  const versionBySocket = new Map<string, number>();

  function zonesFor(record: PlayerRecord): Zone[] | undefined {
    const v = versionBySocket.get(record.socketId);
    if (v === undefined) return undefined;
    return zoneCache.get(officeVersionKey(record.orgId, record.officeId, v));
  }

  function mapInfoFor(record: PlayerRecord): MapInfo | undefined {
    const v = versionBySocket.get(record.socketId);
    if (v === undefined) return undefined;
    return mapCache.get(officeVersionKey(record.orgId, record.officeId, v));
  }

  function markDirty(record: PlayerRecord) {
    const key = roomFor(record.orgId, record.officeId);
    let set = dirty.get(key);
    if (!set) {
      set = new Set();
      dirty.set(key, set);
    }
    set.add(record.socketId);
  }

  function removeAndAnnounce(record: PlayerRecord) {
    store.leave(record.socketId);
    announceLeft(record);
  }

  function announceLeft(record: PlayerRecord) {
    io.to(roomFor(record.orgId, record.officeId)).emit(
      SERVER_EVENT.PLAYER_LEFT,
      { userId: record.userId },
    );
  }

  /* ------------------------------------------------------------------ */
  /* ticks                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Movement is broadcast on a fixed tick, not per event.
   *
   * Ten people moving at 60fps would otherwise be 600 broadcasts a second to
   * every client. Batching to MOVEMENT_BROADCAST_HZ makes the traffic a
   * function of the tick rate rather than of how fast anyone's browser runs.
   */
  const flush = setInterval(() => {
    for (const [room, sockets] of dirty) {
      for (const socketId of sockets) {
        const record = store.get(socketId);
        if (!record) continue;
        io.to(room).emit(SERVER_EVENT.PLAYER_MOVED, {
          userId: record.userId,
          position: record.position,
          facing: record.facing,
        });
      }
      sockets.clear();
    }
    dirty.clear();
  }, 1000 / REALTIME.MOVEMENT_BROADCAST_HZ);

  /** Drops connections whose heartbeat stopped, and ages idle people to away. */
  const sweep = setInterval(() => {
    const t = now();

    for (const record of store.sweepStale(t, REALTIME.HEARTBEAT_TIMEOUT_MS)) {
      increment("realtime.swept_stale");
      log.warn("connection swept for missed heartbeats", {
        socketId: record.socketId,
        officeId: record.officeId,
      });
      io.sockets.sockets.get(record.socketId)?.disconnect(true);
      announceLeft(record);
    }

    for (const record of connectedRecords()) {
      // Only "online" ages to "away". A deliberate focus state and an active
      // meeting both survive going idle.
      if (record.presence !== "online") continue;
      if (t - record.lastInputAt <= REALTIME.AWAY_AFTER_MS) continue;

      const updated = store.setPresence(record.socketId, "away");
      if (!updated) continue;

      io.to(roomFor(updated.orgId, updated.officeId)).emit(
        SERVER_EVENT.PRESENCE_CHANGED,
        { userId: updated.userId, presence: "away" },
      );
    }
  }, REALTIME.HEARTBEAT_INTERVAL_MS);

  function connectedRecords(): PlayerRecord[] {
    const out: PlayerRecord[] = [];
    for (const socket of io.sockets.sockets.values()) {
      const record = store.get(socket.id);
      if (record) out.push(record);
    }
    return out;
  }

  flush.unref();
  sweep.unref();

  return {
    io,
    /**
     * Stops ticking, disconnects everyone, then closes.
     *
     * Sockets are disconnected explicitly first: `io.close()` on its own waits
     * for open connections to end by themselves, which on a realtime server
     * means it waits forever. Clients reconnect and resync from a snapshot, so
     * cutting them is the correct behaviour, not a compromise.
     */
    async close() {
      clearInterval(flush);
      clearInterval(sweep);
      io.disconnectSockets(true);
      await io.close();
    },
  };
}

function errorMessage(code: string): string {
  switch (code) {
    case "invalid_payload":
      return "That request was not understood.";
    case "office_not_found":
      return "That office does not exist.";
    case "forbidden":
      return "You do not have access to that.";
    case "zone_full":
      return "That room is full.";
    default:
      return "Something went wrong.";
  }
}
