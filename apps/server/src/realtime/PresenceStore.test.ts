import { beforeEach, describe, expect, it } from "vitest";
import type { OfficeId, OrgId, UserId } from "@vo/shared";
import { MemoryPresenceStore, type JoinInput } from "./PresenceStore.js";

const ORG_A = "11111111-1111-4111-8111-111111111111" as OrgId;
const ORG_B = "22222222-2222-4222-8222-222222222222" as OrgId;
const OFFICE_A = "33333333-3333-4333-8333-333333333333" as OfficeId;
const OFFICE_B = "44444444-4444-4444-8444-444444444444" as OfficeId;

let store: MemoryPresenceStore;

const join = (over: Partial<JoinInput> = {}) =>
  store.join({
    socketId: "s1",
    orgId: ORG_A,
    officeId: OFFICE_A,
    userId: "55555555-5555-4555-8555-555555555555" as UserId,
    displayName: "Ada",
    avatarKey: "green",
    position: { x: 10, y: 10 },
    facing: "down",
    now: 1_000,
    ...over,
  });

beforeEach(() => {
  store = new MemoryPresenceStore();
});

describe("membership", () => {
  it("a joined player appears in their office", () => {
    join();
    expect(store.listOffice(ORG_A, OFFICE_A)).toHaveLength(1);
    expect(store.size()).toBe(1);
  });

  it("offices are isolated from each other", () => {
    join({ socketId: "s1", officeId: OFFICE_A });
    join({ socketId: "s2", officeId: OFFICE_B });

    expect(store.listOffice(ORG_A, OFFICE_A)).toHaveLength(1);
    expect(store.listOffice(ORG_A, OFFICE_B)).toHaveLength(1);
  });

  it("the same office id in a different org is a different office", () => {
    // Keys are namespaced by org even in memory, so a leaked office id from
    // another tenant resolves to nothing rather than to someone else's room.
    join({ socketId: "s1", orgId: ORG_A, officeId: OFFICE_A });
    expect(store.listOffice(ORG_B, OFFICE_A)).toHaveLength(0);
  });

  it("leaving removes the player and returns their record", () => {
    join();
    const left = store.leave("s1");

    expect(left?.socketId).toBe("s1");
    expect(store.listOffice(ORG_A, OFFICE_A)).toHaveLength(0);
    expect(store.size()).toBe(0);
  });

  it("leaving an unknown socket is harmless", () => {
    expect(store.leave("nope")).toBeUndefined();
  });

  it("empty offices are dropped rather than accumulating", () => {
    join();
    store.leave("s1");
    // Re-listing must not resurrect a stale empty entry.
    expect(store.listOffice(ORG_A, OFFICE_A)).toEqual([]);
  });
});

describe("duplicate connections", () => {
  const USER = "66666666-6666-4666-8666-666666666666" as UserId;

  it("finds the same person's other sockets", () => {
    join({ socketId: "s1", userId: USER });
    join({ socketId: "s2", userId: USER });

    const others = store.findOtherSockets(ORG_A, USER, "s2");
    expect(others).toHaveLength(1);
    expect(others[0]?.socketId).toBe("s1");
  });

  it("duplicate eviction does not reach across organizations", () => {
    // Two workspaces are two places. Joining one must not disconnect the
    // person from the other, the way two Slack workspaces coexist.
    join({ socketId: "s1", userId: USER, orgId: ORG_A });
    join({ socketId: "s2", userId: USER, orgId: ORG_B });

    expect(store.findOtherSockets(ORG_B, USER, "s2")).toHaveLength(0);
    expect(store.findOtherSockets(ORG_A, USER, "s1")).toHaveLength(0);
  });
});

describe("movement and presence", () => {
  it("move updates position, facing and last seen", () => {
    join();
    const moved = store.move("s1", { x: 50, y: 60 }, "left", 2_000);

    expect(moved?.position).toEqual({ x: 50, y: 60 });
    expect(moved?.facing).toBe("left");
    expect(moved?.lastSeenAt).toBe(2_000);
    expect(moved?.lastInputAt).toBe(2_000);
  });

  it("moving brings an away player back online", () => {
    join();
    store.setPresence("s1", "away");
    expect(store.move("s1", { x: 1, y: 1 }, "up", 2_000)?.presence).toBe(
      "online",
    );
  });

  it("moving does not override a deliberate focus state", () => {
    // Focus suppresses proximity audio. Walking must not silently cancel it.
    join();
    store.setPresence("s1", "focus");
    expect(store.move("s1", { x: 1, y: 1 }, "up", 2_000)?.presence).toBe(
      "focus",
    );
  });

  it("a heartbeat proves the connection lives, not that the person does", () => {
    join();
    store.heartbeat("s1", 9_000);

    const record = store.get("s1");
    expect(record?.lastSeenAt).toBe(9_000);
    // Unchanged, so an idle tab still ages to away.
    expect(record?.lastInputAt).toBe(1_000);
  });

  it("entering a zone sets in_meeting, leaving restores online", () => {
    join();
    const zoneId = "77777777-7777-4777-8777-777777777777";

    expect(store.setZone("s1", zoneId as never)?.presence).toBe("in_meeting");
    expect(store.setZone("s1", null)?.presence).toBe("online");
  });
});

describe("stale sweeping", () => {
  it("removes connections past the heartbeat timeout", () => {
    join({ socketId: "s1", now: 1_000 });
    join({ socketId: "s2", now: 1_000 });
    store.heartbeat("s2", 30_000);

    const expired = store.sweepStale(35_000, 30_000);

    expect(expired.map((r) => r.socketId)).toEqual(["s1"]);
    expect(store.size()).toBe(1);
    expect(store.listOffice(ORG_A, OFFICE_A)).toHaveLength(1);
  });

  it("sweeps nothing when everyone is fresh", () => {
    join({ now: 1_000 });
    expect(store.sweepStale(2_000, 30_000)).toEqual([]);
  });
});
