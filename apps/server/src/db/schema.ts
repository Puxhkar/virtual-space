import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema.js";
import type { Rect } from "@vo/shared";

export * from "./auth-schema.js";

/**
 * Our domain tables.
 *
 * Organizations, members and invitations are NOT here — they belong to Better
 * Auth's organization plugin (decision 007). Everything below references
 * `organization.id` rather than defining a parallel tenant table.
 *
 * Every table carries org_id, including where it could be reached by a join.
 * The denormalization is deliberate: it lets every query filter on the tenant
 * boundary directly instead of trusting a join to be written correctly
 * (CLAUDE.md §13).
 */

export const zoneKind = pgEnum("zone_kind", [
  "meeting",
  "booth",
  "desk",
  "quiet",
]);

/** A map is Tiled JSON plus the tile size the art pack uses. */
export const maps = pgTable(
  "maps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** null for built-in templates available to every organization. */
    orgId: uuid("org_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    /** Tiled export: layers, tilesets, collision, object groups. */
    data: jsonb("data").notNull(),
    /** 16 for the Kenney CC0 pack, 32 for a later paid pack (decision 006). */
    tileSize: integer("tile_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("maps_org_idx").on(t.orgId)],
);

export const offices = pgTable(
  "offices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mapId: uuid("map_id")
      .notNull()
      .references(() => maps.id, { onDelete: "restrict" }),
    /** Pinned so editing a map does not silently change a live office. */
    mapVersion: integer("map_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("offices_org_idx").on(t.orgId)],
);

/**
 * Extracted from the map's object layer on import, so authorizing a zone entry
 * never requires parsing map JSON inside a realtime event (CLAUDE.md §16).
 */
export const zones = pgTable(
  "zones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: zoneKind("kind").notNull(),
    /** `{ x, y, width, height }` in world pixels. */
    bounds: jsonb("bounds").$type<Rect>().notNull(),
    /** null means unlimited. Enforced server-side on enter. */
    capacity: integer("capacity"),
  },
  (t) => [
    index("zones_office_idx").on(t.officeId),
    index("zones_org_idx").on(t.orgId),
  ],
);

/**
 * Who may enter which office. Separate from Better Auth's `member` because org
 * membership does not imply access to every office once there is more than one.
 */
export const officeMembers = pgTable(
  "office_members",
  {
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.officeId, t.userId] }),
    index("office_members_user_idx").on(t.userId),
    index("office_members_org_idx").on(t.orgId),
  ],
);

/** Ours — Better Auth writes no audit trail (decision 005). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** null for system actions. */
    actorId: uuid("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Dotted action name, e.g. `member.role_changed`. */
    action: text("action").notNull(),
    target: text("target"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("audit_log_org_created_idx").on(t.orgId, t.createdAt.desc())],
);

/* ------------------------------------------------------------------ */
/* Chat (phase 17)                                                     */
/* ------------------------------------------------------------------ */

/**
 * Async chat.
 *
 * The office is empty at three in the morning; chat is what makes it worth
 * opening anyway. It is the only part of Track B that changes daily behaviour
 * on its own, which is why it comes first.
 */

export const channelKind = pgEnum("channel_kind", [
  /** Open to every member of the organization. */
  "public",
  /** Explicit membership. */
  "private",
  /** Exactly two people. */
  "direct",
]);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: channelKind("kind").notNull(),
    /** Null for direct messages, which are named by their participants. */
    name: text("name"),
    topic: text("topic"),
    /** Set when a channel belongs to a room, e.g. the standup's own thread. */
    zoneId: uuid("zone_id").references(() => zones.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("channels_org_idx").on(t.orgId),
    index("channels_zone_idx").on(t.zoneId),
  ],
);

export const channelMembers = pgTable(
  "channel_members",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Last message this person has seen, for unread counts. */
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    index("channel_members_user_idx").on(t.userId),
    index("channel_members_org_idx").on(t.orgId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Null for a top-level message; set for a threaded reply. */
    parentId: uuid("parent_id"),
    /**
     * Kept when the author is deleted, because removing a person should not
     * silently rewrite a conversation other people took part in.
     */
    authorId: uuid("author_id").references(() => user.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    /** Soft delete: the row stays so replies keep their context. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The only query that matters at scale: a page of one channel's history,
    // newest first.
    index("messages_channel_created_idx").on(t.channelId, t.createdAt.desc()),
    index("messages_org_idx").on(t.orgId),
    index("messages_parent_idx").on(t.parentId),
  ],
);
