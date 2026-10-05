#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose down -v
docker compose up -d
# Guard against running reset on non-local databases (B-7, I-31)
pnpm --filter @budget/db exec tsx scripts/assert-local.ts
pnpm db:migrate
pnpm db:seed
