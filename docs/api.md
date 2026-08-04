# HTTP API

Target for phase 04. The realtime contract is **not** here — it is defined in
code at `packages/shared/src/events.ts`, which is the single source of truth
for event names and payloads.

## Rules

- Every route except health and auth requires an authenticated session.
- Every org-scoped route resolves `org_id` from the session, never from the
  request body or a path parameter the client controls.
- Every input is parsed with a Zod schema before use.
- No high-frequency data here. Movement and presence go over the socket
  (CLAUDE.md §15).

## Response shape

Success returns the resource directly. Errors return:

```json
{ "error": { "code": "forbidden", "message": "..." } }
```

Codes: `unauthenticated`, `forbidden`, `not_found`, `invalid_input`,
`conflict`, `rate_limited`, `internal`. Messages are safe to display and never
carry internal detail.

## Routes

### Health

| method | path       | notes                                |
| ------ | ---------- | ------------------------------------ |
| GET    | `/healthz` | process is up. No dependency checks. |
| GET    | `/readyz`  | database reachable. Used by the LB.  |

### Session

Better Auth mounts its own handlers under `/api/auth/*`. We do not reimplement
sign-in, sign-out, or callbacks.

| method | path  | returns                                 |
| ------ | ----- | --------------------------------------- |
| GET    | `/me` | user, their organizations, role in each |

### Organizations

| method | path                           | notes                           |
| ------ | ------------------------------ | ------------------------------- |
| GET    | `/orgs/:orgId`                 | membership required             |
| GET    | `/orgs/:orgId/members`         | membership required             |
| PATCH  | `/orgs/:orgId/members/:userId` | role change. owner/admin only   |
| DELETE | `/orgs/:orgId/members/:userId` | remove member. owner/admin only |

### Invites

| method | path                   | notes                                                                     |
| ------ | ---------------------- | ------------------------------------------------------------------------- |
| POST   | `/orgs/:orgId/invites` | owner/admin only                                                          |
| POST   | `/invites/accept`      | body `{ token }`. Unauthenticated caller allowed — the token is the proof |

### Offices

| method | path                         | notes                                      |
| ------ | ---------------------------- | ------------------------------------------ |
| GET    | `/orgs/:orgId/offices`       | offices the caller may enter               |
| GET    | `/offices/:officeId`         | config, zones, and map reference           |
| GET    | `/offices/:officeId/map`     | map JSON + tile size. Cacheable by version |
| GET    | `/offices/:officeId/members` | roster with last-seen                      |

### Media

| method | path                       | notes                                                                                             |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------- |
| POST   | `/offices/:officeId/token` | mints a short-lived LiveKit token. Grants derive from verified membership, never from the request |

Phase 08. The LiveKit API secret never leaves the server.

## Not yet

`/channels`, `/messages` (phase 17); `/recordings` (18); `/transcripts` (19);
`/billing` (22). Do not stub them early.
