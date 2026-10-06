# Budget OS on Cloud Run (ADR-065): one image for every service.
#   budgetos-app     API + web, behind IAP           (default command)
#   budgetos-slack   the signed Slack routes, public  (PUBLIC_ROUTES=slack, default command)
#   budgetos-worker  outbox handlers, pacing, Slack   (apps/workers/src/local-runner.ts)
#   budgetos-migrate migrations + bootstrap (job)     (see .github/workflows/deploy.yml)
#   budgetos-mcp     read-only MCP server             (apps/mcp/src/main.ts)
#
# W2-8 (audit S-10, M-6): multi-stage build, non-root at runtime, no devDependencies or raw
# TypeScript *execution* in production. Packages/apps are compiled with `tsc` (see
# docker/build-server.sh for why `tsc` and not esbuild) to plain JavaScript IN PLACE — a `.js`
# file next to each `.ts` file — rather than into a separate `dist/`, so a package's compiled
# layout can never drift from its source layout. Every `@budget/*` package.json keeps pointing
# its "exports" at the `.ts` source (unchanged, so `pnpm dev`/`tsx`/`vitest` are unaffected); at
# runtime, docker/resolve-hooks.mjs (registered via NODE_OPTIONS) rewrites that resolution from
# `.ts` to the compiled `.js` sibling. `.github/workflows/deploy.yml` is not edited by this
# change (a separate PR owns it): the three commands it hardcodes as
# `node_modules/.bin/tsx <path>.ts` keep working because docker/tsx-shim.mjs is copied over that
# path in the runtime stage and rewrites the one argument it is ever called with to its compiled
# `.js` sibling before exec'ing plain `node`. See docs/runbooks/deploy.md ("Image") for the
# measured cold start and image size, and the PR for the full rationale.

FROM node:22-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/workers/package.json apps/workers/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/query-planner/package.json packages/query-planner/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/grid/package.json packages/grid/package.json
COPY packages/timeline/package.json packages/timeline/package.json
COPY packages/ui/package.json packages/ui/package.json
# Full install (with devDependencies): needed to typecheck/compile and to build the web app.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @budget/db exec prisma generate
# iap (ADR-065) or session: Budget OS's own Google sign-in (ADR-067), chosen by the deploy.
ARG WEB_AUTH_MODE=iap
RUN cd apps/web && VITE_AUTH_MODE=$WEB_AUTH_MODE node_modules/.bin/vite build
RUN ./docker/build-server.sh

# ---------------------------------------------------------------------------------------------
# A second, FRESH install with --prod: never shares a node_modules with the `deps`/`build`
# stages above. @prisma/client's generated output is written by `prisma generate` directly into
# whichever node_modules it is run against (prisma CLI is a `dependencies` entry of @budget/db
# precisely so it ships here and in production, for the migrate job) — generating straight into
# this prod-only tree, instead of copying generated output from the full `build` stage, avoids a
# real failure mode: pnpm's peer-dependency hashing for @prisma/client's store folder differs
# between a full install (devDependency `typescript` present) and a --prod install (absent), so
# a copy from one tree to the other silently loses the generated client.
FROM node:22-slim AS deps-prod
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/workers/package.json apps/workers/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/query-planner/package.json packages/query-planner/package.json
COPY packages/ai/package.json packages/ai/package.json
RUN pnpm install --prod --frozen-lockfile
COPY packages/db/prisma packages/db/prisma
RUN pnpm --filter @budget/db exec prisma generate

# ---------------------------------------------------------------------------------------------
FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
# pnpm itself (not only the packages it manages) is still needed at runtime: the migrate job
# (.github/workflows/deploy.yml, not edited here) runs
# `pnpm --filter @budget/db exec prisma migrate deploy`. COREPACK_HOME must be set before
# `corepack prepare` (run here as root) so the downloaded pnpm is cached somewhere the `node`
# user (USER node, below) can still read at container start — otherwise corepack re-downloads
# pnpm from the registry on every cold start, since its default cache lives under root's $HOME.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate && chmod -R a+rX /opt/corepack
WORKDIR /app

# Each package/app needs TWO copies, not one: a directory source copied into a destination
# that is its parent (e.g. "apps/api/") has its *contents* merged straight into that parent
# (Docker's documented behaviour for a directory source), not nested under a "node_modules"
# subdirectory — so node_modules must always be its own, exact-path COPY destination.
COPY --chown=node:node --from=deps-prod /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --chown=node:node --from=deps-prod /app/node_modules node_modules

COPY --chown=node:node --from=deps-prod /app/apps/api/package.json apps/api/package.json
COPY --chown=node:node --from=deps-prod /app/apps/api/node_modules apps/api/node_modules
COPY --chown=node:node --from=deps-prod /app/apps/workers/package.json apps/workers/package.json
COPY --chown=node:node --from=deps-prod /app/apps/workers/node_modules apps/workers/node_modules
COPY --chown=node:node --from=deps-prod /app/apps/mcp/package.json apps/mcp/package.json
COPY --chown=node:node --from=deps-prod /app/apps/mcp/node_modules apps/mcp/node_modules
COPY --chown=node:node --from=deps-prod /app/packages/domain/package.json packages/domain/package.json
COPY --chown=node:node --from=deps-prod /app/packages/domain/node_modules packages/domain/node_modules
COPY --chown=node:node --from=deps-prod /app/packages/query-planner/package.json packages/query-planner/package.json
COPY --chown=node:node --from=deps-prod /app/packages/query-planner/node_modules packages/query-planner/node_modules
COPY --chown=node:node --from=deps-prod /app/packages/ai/package.json packages/ai/package.json
COPY --chown=node:node --from=deps-prod /app/packages/ai/node_modules packages/ai/node_modules
COPY --chown=node:node --from=deps-prod /app/packages/db/package.json packages/db/package.json
COPY --chown=node:node --from=deps-prod /app/packages/db/node_modules packages/db/node_modules
COPY --chown=node:node --from=deps-prod /app/packages/db/prisma packages/db/prisma

# Compiled JavaScript (and the .ts it sits beside — package.json "exports" still points there,
# and resolution needs the file to exist even though docker/resolve-hooks.mjs redirects every
# read to the compiled sibling before anything tries to load the .ts; see Dockerfile header).
COPY --chown=node:node --from=build /app/apps/api/src apps/api/src
COPY --chown=node:node --from=build /app/apps/workers/src apps/workers/src
COPY --chown=node:node --from=build /app/apps/mcp/src apps/mcp/src
COPY --chown=node:node --from=build /app/packages/domain/src packages/domain/src
COPY --chown=node:node --from=build /app/packages/query-planner/src packages/query-planner/src
COPY --chown=node:node --from=build /app/packages/ai/src packages/ai/src
COPY --chown=node:node --from=build /app/packages/db/src packages/db/src
COPY --chown=node:node --from=build /app/packages/db/seed packages/db/seed
COPY --chown=node:node --from=build /app/apps/web/dist apps/web/dist

COPY --chown=node:node docker/resolve-hooks.mjs docker/register-hooks.mjs docker/
# Replaces the real (pruned-away) tsx devDependency at the two paths deploy.yml and
# docs/runbooks/deploy.md invoke it from; see docker/tsx-shim.mjs.
COPY --chown=node:node docker/tsx-shim.mjs apps/api/node_modules/.bin/tsx
COPY --chown=node:node docker/tsx-shim.mjs apps/workers/node_modules/.bin/tsx

ENV NODE_ENV=production \
    WEB_DIST=/app/apps/web/dist \
    PORT=8080 \
    NODE_OPTIONS="--import /app/docker/register-hooks.mjs"
USER node
WORKDIR /app/apps/api
CMD ["node", "src/main.js"]
