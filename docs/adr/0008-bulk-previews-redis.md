# ADR-008: Bulk edit previews in Redis, set-based commit

## Status

Accepted.

## Context

Spec §7.4 stores bulk previews in Redis for 30 minutes (key `bulk:<previewId>`) and asks for a 10k-row commit in one transaction, done in under 10 s (T-013). ADR-005 deferred a Redis client to "the first task that wires Redis". Port 6379 on the development machine belongs to another project.

## Decision

- **Preview store:** `PreviewStore` has two implementations.
  - `RedisPreviewStore` uses `@redis/client` (MIT), with `SET … EX 1800`. It's selected when `REDIS_URL` is set, which is every deployed environment.
  - `MemoryPreviewStore`, with the same TTL, is the fallback for local runs without Redis.
  - Its test (`preview-store.redis.test.ts`) runs when `REDIS_URL` is set. Locally that's `docker run -d --name budget-os-redis -p 127.0.0.1:6380:6379 redis:7-alpine`, with `REDIS_URL=redis://127.0.0.1:6380`.
- **Commit is set-based SQL in `packages/db` (`bulk.ts`):** row locks in id order, one `INSERT … SELECT unnest` for the versions, one statement for all phasing, one for the draft pointers, one for the per-envelope audit rows, plus one summary audit row and one outbox row.
- **Phasing:** each new version keeps its head's monthly shape. Months are rounded to the cent and the rounding difference goes on the last month, so the phasing sums exactly to the amount.
- **Nullable uuid arrays** are bound as `text[]` and cast to `uuid[]`, because Prisma binds an all-null array as `integer[]`.

## Consequences

- Measured on an M2 under load (load average ~11): 10,000 rows with 12 months of phasing each take 0.3–0.9 s to preview and 3.6–5.2 s to commit. Before the set-based rewrite, the same commit took 6–13 s.
- A preview can be committed only by its author, and only while every row's head version is unchanged. Otherwise the commit is a 409 listing the changed ids.
- Without `REDIS_URL`, previews live in one process. That's fine for `pnpm dev` and tests, but not for more than one API instance.
