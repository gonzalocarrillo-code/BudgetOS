# Local stack (localhost, persistent)

`pnpm dev:local` runs Budget OS on your machine, and it survives restarts.

| What | Where |
|---|---|
| Web | http://localhost:5173 (signed in as the golden admin) |
| API | http://127.0.0.1:3000 |
| JWKS (local test issuer) | http://127.0.0.1:4800/jwks |
| Ingest runner | 127.0.0.1:4700 (runs queued ingest runs of the `local` workspace) |

- **Data:** one golden workspace with slug `local`, seeded on the first start and reused after. Your changes stay. `pnpm db:reset` starts over.
- **Sign-in:** tokens are signed by a key kept in `apps/web/e2e/.auth-local/` (gitignored), so they stay valid across restarts.
  - `tokens.json` in that folder has a one-year token for every persona: admin, orgAdmin, planner, budgetOwner, approver, finance1, finance2.
  - The dev server signs in as admin. Sign out, then paste another persona's token to act as them.
- **Closing a period** works locally (`CLOSURE_SINK=memory`). The frozen rows live only in that API process.
- **Needs:** Postgres and Redis from `packages/db/.env` (and `REDIS_URL`), Node 22.
- **Stop:** Ctrl-C (or stop the "local" preview). The data is kept.
- **The Playwright stack** (`pnpm test:e2e`, `e2e:stack`) is separate: fresh workspace, new key, other ports.
