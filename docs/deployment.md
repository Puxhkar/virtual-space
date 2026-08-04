# Deployment

What has to exist before the first deploy, and what runs where.

## Shape

| Piece         | Runs as                              | Notes                          |
| ------------- | ------------------------------------ | ------------------------------ |
| `apps/web`    | Static + SSR (Vercel)                | Next 16                        |
| `apps/server` | Container (`apps/server/Dockerfile`) | API **and** socket on one port |
| Postgres      | Managed (Neon/Supabase)              | Needs point-in-time recovery   |
| LiveKit       | LiveKit Cloud                        | Already configured             |

The API and the realtime gateway share one HTTP server, so there is one
container and one port. That is a deliberate consequence of decision 004 — a
second instance needs Redis and a Socket.IO adapter together, not separately.

## Host requirements

The server host must support **long-lived WebSocket connections**. This rules
out anything that runs the process as a short-lived serverless function, which
is why the server is not on Vercel alongside the frontend.

Sticky sessions are not required at one instance. They become required at the
same moment Redis does.

## Environment

Copy `.env.example`. Everything without a default is mandatory and the process
**refuses to start** without it — a missing secret is a startup crash with a
readable message, never an undefined that surfaces as a 500 an hour later.

| Variable              | Notes                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | Managed Postgres, TLS required in production                                                  |
| `BETTER_AUTH_SECRET`  | `openssl rand -base64 32`. **Unique per environment** — rotating it invalidates every session |
| `BETTER_AUTH_URL`     | Public URL of the API                                                                         |
| `WEB_ORIGIN`          | Exactly one origin. CORS sends credentials, so a wildcard is not an option                    |
| `LIVEKIT_*`           | Optional. Without them the office runs and media controls say so                              |
| `NEXT_PUBLIC_API_URL` | Build-time for the frontend                                                                   |

## Build and run

```bash
docker build -f apps/server/Dockerfile -t vo-server .
docker run -p 4000:4000 --env-file .env vo-server
```

The image is ~400MB and runs as the non-root `node` user.

**On image size:** the Dockerfile uses `pnpm deploy --filter=@vo/server`, not a
root `pnpm install --prod`. The root install pulls in every workspace project,
which put Next.js, its SWC binary, sharp and Playwright into the server image
and took it to 888MB.

## Migrations

Run before the new version starts serving:

```bash
pnpm --filter @vo/server db:migrate
```

Migrations are forward-only and must be backwards-compatible with the running
version for the length of a deploy — add a column before writing to it, and
drop one a release after nothing reads it.

## Health

| Endpoint   | Question               | Use for                          |
| ---------- | ---------------------- | -------------------------------- |
| `/healthz` | Is the process up?     | Liveness — restart on failure    |
| `/readyz`  | Can it reach Postgres? | Readiness — remove from rotation |
| `/metrics` | What is happening?     | Monitoring                       |

Point the load balancer at `/readyz`. A process that is up but cannot reach the
database should leave the rotation rather than be killed and restarted, because
restarting it will not fix the database.

`/metrics` carries no personal data — only counts — but should not be publicly
routable.

## What to watch first

The numbers that move before anyone reports a problem:

- `realtime.connections.closed` rising against `opened` — clients dropping
- `realtime.swept_stale` — connections lost without a clean disconnect
- `realtime.move.client_lag_ms` p95 — the first sign of a struggling network
- `http.errors.*`
- `realtime.rate_limited` — either an attack or a client bug

## Not yet

Multi-region, autoscaling and a self-hosted SFU are all out of scope. Each
becomes worth doing at a specific, observable moment: a second instance when
one saturates, a second region when latency to it is the complaint, a self-
hosted SFU when LiveKit minutes become a real line item.
