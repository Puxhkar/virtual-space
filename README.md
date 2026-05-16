# Virtual Office

A spatial workspace for remote teams. Walk an avatar around a 2D office, talk
to whoever is nearby, meet in a standup room.

## Documents

| File                | What it is                                       |
| ------------------- | ------------------------------------------------ |
| `plan.html`         | Phased build plan, Track A and Track B           |
| `CLAUDE.md`         | Engineering guidelines. Binding.                 |
| `docs/decisions.md` | Decision log. Read before changing a dependency. |
| `docs/erd.md`       | Data model (phase 02)                            |
| `docs/api.md`       | HTTP routes (phase 04)                           |

The realtime contract has no document — it is code, at
`packages/shared/src/events.ts`.

## Layout

```
packages/shared    contracts: ids, geometry, presence, zones, events
apps/web           Next.js frontend            (phase 03)
apps/server        API + realtime gateway      (phase 04)
```

## Requirements

- Node >= 20.9.0
- pnpm 10
- Docker (for Postgres, from phase 02)

## Setup

```bash
pnpm install
pnpm build
```

## Commands

| command             | does                        |
| ------------------- | --------------------------- |
| `pnpm typecheck`    | type-check every package    |
| `pnpm lint`         | ESLint across the workspace |
| `pnpm format`       | Prettier, write             |
| `pnpm format:check` | Prettier, verify only       |
| `pnpm build`        | build every package         |

## Before changing a dependency

Versions are pinned exactly and deliberately. **TypeScript is held at 6.x on
purpose** — 7.x removes type-aware linting because `typescript-eslint` does not
support it yet. See `docs/decisions.md` entry 002 before upgrading anything.

## Running locally

```bash
cp .env.example .env          # then set BETTER_AUTH_SECRET
openssl rand -base64 32       # a value for it

docker compose up -d          # Postgres 18 on :5432
pnpm --filter @vo/server db:migrate
pnpm --filter @vo/server test # 13 tenant-isolation tests
```

`docker compose down` stops Postgres and keeps the data. `down -v` deletes it.

## Status

**Phase 00–01 complete.** Repository, toolchain, shared contracts, design
documents.

**Phase 02 complete.** Postgres schema (12 tables), Better Auth with the
organization plugin, org-scoped query layer, and a tenant-isolation suite that
is verified to actually fail when scoping is removed.

**Phase 03 complete.** Asset manifest, Kenney CC0 art, Tiled map with
reachability validation, and a single-player Phaser office with movement,
collision, four-directional animation and a camera. Verified by 5 Playwright
tests driving a real browser.

**Phase 04 complete.** Hono API — health, session, org and office routes, one
error shape, org scoping enforced by middleware that re-checks membership on
every request.

**Phases 05-06 complete.** Socket.IO gateway with authenticated handshake,
snapshot-on-join, batched movement broadcast, server-side speed validation,
zone detection, duplicate-tab eviction and stale-connection sweeping. Transient
state lives in an in-memory `PresenceStore` behind an interface Redis can later
implement.

**Phase 07 complete.** The browser is wired to the server: sign-in, office and
map loaded from the API, socket connection with status, remote players
rendered with interpolation, name labels and presence dots. Two browsers see
each other move.

**Phases 08-10 complete, pending credentials.** LiveKit token service (grants
verified offline against the signing secret), the proximity engine, the media
client, and zone rendering. Without LiveKit credentials the office works and
the media controls say so rather than failing on click.

**Blocked:** voice and video cannot be verified end to end until
`LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are set. Everything
else in those phases is built and tested.

**Phases 08-10 complete and verified with real LiveKit.** Token service,
proximity engine, media client, zone rendering. Audio follows distance;
a booth conversation is not overheard from the floor.

**Phase 11 complete.** Speaking rings, "N people can hear you", mic/camera/
screen controls that show state, and graceful degradation when media is
unconfigured.

**Phase 15 complete.** Ten real browsers in one office: everyone sees the
other nine, everyone moves at once, everyone fits in the standup room.

**Phase 13 complete.** Rate limiting on credential endpoints and media tokens,
per-socket event budgets, security headers, dependency audit clean.

**Phase 14 complete.** Structured logging with request ids and redaction,
`/metrics` with counters, gauges and latency percentiles, realtime
instrumentation.

**Phase 12 complete except the deploy itself.** Dockerfile (408MB, non-root,
health-checked), CI workflow, `docs/deployment.md`. **Needs hosting accounts
from you to actually deploy.**

**Phase 17 complete.** Async chat — channels, threaded messages, cursor-paged
history, unread counts, live delivery over the existing socket. Messages
survive a reload; typing does not walk your avatar.

**Phase 11 finished properly.** Proximity video is now rendered, not just
subscribed — camera tiles for nearby people, a large slot for a screen share,
a speaking border, and device pickers that appear only when there is a choice
to make.

**Art upgraded to LimeZu Modern Interiors** (32×32, licensed for commercial
use, credit rendered in-app). Twenty characters with real walk cycles, desks,
stools, a conference table, sofa and plants. Attribution comes from the asset
manifest so a pack swap cannot lose it.

**Next:** 18 (recording — needs an S3 bucket), 19-23. Phase 16 (internal
launch) needs your team or a deployment.

## Running it

From a clean checkout:

```bash
pnpm install
pnpm db:up                              # Postgres in Docker
pnpm --filter @vo/server db:migrate
pnpm seed                               # 10 people, one office, #general
pnpm dev                                # API on :4000, web on :3100
```

Then open **http://localhost:3100** and sign in as any of:

```
ada@example.com        grace@example.com      alan@example.com
edsger@example.com     barbara@example.com    donald@example.com
margaret@example.com   linus@example.com      katherine@example.com
tim@example.com

password: development-password-123
```

Open a second browser profile (or an incognito window) and sign in as someone
else to see two people in the office at once.

**Try:** walk with WASD or the arrow keys · turn on your mic and walk toward
someone · walk into the tan room top-right and watch the header · step into the
dark rug bottom-left with someone and notice nobody outside can hear you ·
open Chat.

```bash
pnpm verify                   # the full gate: 11 checks
pnpm --filter @vo/web e2e     # browser tests only
```

Regenerating the map, after changing `scripts/generate-map.mjs`:

```bash
cd apps/web
python3 scripts/find-fill-tiles.py   # which tiles are safe as a floor
node scripts/generate-map.mjs        # rebuild + validate reachability
```
