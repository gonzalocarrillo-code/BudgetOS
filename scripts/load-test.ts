// The CI load job (spec §21, plan Appendix C, T-034). Not a laptop default: at spec scale it needs
// ~30 GB of disk and an hour. Run from the repo root with the API's tsx:
//   apps/api/node_modules/.bin/tsx --tsconfig apps/api/tsconfig.json scripts/load-test.ts
// Env: DATABASE_URL, APP_DATABASE_URL, REDIS_URL (packages/db/.env locally); LOAD_SHARDS (521 ≈ 100k
// leaves), LOAD_COMMENTS_PER_LEAF (10 ≈ 1M comments), LOAD_ITERATIONS (20), LOAD_REPORT (JSON path),
// LOAD_KEEP=1 to keep the workspace. Exit 1 when any Appendix C target is missed or a step fails.
// The job itself lives in the API package (it drives the API in-process): apps/api/src/load/main.ts.
import "../apps/api/src/load/main.ts";
