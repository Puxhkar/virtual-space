# Data model

Implemented in phase 02. Migration: `apps/server/drizzle/0000_*.sql`.
Schema source: `apps/server/src/db/`.

PostgreSQL is the source of truth for everything here. Transient realtime state
(positions, sockets, heartbeats) is **not** in this document — it lives in the
in-memory `PresenceStore` (decision 004).

## Ownership split

Two groups of tables, and the distinction matters:

| Owner           | Tables                                                                               |
| --------------- | ------------------------------------------------------------------------------------ |
| **Better Auth** | `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` |
| **Us**          | `maps`, `offices`, `zones`, `office_members`, `audit_log`                            |

Better Auth's tables are declared in `src/db/auth-schema.ts`. Every column
there was read from `getAuthTables()` on the installed version, not from
documentation. **Do not redesign them.** If better-auth is upgraded, re-run the
introspection and diff before migrating.

An earlier draft of this document defined `organizations`, `memberships` and
`invites`. Those were wrong — the organization plugin already provides
`organization`, `member` and `invitation`. See decision 007.

## Tenancy rule

Every table we own carries `org_id`, including where it could be reached
through a join. The denormalization is deliberate: every query filters the
tenant boundary directly rather than trusting a join to have been written
correctly (CLAUDE.md §13).

`user` is global, so one person can hold one login across several
organizations. Nothing is readable from a `user` row alone — access always goes
through `member`.

`session.activeOrganizationId` carries which organization a session is scoped
to. That is the value org-scoping middleware reads. It is never taken from a
request body or a client-controlled path parameter.

```
organization
  ├─< member >─ user
  ├─< invitation
  ├─< maps
  ├─< offices ──> maps
  │      ├─< zones
  │      └─< office_members >─ user
  └─< audit_log
```

## Our tables

### maps

| column     | type        | notes                                      |
| ---------- | ----------- | ------------------------------------------ |
| id         | uuid pk     |                                            |
| org_id     | uuid null   | null = built-in template, available to all |
| name       | text        |                                            |
| version    | int         | bumped on edit                             |
| data       | jsonb       | Tiled export: layers, collision, objects   |
| tile_size  | int         | 16 for Kenney CC0, 32 for a later pack     |
| created_at | timestamptz |                                            |

### offices

| column      | type    | notes                                                  |
| ----------- | ------- | ------------------------------------------------------ |
| id          | uuid pk |                                                        |
| org_id      | uuid    | → organization, cascade                                |
| name        | text    |                                                        |
| map_id      | uuid    | → maps, **restrict** — a map in use cannot be deleted  |
| map_version | int     | pinned, so editing a map does not change a live office |

### zones

Extracted from the map's object layer on import, so authorizing a zone entry
never parses map JSON inside a realtime event (CLAUDE.md §16).

| column    | type                              | notes                                |
| --------- | --------------------------------- | ------------------------------------ |
| id        | uuid pk                           |                                      |
| org_id    | uuid                              | denormalized for scoping             |
| office_id | uuid                              | → offices, cascade                   |
| name      | text                              |                                      |
| kind      | enum(meeting, booth, desk, quiet) |                                      |
| bounds    | jsonb                             | `{x,y,width,height}` in world pixels |
| capacity  | int null                          | null = unlimited                     |

### office_members

Org membership does not imply access to every office once there is more than
one, so this is separate from `member`.

| column       | type        | notes              |
| ------------ | ----------- | ------------------ |
| office_id    | uuid        | → offices, cascade |
| user_id      | uuid        | → user, cascade    |
| org_id       | uuid        | → organization     |
| last_seen_at | timestamptz |                    |

**Primary key (office_id, user_id).**

### audit_log

Ours, because Better Auth writes none (decision 005).

| column     | type        | notes                                                           |
| ---------- | ----------- | --------------------------------------------------------------- |
| id         | uuid pk     |                                                                 |
| org_id     | uuid        | → organization, cascade                                         |
| actor_id   | uuid null   | → user, **set null** — deleting a user must not erase the trail |
| action     | text        | e.g. `member.role_changed`                                      |
| target     | text null   |                                                                 |
| metadata   | jsonb null  |                                                                 |
| created_at | timestamptz |                                                                 |

## Constraints we added to Better Auth's tables

One, deliberately:

```sql
CREATE UNIQUE INDEX member_org_user_unique ON member (organization_id, user_id);
```

Better Auth does not declare it. The billing seat count reads from `member`, so
a duplicate membership would be a billing error. The database enforces it
rather than the application.

## Indexes

`maps(org_id)` · `offices(org_id)` · `zones(office_id)` · `zones(org_id)` ·
`office_members(user_id)` · `office_members(org_id)` · `member(user_id)` ·
`audit_log(org_id, created_at desc)`

## Not yet

Deliberately absent until their phase: `channels`, `messages`, `reactions`,
`read_state` (17); `recordings` (18); `transcripts` (19); `subscriptions`,
`seats` (22). Do not add them early (CLAUDE.md §8).
