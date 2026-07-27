# syntax=docker/dockerfile:1
#
# Multi-stage so the runtime image carries no compiler, no source and no
# development dependencies. Runs as a non-root user, because a container that
# runs as root turns a code-execution bug into a host problem.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- build ------------------------------------------------------------------
# Manifests are copied before the source so a source change does not invalidate
# the install layer.
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @vo/server... --filter @vo/shared

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server

RUN pnpm --filter @vo/shared build && pnpm --filter @vo/server build

# `pnpm deploy` prunes to one workspace project and inlines its workspace
# dependencies. Installing at the root instead pulls in every project — which
# put Next.js, its SWC binary, sharp and Playwright into the server image and
# took it to 888MB.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --filter=@vo/server --prod --legacy \
      --config.node-linker=hoisted /deploy

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /deploy/package.json ./package.json
COPY --from=build /deploy/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle

USER node
EXPOSE 4000

# Readiness, not liveness: a process that is up but cannot reach Postgres
# should leave the load balancer rotation rather than be restarted.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
