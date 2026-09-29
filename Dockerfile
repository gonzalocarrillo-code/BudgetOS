# Budget OS on Cloud Run (ADR-065): one image for every service. The packages ship TypeScript and
# run with tsx, as in development; the SPA is built for IAP and served by the API (WEB_DIST).
#   budgetos-app     API + web, behind IAP           (default command)
#   budgetos-slack   the signed Slack routes, public  (PUBLIC_ROUTES=slack)
#   budgetos-worker  outbox handlers, pacing, Slack   (apps/workers/src/local-runner.ts)
#   budgetos-migrate migrations + bootstrap (job)     (see .github/workflows/deploy.yml)
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @budget/db exec prisma generate
RUN cd apps/web && VITE_AUTH_MODE=iap node_modules/.bin/vite build
ENV NODE_ENV=production WEB_DIST=/app/apps/web/dist PORT=8080
WORKDIR /app/apps/api
CMD ["node_modules/.bin/tsx", "src/main.ts"]
