# Decision log

Append-only. Each entry records what was chosen, what was rejected, and what
would make us revisit. Do not change a past entry — add a new one that
supersedes it.

---

## 001 — Package versions are pinned exactly

**Date:** 2026-08-28

All dependency versions are exact, not ranged. Every version below was read
from the npm registry at pin time, not from memory (CLAUDE.md §24).

| Package            | Pinned    | Notes                           |
| ------------------ | --------- | ------------------------------- |
| node               | >= 24.0.0 | 20 is EOL — see 009             |
| typescript         | 6.0.3     | **not 7.x** — see 002           |
| next               | 16.3.3    |                                 |
| react / react-dom  | 19.2.8    |                                 |
| phaser             | 4.2.1     | **not 3.x** — see 003           |
| zod                | 4.5.1     |                                 |
| socket.io          | 4.8.3     |                                 |
| better-auth        | 1.7.2     |                                 |
| drizzle-orm        | 0.45.2    |                                 |
| drizzle-kit        | 0.31.10   |                                 |
| pg                 | 8.23.0    |                                 |
| livekit-client     | 2.22.1    |                                 |
| livekit-server-sdk | 2.18.0    |                                 |
| eslint             | 10.9.1    |                                 |
| typescript-eslint  | 8.68.0    | constrains typescript — see 002 |

`better-auth@1.7.2` declares peer ranges covering `next ^16`, `react ^19`,
`drizzle-orm ^0.45.2` and `pg ^8`, so this set is mutually compatible.

---

## 002 — TypeScript 6, not 7

**Date:** 2026-08-28
**Status:** Revisit when TypeScript 7.1 ships (targeted autumn 2026)

TypeScript 7.0.2 is the current `latest` tag. We are on 6.0.3 anyway.

**Why.** TS 7 is the native Go compiler and is 8–12× faster, but it shipped
without a stable programmatic compiler API — that is expected in 7.1. Without
it, `typescript-eslint` cannot support TS 7. Its peer range is explicit:

```
typescript: ">=4.8.4 <6.1.0"
```

Installing TS 7 silently removes all type-aware linting.

**Trade-off accepted.** We lose compile speed on a codebase small enough that
it does not yet matter. We keep lint, which matters more on a codebase that
will be handed to other developers.

**Revisit when** `typescript-eslint` publishes a release whose peer range
admits TypeScript 7. At that point upgrading is a version bump.

**Do not** upgrade TypeScript because a tool reports it as outdated. It is
pinned deliberately.

---

## 003 — Phaser 4, not 3

**Date:** 2026-08-28

The build plan said Phaser 3; that was written before checking. Phaser's npm
`latest` dist-tag is `4.2.1`, so v4 is the current stable line, and `3.90.0` is
the last v3. A greenfield project starts on the current major.

**Migration risk assessed as low for our use.** The v4 breaking changes are in
custom WebGL pipelines, filter effects, `BitmapMask`, `setTintFill`,
`Geom.Point` and `Math.TAU`. We use none of them. Tilemaps, sprites, Arcade
physics, input, scenes, cameras and tweens are unchanged — that is our entire
surface area.

---

## 004 — Realtime state is in-memory, behind an interface

**Date:** 2026-08-28
**Status:** Revisit at 2+ server instances

Positions, sockets, heartbeats and presence live in a `Map` inside one Node
process, reached only through a `PresenceStore` interface.

**Why not Redis now.** One process and ten users does not need a second
datastore, a second failure mode, or a second thing to secure (CLAUDE.md §7).

**What makes it reversible.** Nothing outside the store touches state, so Redis
arrives as a second implementation of the same interface rather than a
refactor.

**Revisit when** a second server instance exists. At that point Socket.IO also
needs a cross-process adapter, and both land together as one change.

**Accepted consequence.** State is lost on restart. Clients resync from a
snapshot on reconnect, and phase 15 tests exactly that by killing the server
mid-session.

---

## 005 — Better Auth, with the organization model in our database

**Date:** 2026-08-28

**Why not hand-rolled.** Sessions, token rotation and password reset are where
custom auth quietly goes wrong.

**Why not Clerk or WorkOS.** Both hold organizations and memberships on their
side. Our tenant boundary is a hard security boundary (CLAUDE.md §13) and our
seat count drives billing, so mirroring that into Postgres would put a sync gap
in the worst possible place.

**Trade-offs accepted.**

- No hosted SAML/SCIM. Enterprise SSO means adding WorkOS as an SSO layer in
  front, and not before a customer asks for it (CLAUDE.md §8).
- Better Auth writes no audit trail. We own the `audit_log` table.
- Its generated schema must be reviewed before adoption, not accepted blindly.

---

## 006 — World coordinates are pixels, not tiles

**Date:** 2026-08-28

All positions crossing the wire are map pixels. Tile size lives in the asset
manifest.

**Why.** V1 art is Kenney CC0 at 16×16 and a paid pack later will likely be
32×32. If the wire format were tiles, changing art pack would change the
meaning of every stored coordinate and every proximity radius.

---

## 007 — Better Auth owns organizations, members and invitations

**Date:** 2026-08-28
**Supersedes:** the `organizations` / `memberships` / `invites` tables in the
first draft of `docs/erd.md`

The organization plugin was inspected with `getAuthTables()` against the
installed better-auth@1.7.2 — not against documentation — and it already
defines:

| table          | fields                                                               |
| -------------- | -------------------------------------------------------------------- |
| `organization` | name, slug, logo, createdAt, metadata                                |
| `member`       | organizationId, userId, role, createdAt                              |
| `invitation`   | organizationId, email, role, status, expiresAt, createdAt, inviterId |

It also extends `session` with `activeOrganizationId`.

**Consequence.** We do not define parallel tenant tables (CLAUDE.md §9). Our
domain tables reference `organization.id` and `user.id` directly. The tenant
boundary is Better Auth's `member` table, and `session.activeOrganizationId` is
what org-scoping middleware reads.

**One addition of ours.** A unique index on `member (organization_id, user_id)`.
Better Auth does not declare it, but the billing seat count reads from that
table, so a duplicate membership would be a billing error.

**On upgrading better-auth.** Re-run the introspection and diff
`src/db/auth-schema.ts` before migrating. That file is transcribed from the
library, not designed by us.

---

## 008 — Ids are uuids everywhere, including Better Auth's

**Date:** 2026-08-28

Better Auth generates nanoid-style string ids by default. Our shared contracts
brand every id as `z.uuid()` (`packages/shared/src/ids.ts`).

Rather than weaken the contract to accept arbitrary strings, we override:

```text
advanced: { database: { generateId: () => crypto.randomUUID() } }
```

Every id column is a Postgres `uuid`, in both groups of tables.

---

## 009 — Node 24, not 20

**Date:** 2026-08-28
**Resolved:** 2026-08-29 — development machine upgraded to v24.20.0

Node 20 reached end-of-life and receives no further security patches. Node 24
is the current Active LTS. `engines.node` is set to `>=24.0.0` and
`@types/node` is pinned to the 24.x line.

Running an EOL runtime in production is a security problem, not a style
preference (CLAUDE.md §12). Upgrade with `nvm install 24 && nvm use 24`.

Until then pnpm prints an unsupported-engine warning on every install. That
warning is correct and should not be silenced.

---

## 010 — pnpm lifecycle scripts are an explicit allowlist

**Date:** 2026-08-28

pnpm 10 blocks package install scripts by default. Rather than approving them
interactively — which leaves no record — the allowlist lives in the root
`package.json`:

```json
"pnpm": { "onlyBuiltDependencies": ["esbuild"] }
```

`esbuild`'s postinstall downloads its platform binary and is required by tsx,
drizzle-kit and vitest. Nothing else is permitted to run code at install time.

Adding a package to this list is a security decision and belongs in review
(CLAUDE.md §35).

**Known upstream wart.** `drizzle-kit@0.31.10` depends on the deprecated
`@esbuild-kit/esm-loader`, which pins an old esbuild. Traced and accepted — it
is drizzle-kit's dependency, not one we introduced.

---

## 011 — Only 37 of 486 atlas tiles are usable as a fill

**Date:** 2026-08-29

Most tiles in a tileset are edge or corner pieces of a 3×3 border set. Painting
one across a floor renders a grid of stripes rather than a surface, and nothing
about the index tells you which kind you have.

`apps/web/scripts/find-fill-tiles.py` reports the safe ones: a tile qualifies
when it is fully opaque and its left edge matches its right and top matches
bottom, so tiling leaves no seam. **Run it before choosing any floor or wall
index.**

Seamless is necessary but not sufficient — windows also tile cleanly. The
script separates terrain fills from decorative ones by atlas region.

---

## 012 — Map generation asserts every zone is reachable

**Date:** 2026-08-29

A plant placed one tile from the standup doorway sealed the room. The map file
looked correct; the symptom was a player who could not reach the standup.

`generate-map.mjs` now flood-fills from the spawn point and throws if any zone
has no reachable tile. Verified by blocking the doorway deliberately and
confirming generation fails.

This matters more as maps become customer-editable — a customer who decorates
their office into an unreachable meeting room must get an error, not a
mysteriously empty standup.

---

## 013 — Seamless is not the same as "reads as a floor"

**Date:** 2026-08-29
**Supersedes:** the terrain-region heuristic in decision 011

`find-fill-tiles.py` originally accepted any tile whose edges matched, then
split the results by atlas region. That was not enough: tile 68 sits in the
terrain rows, tiles perfectly, and rendered the lounge as a grid of window
frames.

The script now also requires near-uniformity — few distinct colours, low
internal contrast. Of 486 tiles, 37 are seamless and only **7** are usable as a
floor or wall. Every index in `generate-map.mjs` comes from those 7.

---

## 014 — One effect owns the realtime connection

**Date:** 2026-08-29

The connection was opened in one React effect and closed in another. Under
StrictMode's double-mount the cleanup disconnected the socket while the
`loaded` state survived the remount, so nothing reconnected. The office looked
correct — other people were visible, because the scene had already received its
snapshot — while the status badge sat on "Disconnected" forever.

Connect and teardown now live in a single effect keyed on the session, so a
remount re-runs the whole lifecycle.

**The test did not catch it**, because `getByText("Connected")` matches by
substring and "Disconnected" contains "Connected". The assertion is now exact,
and was verified by breaking the socket deliberately.

---

## 015 — The development seed syncs a changed map

**Date:** 2026-08-29

The seed was idempotent to the point of uselessness: once an office existed it
ignored the map file entirely, so editing `generate-map.mjs` and re-seeding
appeared to do nothing.

It now diffs the stored map against the file, and on a change updates the data,
bumps the version, repoints the office, and rebuilds the zone rows. Zones are
replaced wholesale rather than merged, because a zone deleted from the map must
disappear from the office too.

---

## 016 — Proximity is a pure function in the shared package

**Date:** 2026-08-29

`decideProximity()` takes where everyone is and what is currently subscribed,
and returns the subscription changes to make. No SDK, no sockets, no
rendering.

**Why it lives in `@vo/shared`.** The rules of "who can I hear" are the product.
Keeping them pure means they are unit-tested exhaustively — hysteresis, zone
overrides, the video cap, focus mode — rather than discovered by walking two
browsers around an office.

**Verified by mutation.** Setting both audio radii equal fails the churn test;
allowing zone members to be heard from the open floor fails the eavesdropping
test. Both confirmed.

**The output is subscriptions, never connections.** Everyone in an office
shares one SFU room. Walking toggles `setSubscribed()` on an existing
connection, so pacing at the edge of a radius costs nothing — the churn problem
the original plan flagged but could not solve.

---

## 017 — Media is optional, and its absence is a first-class state

**Date:** 2026-08-29

Without `LIVEKIT_*` credentials the office still runs: presence, movement,
zones and chat all work, and the media controls are replaced by an explanation
rather than buttons that fail when clicked.

**Why it matters beyond development.** A LiveKit outage should degrade the
product to a working spatial office, not break it. Building the unconfigured
path first means that behaviour is tested rather than hoped for.

Token grants are verified in tests with dummy credentials, because a LiveKit
token is a JWT signed with the secret — its claims can be checked offline. The
tests would otherwise skip in every environment without an account, which is
the same as not having them.

---

## 018 — The standup doorway is three tiles, not two

**Date:** 2026-08-29

The avatar's collision body is 8px tall and sits at its feet, so a two-tile
(32px) doorway had a usable band of only 24px. Ten people arriving at once for
a standup is exactly when that margin matters, and several were left outside.

Widened to three tiles. The general lesson: a gap is narrower than it looks
because the body is not the sprite.

---

## 019 — Ten browsers need renderer throttling disabled

**Date:** 2026-08-29

Chrome throttles `requestAnimationFrame` in backgrounded renderers, which
stalls Phaser's update loop. With ten browsers open only one can be in the
foreground, so the load test was measuring Chrome's throttling rather than the
server.

`--disable-background-timer-throttling`, `--disable-renderer-backgrounding`
and `--disable-backgrounding-occluded-windows` are set in the Playwright
config.

**Worth knowing beyond the test:** a real user with the office in a background
tab stops sending movement for the same reason. Their heartbeat continues, so
they stay online — they simply stop moving, which is the correct behaviour.

---

## 020 — The load test asserts scene state, not header text

**Date:** 2026-08-29

Asserting on rendered text was flaky with ten browsers: a renderer can be
mid-render when its turn comes, and repeated cross-page polling added enough
contention to change the result it was measuring.

The acceptance criterion is that everyone is in the zone, so the test reads the
scene's own state and reports the exact position of anyone left outside. That
the zone name reaches the header is covered once, by the single-user test.

---

## 021 — Rate limits apply to credentials, not to all of /api/auth

**Date:** 2026-08-29

The first version limited every path under `/api/auth/*` to 20 requests a
minute per IP. That namespace also contains `get-session`, which every client
polls — so a ten-person team behind one office NAT would have throttled itself
at nine in the morning. It also broke the browser test suite immediately,
which is how it was caught.

Only `sign-in`, `sign-up`, `forget-password` and `reset-password` are tightly
limited now, at 60 a minute per IP.

**What this protects and what it does not.** A per-IP limit protects the server
from a flood. It is the wrong control for guessing a single account's password
— that needs a per-account limit, which is Better Auth's concern.

---

## 022 — The server image is built with `pnpm deploy`, not a root install

**Date:** 2026-08-29

`pnpm install --prod` at the workspace root installs every workspace project,
so the server image contained Next.js (201MB), its SWC binary (83MB), sharp and
Playwright. 888MB for a Node API.

`pnpm deploy --filter=@vo/server --prod --legacy --config.node-linker=hoisted`
prunes to one project and flattens its dependencies: **408MB**, with
`node_modules` down from 498MB to 137MB.

The hoisted linker matters — without it, `--legacy` copies the whole virtual
store and the pruning has no effect on size.

---

## 023 — Metrics are JSON, not Prometheus

**Date:** 2026-08-29

One process serving ten people does not need a scrape protocol, a time series
database or a query language (CLAUDE.md §7). It needs an answer to "is anything
broken right now", which `/metrics` gives as counters, gauges and latency
percentiles.

Latency samples are capped at 512 per metric — a metrics registry that grows
without bound is a memory leak wearing a monitoring costume. A gauge that
throws returns -1 rather than failing the endpoint, because the one endpoint
you need when things are going wrong must not be the one that breaks.

The shape is close enough to Prometheus that swapping in a real exporter later
is a rewrite of one file.

---

## 024 — Chat travels on the office socket

**Date:** 2026-08-29

Messages use the same Socket.IO connection as movement rather than a second
transport. A separate channel would be a second thing to authenticate,
reconnect, rate-limit and debug (CLAUDE.md §7).

**Delivery is per person, not per office.** Each socket joins a personal room
on connect, and a message is emitted to its channel members' rooms. Broadcasting
to the office room instead would leak a private conversation to whoever
happened to be standing nearby — the members of a channel and the people in a
room are different sets.

**History is REST, the present is a socket.** Paging through a year of messages
over a WebSocket would be the wrong tool (CLAUDE.md §15). Paging is cursor-based
so a message arriving mid-scroll does not shift every later page.

**Deletion is soft, twice over.** A deleted message keeps its row so replies
keep their context, and its text stops travelling. A deleted _account_ leaves
its messages behind under "Former member" — removing a person should not
silently rewrite a conversation other people took part in.

---

## 025 — ESLint flat config is order-dependent

**Date:** 2026-08-29

The override allowing `console.log` in command-line scripts sat _before_ the
general rules block, so the general block silently won and the warning
persisted. Moved after.

Worth remembering for any future override: in flat config, later blocks beat
earlier ones, which is the opposite of how `.eslintrc` overrides read.

---

## 026 — The view renders video; it never subscribes to it

**Date:** 2026-08-29

`VideoTiles` draws whatever feeds it is handed and never calls `setSubscribed`
itself. Which cameras arrive is decided entirely by the proximity engine.

**Why the split matters.** "Who can I see" is a rule, and a rule split between
an engine and a view is a rule that will disagree with itself. Keeping the
decision in one tested place means the video that appears always matches the
audio you can hear.

A subscribed track with nothing rendering it was the gap this closed: the
engine had been subscribing to cameras since phase 09, and nothing displayed
them.

Tracks are detached on unmount. An orphaned attachment keeps decoding video
for someone who has already walked away.

---

## 027 — Device pickers appear only when there is a choice

**Date:** 2026-08-29

A dropdown listing one microphone is not a decision; it is noise that trains
people to ignore the controls. The pickers render only when more than one
device exists.

They are also populated _after_ permission is granted rather than at mount,
because browsers withhold device labels until then — a picker shown too early
lists "Microphone 1" and "Microphone 2" and helps nobody.

---

## 028 — The art pack is LimeZu Modern Interiors, at 32×32

**Date:** 2026-08-29
**Supersedes:** decision 011's Kenney choice

Kenney was the right call while the product was unvalidated — CC0, no
obligations. It is not the right call for something being sold: four
characters, no sitting poses, and a visibly minimal style.

**Modern Interiors**, purchased. Licence permits commercial use and **requires
credit**, which is rendered from `manifest.credits` rather than written into a
component, so a future pack swap cannot leave a stale or missing attribution.

**What shipped into the repo, and what did not.** The pack is 156MB and 53,329
files. The project carries 612KB: one Room Builder tileset, one furniture
theme, and a purpose-built character atlas. The full download stays outside the
repo.

**The character atlas is repacked, not shipped as-is.** Each premade character
is a 1792×1312 sheet of 2,296 frames covering sleeping, reading and holding a
phone. We use 28 — four idle and a 24-frame walk — so twenty characters were
repacked into one 896×1280 atlas.

**Frames are 32×64, not square.** The sprite is a body plus a head, standing at
the bottom of its frame. `footOffsetY` in the manifest says where the feet are;
without it the collision body is the whole rectangle and the avatar stops a
tile short of every wall.

**Direction order is [right, up, left, down]**, determined by cropping and
enlarging frames until it was unambiguous, not by assuming the previous pack's
[left, down, up, right].

---

## 029 — Proximity radii do not scale with tile size, and that is a trap

**Date:** 2026-08-29

The radii are world pixels. Moving from a 16px pack to a 32px one silently
halved every range in tile terms — a 160px pickup radius went from ten tiles to
five, and nobody could hear anyone.

They are now doubled and commented. There is no automatic derivation, because
the proximity engine is deliberately pure and knows nothing about tiles.
**Whenever the grid changes, revisit `PROXIMITY`.**

---

## 030 — Map and zone caches are keyed by map version

**Date:** 2026-08-29

The realtime gateway cached zones and spawn geometry per office and never
invalidated them, so an edited map took effect only after a server restart.
People kept spawning at the old point in a room that had moved.

Keying the cache by office _and map version_ makes a new version miss
naturally, with no invalidation to remember. This matters more once offices are
customer-editable — a saved edit that appears to do nothing is the worst
possible feedback.

---

## 031 — Walkways are asserted, not assumed

**Date:** 2026-08-29

Three separate times, a decorative palm blocked a route: once sealing the
standup doorway, once trapping the aisle, once cutting the path to the lounge.
Each looked fine in the map file.

`generate-map.mjs` now asserts the aisle and the bottom concourse are clear, on
top of the existing zone-reachability flood fill. The subtlety that made this
easy to get wrong: the collision body sits half a tile _below_ the sprite
centre, so a tile that looks one row clear of a walkway is not.

**Tests navigate by zone name, not coordinates.** Every hardcoded coordinate
broke when the tile size doubled. They now read zone centres from the running
map, so they survive the map editor.

## 32. Furniture is measured, not eyeballed

Every object in the art pack is found by flood-filling the sheet's alpha
channel (`generate-objects.mjs`), giving 3,751 objects with true tile
footprints. The pack ships no metadata, so the alternative was measuring by
eye — and a sofa that looks three tiles wide is 2.6 tiles of pixels. The editor
stamps whole objects from this index; the layout compiler references them as
`sheet#index`.

Hand-picking tiles is what produced the first office: six tiles chosen by eye
out of 27,232, and a plant that sealed a doorway three times.

## 33. One reachability rule, in the shared package

`findLayoutProblems` lives in `@vo/shared` and is used by the publish endpoint,
the layout compiler, and the editor. There were three implementations of the
same flood fill; the server's was the only one that allowed a room reachable
but furnished down to a single tile.

Four-way, never eight — the avatar moves four ways, so a diagonal gap between
two desks is not a route. It reports every sealed room rather than throwing on
the first.

## 34. Dev servers are restarted through a script

`pnpm dev:restart`. Killing whatever holds ports 4000 and 3100 leaves any
instance that failed to bind alive, still holding its database pool. Seven
accumulated during one session and starved the server tests into a hook
timeout that looked like a real failure. The script kills by path, waits for
the ports to free, and waits for health before returning.
