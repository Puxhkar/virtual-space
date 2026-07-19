import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { ChannelId, OrgId, UserId } from "@vo/shared";
import { db, closeDatabase } from "./client.js";
import {
  channelMembers,
  channels,
  messages,
  organization,
  user,
} from "./schema.js";
import { setupTestDatabase, truncateAll } from "../test/db.js";
import {
  canReadChannel,
  channelAudience,
  listChannels,
  listMessages,
  markRead,
  postMessage,
} from "./chat.js";
import type { Scope } from "../scope.js";

/**
 * Chat isolation and history.
 *
 * The interesting cases are the ones where a channel id is known but access is
 * not — the same non-disclosure rule as offices.
 */

const uuid = () => crypto.randomUUID();

interface Tenant {
  orgId: OrgId;
  userId: UserId;
  channelId: ChannelId;
  scope: Scope;
}

async function seedTenant(label: string): Promise<Tenant> {
  const orgId = uuid();
  const userId = uuid();
  const channelId = uuid();
  const now = new Date();

  await db
    .insert(organization)
    .values({ id: orgId, name: label, slug: label, createdAt: now });
  await db.insert(user).values({
    id: userId,
    name: `${label} person`,
    email: `${label}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(channels).values({
    id: channelId,
    orgId,
    kind: "public",
    name: "general",
  });
  await db.insert(channelMembers).values({ channelId, userId, orgId });

  return {
    orgId: orgId as OrgId,
    userId: userId as UserId,
    channelId: channelId as ChannelId,
    scope: { orgId: orgId as OrgId, userId: userId as UserId, role: "member" },
  };
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  await setupTestDatabase();
});
afterAll(async () => {
  await closeDatabase();
});
beforeEach(async () => {
  await truncateAll(db);
  a = await seedTenant("alpha");
  b = await seedTenant("bravo");
});

describe("access", () => {
  it("a member can read their own channel", async () => {
    expect(await canReadChannel(db, a.scope, a.channelId)).toBe(true);
  });

  it("another organization's channel is not readable", async () => {
    // The id is valid and known. Membership is the only control.
    expect(await canReadChannel(db, a.scope, b.channelId)).toBe(false);
  });

  it("a non-member in the same org cannot read a channel", async () => {
    const outsiderId = uuid();
    await db.insert(user).values({
      id: outsiderId,
      name: "outsider",
      email: "outsider@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const outsider: Scope = {
      orgId: a.orgId,
      userId: outsiderId as UserId,
      role: "member",
    };
    expect(await canReadChannel(db, outsider, a.channelId)).toBe(false);
  });

  it("listing channels never shows another org's", async () => {
    const list = await listChannels(db, a.scope);
    expect(list.map((c) => c.id)).toEqual([a.channelId]);
  });
});

describe("messages", () => {
  it("a posted message comes back in history", async () => {
    await postMessage(db, a.scope, {
      channelId: a.channelId,
      parentId: null,
      body: "hello",
    });

    const history = await listMessages(db, a.scope, a.channelId);
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("hello");
    expect(history[0]?.authorName).toBe("alpha person");
  });

  it("history is newest first", async () => {
    for (const body of ["first", "second", "third"]) {
      await postMessage(db, a.scope, {
        channelId: a.channelId,
        parentId: null,
        body,
      });
    }
    const history = await listMessages(db, a.scope, a.channelId);
    expect(history.map((m) => m.body)).toEqual(["third", "second", "first"]);
  });

  it("another org cannot read messages even with the channel id", async () => {
    await postMessage(db, b.scope, {
      channelId: b.channelId,
      parentId: null,
      body: "private to bravo",
    });

    const leaked = await listMessages(db, a.scope, b.channelId);
    expect(leaked).toEqual([]);
  });

  it("paging with a cursor does not repeat or skip", async () => {
    for (let i = 0; i < 5; i++) {
      await postMessage(db, a.scope, {
        channelId: a.channelId,
        parentId: null,
        body: `m${i}`,
      });
    }

    const first = await listMessages(db, a.scope, a.channelId, { limit: 2 });
    const second = await listMessages(db, a.scope, a.channelId, {
      limit: 2,
      before: new Date(first.at(-1)!.createdAt),
    });

    const ids = [...first, ...second].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a reply keeps its parent", async () => {
    const parent = await postMessage(db, a.scope, {
      channelId: a.channelId,
      parentId: null,
      body: "question",
    });
    const reply = await postMessage(db, a.scope, {
      channelId: a.channelId,
      parentId: parent.id,
      body: "answer",
    });

    expect(reply.parentId).toBe(parent.id);
  });

  it("a deleted author leaves the message behind", async () => {
    // Removing a person must not silently rewrite a conversation other people
    // took part in.
    await postMessage(db, a.scope, {
      channelId: a.channelId,
      parentId: null,
      body: "still here",
    });
    await db.delete(user).where(eq(user.id, a.userId));

    const history = await listMessages(db, a.scope, a.channelId);
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("still here");
    expect(history[0]?.authorId).toBeNull();
    expect(history[0]?.authorName).toBe("Former member");
  });

  it("a soft-deleted message keeps its row but loses its text", async () => {
    const posted = await postMessage(db, a.scope, {
      channelId: a.channelId,
      parentId: null,
      body: "regrettable",
    });
    await db
      .update(messages)
      .set({ deletedAt: new Date() })
      .where(eq(messages.id, posted.id as string));

    const history = await listMessages(db, a.scope, a.channelId);
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("");
    expect(history[0]?.deletedAt).not.toBeNull();
  });
});

describe("unread", () => {
  it("counts other people's messages, not your own", async () => {
    await postMessage(db, a.scope, {
      channelId: a.channelId,
      parentId: null,
      body: "mine",
    });

    const [own] = await listChannels(db, a.scope);
    expect(own?.unread).toBe(0);
  });

  it("counts a teammate's messages", async () => {
    const mateId = uuid();
    await db.insert(user).values({
      id: mateId,
      name: "mate",
      email: "mate@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .insert(channelMembers)
      .values({ channelId: a.channelId, userId: mateId, orgId: a.orgId });

    const mate: Scope = {
      orgId: a.orgId,
      userId: mateId as UserId,
      role: "member",
    };
    await postMessage(db, mate, {
      channelId: a.channelId,
      parentId: null,
      body: "theirs",
    });

    const [channel] = await listChannels(db, a.scope);
    expect(channel?.unread).toBe(1);
  });

  it("marking read clears the count", async () => {
    const mateId = uuid();
    await db.insert(user).values({
      id: mateId,
      name: "mate",
      email: "mate2@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .insert(channelMembers)
      .values({ channelId: a.channelId, userId: mateId, orgId: a.orgId });

    await postMessage(
      db,
      { orgId: a.orgId, userId: mateId as UserId, role: "member" },
      { channelId: a.channelId, parentId: null, body: "unread" },
    );

    await markRead(db, a.scope, a.channelId);
    const [channel] = await listChannels(db, a.scope);
    expect(channel?.unread).toBe(0);
  });
});

describe("delivery audience", () => {
  it("is the channel's members, not the office", async () => {
    // A private channel's members are not the people standing nearby.
    const audience = await channelAudience(db, a.scope, a.channelId);
    expect(audience).toEqual([a.userId]);
  });

  it("does not reach across organizations", async () => {
    const audience = await channelAudience(db, a.scope, b.channelId);
    expect(audience).toEqual([]);
  });
});
