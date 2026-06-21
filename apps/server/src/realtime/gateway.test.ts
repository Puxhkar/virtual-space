import { createServer, type Server as HttpServer } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { eq } from "drizzle-orm";
import {
  CLIENT_EVENT,
  SERVER_EVENT,
  type SnapshotPayload,
  type PlayerJoinedPayload,
  type PlayerMovedPayload,
  type RealtimeErrorPayload,
  type ZoneChangedPayload,
  type OfficeId,
} from "@vo/shared";
import { createApp } from "../app.js";
import { db, closeDatabase } from "../db/client.js";
import { maps, member, offices, officeMembers, zones } from "../db/schema.js";
import { setupTestDatabase, truncateAll } from "../test/db.js";
import { resetRateLimits } from "../http/rateLimit.js";
import { MemoryPresenceStore } from "./PresenceStore.js";
import { attachRealtime } from "./gateway.js";

/**
 * Gateway tests over real sockets.
 *
 * A mocked socket would let a broken handshake pass, and the handshake is
 * where the tenant boundary is enforced. These connect for real.
 */

const app = createApp();
const store = new MemoryPresenceStore();

/** 640x480 map, spawn at tile (6,6), Standup zone at 200,200 -> 300,300. */
const TEST_MAP = {
  width: 40,
  height: 30,
  tilewidth: 16,
  tileheight: 16,
  layers: [
    {
      name: "objects",
      type: "objectgroup",
      objects: [{ name: "spawn", type: "spawn", x: 96, y: 96 }],
    },
  ],
};

/**
 * Walks a socket toward a point in steps the server will accept.
 *
 * The server rejects implausible speed, so a test cannot teleport. Stepping
 * is also what a real client does, which makes this the honest path.
 */
async function walk(
  socket: Socket,
  target: { x: number; y: number },
  from: { x: number; y: number },
) {
  let { x, y } = from;
  const STEP = 12;

  for (let i = 0; i < 200; i++) {
    const dx = target.x - x;
    const dy = target.y - y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) break;

    x += Math.max(-STEP, Math.min(STEP, dx));
    y += Math.max(-STEP, Math.min(STEP, dy));

    socket.emit(CLIENT_EVENT.MOVE, {
      position: { x, y },
      facing: "down",
      sentAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 60));
  }
}

let httpServer: HttpServer;
let realtime: ReturnType<typeof attachRealtime>;
let port: number;

const clients: Socket[] = [];

function client(cookie?: string): Socket {
  const socket = connect(`http://localhost:${port}`, {
    transports: ["websocket"],
    extraHeaders: cookie ? { cookie } : {},
    reconnection: false,
  });
  clients.push(socket);
  return socket;
}

/** Resolves on the next occurrence of an event, or rejects on timeout. */
function once<T>(socket: Socket, event: string, ms = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      ms,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const call = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

async function signUp(email: string): Promise<string> {
  const res = await call("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: "a-sufficiently-long-password",
      name: email.split("@")[0],
    }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${await res.text()}`);
  return res.headers.getSetCookie().join("; ");
}

async function makeTenant(label: string) {
  const cookie = await signUp(`${label}@example.test`);

  const created = await call("/api/auth/organization/create", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: label, slug: label }),
  });
  const { id: orgId } = (await created.json()) as { id: string };

  await call("/api/auth/organization/set-active", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ organizationId: orgId }),
  });

  const [row] = await db
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, orgId));
  const userId = row!.userId;

  const mapId = crypto.randomUUID();
  const officeId = crypto.randomUUID() as OfficeId;
  await db.insert(maps).values({
    id: mapId,
    orgId,
    name: "m",
    version: 1,
    data: TEST_MAP,
    tileSize: 16,
  });
  await db
    .insert(offices)
    .values({ id: officeId, orgId, name: "o", mapId, mapVersion: 1 });
  await db.insert(zones).values({
    id: crypto.randomUUID(),
    orgId,
    officeId,
    name: "Standup",
    kind: "meeting",
    bounds: { x: 200, y: 200, width: 100, height: 100 },
    capacity: null,
  });
  await db.insert(officeMembers).values({ officeId, userId, orgId });

  return { cookie, userId, orgId, officeId };
}

/** A second person inside an existing organization. */
async function addTeammate(label: string, orgId: string, officeId: OfficeId) {
  const cookie = await signUp(`${label}@example.test`);
  const meRes = await call("/api/me", { headers: { cookie } });
  const me = (await meRes.json()) as { user: { id: string } };

  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: me.user.id,
    role: "member",
    createdAt: new Date(),
  });
  await db
    .insert(officeMembers)
    .values({ officeId, userId: me.user.id, orgId });

  await call("/api/auth/organization/set-active", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ organizationId: orgId }),
  });

  return { cookie, userId: me.user.id };
}

beforeAll(async () => {
  await setupTestDatabase();
  httpServer = createServer();
  realtime = attachRealtime(httpServer, { store });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  port = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  await realtime.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await closeDatabase();
});

let alpha: Awaited<ReturnType<typeof makeTenant>>;
let bravo: Awaited<ReturnType<typeof makeTenant>>;

beforeEach(async () => {
  // Limits are process-global by design; each test starts with a fresh
  // budget so one suite cannot exhaust another's.
  resetRateLimits();
  store.clear();
  await truncateAll(db);
  alpha = await makeTenant("alpha");
  bravo = await makeTenant("bravo");
});

afterEach(() => {
  for (const socket of clients.splice(0)) socket.disconnect();
});

describe("handshake", () => {
  it("refuses a connection with no session", async () => {
    const socket = client();
    const err = await once<Error>(socket, "connect_error");
    expect(err.message).toBe("unauthenticated");
  });

  it("refuses a forged cookie", async () => {
    const socket = client("better-auth.session_token=nonsense");
    const err = await once<Error>(socket, "connect_error");
    expect(err.message).toBe("unauthenticated");
  });

  it("accepts a real session", async () => {
    const socket = client(alpha.cookie);
    await once(socket, "connect");
    expect(socket.connected).toBe(true);
  });

  it("drops the socket when membership is revoked", async () => {
    await db.delete(member).where(eq(member.userId, alpha.userId));

    const socket = client(alpha.cookie);
    const err = await once<Error>(socket, "connect_error");
    expect(err.message).toBe("forbidden");
  });
});

describe("joining an office", () => {
  it("receives a snapshot containing itself and the zones", async () => {
    const socket = client(alpha.cookie);
    await once(socket, "connect");
    socket.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });

    const snap = await once<SnapshotPayload>(socket, SERVER_EVENT.SNAPSHOT);
    expect(snap.officeId).toBe(alpha.officeId);
    expect(snap.selfUserId).toBe(alpha.userId);
    expect(snap.players).toHaveLength(1);
    expect(snap.zones).toHaveLength(1);
    expect(snap.zones[0]?.name).toBe("Standup");
  });

  it("cannot join another organization's office", async () => {
    // The id is valid and known. Only membership decides.
    const socket = client(alpha.cookie);
    await once(socket, "connect");
    socket.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: bravo.officeId });

    const err = await once<RealtimeErrorPayload>(socket, SERVER_EVENT.ERROR);
    expect(err.code).toBe("office_not_found");
  });

  it("rejects a malformed payload", async () => {
    const socket = client(alpha.cookie);
    await once(socket, "connect");
    socket.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: "not-a-uuid" } as never);

    const err = await once<RealtimeErrorPayload>(socket, SERVER_EVENT.ERROR);
    expect(err.code).toBe("invalid_payload");
  });
});

describe("two people in one office", () => {
  it("the first is told when the second arrives", async () => {
    const mate = await addTeammate("carol", alpha.orgId, alpha.officeId);

    const first = client(alpha.cookie);
    await once(first, "connect");
    first.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });
    await once(first, SERVER_EVENT.SNAPSHOT);

    const second = client(mate.cookie);
    await once(second, "connect");
    const joined = once<PlayerJoinedPayload>(first, SERVER_EVENT.PLAYER_JOINED);
    second.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });

    expect((await joined).player.userId).toBe(mate.userId);
  });

  it("movement reaches the other person", async () => {
    const mate = await addTeammate("dave", alpha.orgId, alpha.officeId);

    const first = client(alpha.cookie);
    await once(first, "connect");
    first.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });
    await once(first, SERVER_EVENT.SNAPSHOT);

    const second = client(mate.cookie);
    await once(second, "connect");
    second.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });
    await once(second, SERVER_EVENT.SNAPSHOT);

    const moved = once<PlayerMovedPayload>(first, SERVER_EVENT.PLAYER_MOVED);
    // One plausible step from the spawn at (104, 104).
    second.emit(CLIENT_EVENT.MOVE, {
      position: { x: 116, y: 104 },
      facing: "right",
      sentAt: Date.now(),
    });

    const payload = await moved;
    expect(payload.userId).toBe(mate.userId);
    expect(payload.position).toEqual({ x: 116, y: 104 });
  });

  it("a departure is announced", async () => {
    const mate = await addTeammate("erin", alpha.orgId, alpha.officeId);

    const first = client(alpha.cookie);
    await once(first, "connect");
    first.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });
    await once(first, SERVER_EVENT.SNAPSHOT);

    const second = client(mate.cookie);
    await once(second, "connect");
    second.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });
    await once(second, SERVER_EVENT.SNAPSHOT);

    const left = once<{ userId: string }>(first, SERVER_EVENT.PLAYER_LEFT);
    second.disconnect();
    expect((await left).userId).toBe(mate.userId);
  });
});

describe("zones", () => {
  it("walking into a zone is broadcast", async () => {
    const socket = client(alpha.cookie);
    await once(socket, "connect");
    socket.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });
    await once(socket, SERVER_EVENT.SNAPSHOT);

    const changed = once<ZoneChangedPayload>(socket, SERVER_EVENT.ZONE_CHANGED);
    // The Standup zone covers 200,200 -> 300,300. Spawn is at 104,104.
    await walk(socket, { x: 250, y: 250 }, { x: 104, y: 104 });

    expect((await changed).zoneId).not.toBeNull();
  });
});

describe("movement validation over the wire", () => {
  it("a teleport is ignored rather than trusted", async () => {
    const socket = client(alpha.cookie);
    await once(socket, "connect");
    socket.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });
    const snap = await once<SnapshotPayload>(socket, SERVER_EVENT.SNAPSHOT);
    const start = snap.players[0]!.position;

    socket.emit(CLIENT_EVENT.MOVE, {
      position: { x: 600, y: 450 },
      facing: "down",
      sentAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 300));

    // Position is unchanged: the server kept its own view rather than
    // accepting a jump no honest client could produce.
    const record = store.listOffice(alpha.orgId as never, alpha.officeId)[0];
    expect(record?.position).toEqual(start);
  });

  it("spawn comes from the map, not a hardcoded origin", async () => {
    const socket = client(alpha.cookie);
    await once(socket, "connect");
    socket.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });

    const snap = await once<SnapshotPayload>(socket, SERVER_EVENT.SNAPSHOT);
    // Tile (6,6) at 16px, centred.
    expect(snap.players[0]?.position).toEqual({ x: 104, y: 104 });
  });
});

describe("duplicate connections", () => {
  it("a second tab evicts the first", async () => {
    const first = client(alpha.cookie);
    await once(first, "connect");
    first.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });
    await once(first, SERVER_EVENT.SNAPSHOT);

    const second = client(alpha.cookie);
    await once(second, "connect");

    const disconnected = once(first, "disconnect");
    second.emit(CLIENT_EVENT.JOIN_OFFICE, { officeId: alpha.officeId });
    await once(second, SERVER_EVENT.SNAPSHOT);

    await disconnected;
    expect(first.connected).toBe(false);
    // Exactly one avatar, not two of the same person.
    expect(store.listOffice(alpha.orgId as never, alpha.officeId)).toHaveLength(
      1,
    );
  });
});
