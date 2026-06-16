import type {
  Facing,
  OfficeId,
  OrgId,
  PresenceStatus,
  UserId,
  Vec2,
  ZoneId,
} from "@vo/shared";

/**
 * Transient multiplayer state.
 *
 * Positions, sockets, heartbeats and presence live here and never touch
 * Postgres (CLAUDE.md §16). One Node process with ten users does not need a
 * second datastore, so the only implementation today keeps everything in a
 * Map — but nothing outside this interface knows that, so Redis arrives later
 * as a second implementation rather than a refactor (decision 004).
 *
 * State is lost on restart, by design. Clients resync from a snapshot on
 * reconnect.
 */

export interface PlayerRecord {
  socketId: string;
  orgId: OrgId;
  officeId: OfficeId;
  userId: UserId;
  displayName: string;
  avatarKey: string;
  position: Vec2;
  facing: Facing;
  presence: PresenceStatus;
  zoneId: ZoneId | null;
  /** Epoch ms of the last heartbeat or movement. */
  lastSeenAt: number;
  /** Epoch ms of the last real input, used to decide "away". */
  lastInputAt: number;
}

export interface JoinInput {
  socketId: string;
  orgId: OrgId;
  officeId: OfficeId;
  userId: UserId;
  displayName: string;
  avatarKey: string;
  position: Vec2;
  facing: Facing;
  now: number;
}

export interface PresenceStore {
  join(input: JoinInput): PlayerRecord;
  leave(socketId: string): PlayerRecord | undefined;

  get(socketId: string): PlayerRecord | undefined;
  /** Everyone currently in one office. */
  listOffice(orgId: OrgId, officeId: OfficeId): PlayerRecord[];
  /** Other sockets held by the same person, for duplicate-login eviction. */
  findOtherSockets(
    orgId: OrgId,
    userId: UserId,
    exceptSocketId: string,
  ): PlayerRecord[];

  move(
    socketId: string,
    position: Vec2,
    facing: Facing,
    now: number,
  ): PlayerRecord | undefined;
  heartbeat(socketId: string, now: number): void;
  setPresence(
    socketId: string,
    presence: PresenceStatus,
  ): PlayerRecord | undefined;
  setZone(socketId: string, zoneId: ZoneId | null): PlayerRecord | undefined;

  /** Records whose heartbeat expired. Removes and returns them. */
  sweepStale(now: number, timeoutMs: number): PlayerRecord[];

  size(): number;
  clear(): void;
}

/** Namespaced even in memory, so the Redis key layout is already decided. */
function officeKey(orgId: OrgId, officeId: OfficeId): string {
  return `org:${orgId}:office:${officeId}`;
}

export class MemoryPresenceStore implements PresenceStore {
  private readonly bySocket = new Map<string, PlayerRecord>();
  /** office key -> socket ids, so listing an office is not a full scan. */
  private readonly byOffice = new Map<string, Set<string>>();

  join(input: JoinInput): PlayerRecord {
    const record: PlayerRecord = {
      socketId: input.socketId,
      orgId: input.orgId,
      officeId: input.officeId,
      userId: input.userId,
      displayName: input.displayName,
      avatarKey: input.avatarKey,
      position: input.position,
      facing: input.facing,
      presence: "online",
      zoneId: null,
      lastSeenAt: input.now,
      lastInputAt: input.now,
    };

    this.bySocket.set(record.socketId, record);

    const key = officeKey(record.orgId, record.officeId);
    let sockets = this.byOffice.get(key);
    if (!sockets) {
      sockets = new Set();
      this.byOffice.set(key, sockets);
    }
    sockets.add(record.socketId);

    return record;
  }

  leave(socketId: string): PlayerRecord | undefined {
    const record = this.bySocket.get(socketId);
    if (!record) return undefined;

    this.bySocket.delete(socketId);

    const key = officeKey(record.orgId, record.officeId);
    const sockets = this.byOffice.get(key);
    sockets?.delete(socketId);
    // Drop empty offices so the index does not grow without bound.
    if (sockets && sockets.size === 0) this.byOffice.delete(key);

    return record;
  }

  get(socketId: string): PlayerRecord | undefined {
    return this.bySocket.get(socketId);
  }

  listOffice(orgId: OrgId, officeId: OfficeId): PlayerRecord[] {
    const sockets = this.byOffice.get(officeKey(orgId, officeId));
    if (!sockets) return [];

    const out: PlayerRecord[] = [];
    for (const id of sockets) {
      const record = this.bySocket.get(id);
      if (record) out.push(record);
    }
    return out;
  }

  findOtherSockets(
    orgId: OrgId,
    userId: UserId,
    exceptSocketId: string,
  ): PlayerRecord[] {
    const out: PlayerRecord[] = [];
    for (const record of this.bySocket.values()) {
      if (
        record.userId === userId &&
        record.orgId === orgId &&
        record.socketId !== exceptSocketId
      ) {
        out.push(record);
      }
    }
    return out;
  }

  move(
    socketId: string,
    position: Vec2,
    facing: Facing,
    now: number,
  ): PlayerRecord | undefined {
    const record = this.bySocket.get(socketId);
    if (!record) return undefined;

    record.position = position;
    record.facing = facing;
    record.lastSeenAt = now;
    record.lastInputAt = now;
    // Moving cancels "away" but never overrides a deliberate focus state.
    if (record.presence === "away") record.presence = "online";
    return record;
  }

  heartbeat(socketId: string, now: number): void {
    const record = this.bySocket.get(socketId);
    // A heartbeat proves the connection is alive but not that the person is,
    // so it does not touch lastInputAt.
    if (record) record.lastSeenAt = now;
  }

  setPresence(
    socketId: string,
    presence: PresenceStatus,
  ): PlayerRecord | undefined {
    const record = this.bySocket.get(socketId);
    if (!record) return undefined;
    record.presence = presence;
    return record;
  }

  setZone(socketId: string, zoneId: ZoneId | null): PlayerRecord | undefined {
    const record = this.bySocket.get(socketId);
    if (!record) return undefined;
    record.zoneId = zoneId;
    record.presence = zoneId ? "in_meeting" : "online";
    return record;
  }

  sweepStale(now: number, timeoutMs: number): PlayerRecord[] {
    const expired: PlayerRecord[] = [];
    for (const record of this.bySocket.values()) {
      if (now - record.lastSeenAt > timeoutMs) expired.push(record);
    }
    for (const record of expired) this.leave(record.socketId);
    return expired;
  }

  size(): number {
    return this.bySocket.size;
  }

  clear(): void {
    this.bySocket.clear();
    this.byOffice.clear();
  }
}
