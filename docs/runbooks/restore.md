# Restore (B-1, ADR-0080 "Backups and recovery")

Cloud SQL `budgetos-db` (Postgres 16, `dmus-gonzalo`) is the only system of record; everything else
(BigQuery `budgetos_closures`, the search index, `rollup_cache`) is derived and can be rebuilt. This
runbook is how to get `budgetos-db` back after data loss or a bad deploy. See
`infra/modules/cloudsql/README.md` for what the Terraform module manages and
`docs/adr/0065-hosting-on-dmus-gonzalo.md` for the decision this runbook implements.

## (a) RPO / RTO

| | Point-in-time recovery on (this change) | Before this change |
|---|---|---|
| **RPO** (how much you can lose) | Minutes — PITR replays the transaction log up to any second in the last 7 days (`transaction_log_retention_days`) | Up to 24 h — only the daily 07:00 UTC backup existed |
| **RTO** (how long to be back up) | ~30–60 min: clone (10–20 min for a 10 GB `db-g1-small` instance) + verify + swap secrets + redeploy | Similar, but starting from a backup up to a day old |

These are estimates, not measured — the first real number comes from the first drill (table below).

## (b) Point-in-time clone (preferred: data loss, bad data from a bug, or a bad migration that already committed rows)

A clone is a **new, independent instance**; it does not touch `budgetos-db`. Verify on it before
anything in production points at it.

1. **Pick the UTC timestamp to recover to** — just before the bad write or the incident started.
   PITR only reaches back `transaction_log_retention_days` (7) from now; `gcloud sql backups list
   --instance=budgetos-db --project dmus-gonzalo` shows how far daily backups go back (up to 35
   with this change).

2. **Clone**:
   ```bash
   CLONE=budgetos-db-pitr-$(date -u +%Y%m%dT%H%M%S)
   gcloud sql instances clone budgetos-db "$CLONE" \
     --project dmus-gonzalo \
     --point-in-time '2026-10-05T14:30:00Z'
   ```
   (`gcloud sql instances clone SOURCE DESTINATION --point-in-time=...` — PostgreSQL clones always
   take a timestamp, not binlog coordinates; omit `--point-in-time` to clone the current state
   instead, e.g. to get a working copy for a schema experiment.)

3. **Wait for it, then get its connection name**:
   ```bash
   gcloud sql operations list --project dmus-gonzalo --instance="$CLONE" --filter='status!=DONE'
   gcloud sql instances describe "$CLONE" --project dmus-gonzalo --format='value(connectionName,state)'
   ```

4. **Verify the clone before anything points at it.** The clone carries the same databases, roles
   and passwords as the source, so the existing app credentials work against it. Connect with the
   [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy) rather than opening
   the clone's IP:
   ```bash
   cloud-sql-proxy "dmus-gonzalo:us-central1:$CLONE" --port 5433 &
   APP_PW=$(gcloud secrets versions access latest --secret=budgetos-app-database-url --project dmus-gonzalo)  # has the current password embedded
   psql "postgresql://budget_app:<password from the DSN above>@127.0.0.1:5433/budget" \
     -c "select count(*) as migrations from _prisma_migrations;" \
     -c "select count(*), max(occurred_at) from audit_event;"
   ```
   Compare both numbers against the same two queries run against `budgetos-db` itself. `id` on
   `audit_event` is a UUID (not sequential, see `packages/db/prisma/migrations/.../migration.sql`
   "Audit (partitioned by month on occurred_at)"), so use `count(*)` + `max(occurred_at)` as the
   freshness check, not "max id".
   Then a `/query` smoke test against the clone, still through the proxy:
   ```bash
   DATABASE_URL="postgresql://budget:<admin password>@127.0.0.1:5433/budget" \
   APP_DATABASE_URL="postgresql://budget_app:<password>@127.0.0.1:5433/budget" \
     pnpm --filter @budget/api exec tsx src/main.ts &
   curl -s -X POST localhost:3000/api/v1/workspaces/<a-real-workspace-id>/query \
     -H 'content-type: application/json' -d '{"measures":["spend"]}' | jq '.totals'
   ```
   A sane `totals.spend` and no 5xx means the clone is usable.

5. **Cutover (only once the clone is verified, and only for a real incident — not for a drill,
   which stops after step 4 and tears the clone down).** Two things point at `budgetos-db` today
   and both must move together:
   - `.github/workflows/deploy.yml` hardcodes `SQL: dmus-gonzalo:us-central1:budgetos-db`, the
     socket every service mounts via `--add-cloudsql-instances`/`--set-cloudsql-instances`.
   - The three DSN secrets (`budgetos-database-url`, `budgetos-app-database-url`,
     `budgetos-mcp-database-url`) encode the same connection name.

   ```bash
   # 1. Point the workflow's socket at the clone (edit deploy.yml's SQL: line to $CLONE, commit,
   #    push to main through the team's normal fast-path for an incident).

   # 2. Swap the three DSNs to the clone, keeping their existing user/password:
   for s in budgetos-database-url budgetos-app-database-url budgetos-mcp-database-url; do
     cur=$(gcloud secrets versions access latest --secret="$s" --project dmus-gonzalo)
     new=$(echo "$cur" | sed "s/budgetos-db/$CLONE/")
     printf %s "$new" | gcloud secrets versions add "$s" --project dmus-gonzalo --data-file=-
   done

   # 3. Redeploy (push triggers deploy.yml; to force it without a new commit):
   gh workflow run deploy.yml --repo <org>/BudgetOS
   ```

6. **Verify again** against the live URL: `gcloud run jobs executions list --job budgetos-migrate
   --project dmus-gonzalo --region us-central1` (migrations ran clean), the same `_prisma_migrations`
   count and `audit_event` freshness check as step 4 run through the app, and a real `/query` call
   against `https://budgetos-app-666309304754.us-central1.run.app`.

7. **Make it permanent or roll back.** If the clone stays as production: update
   `infra/modules/cloudsql/variables.tf`'s `instance_name` default and the import block in
   `infra/envs/dmus-gonzalo/main.tf` to `$CLONE` (or rename in a follow-up once the old instance is
   decommissioned), and plan deletion of the old `budgetos-db` only after a final backup and a
   waiting period. If the incident turns out not to need the cutover, delete the clone and leave
   `budgetos-db` as the system of record.

## (c) Restore from a daily backup (source instance itself is gone or corrupted; no good PITR window)

```bash
gcloud sql backups list --instance=budgetos-db --project dmus-gonzalo   # find the ID / NAME to use
gcloud sql backups restore <BACKUP_ID> --restore-instance=budgetos-db --project dmus-gonzalo
```
This restores **in place** — it overwrites `budgetos-db` with the backup and cannot be undone; there
is no secret-swap or redeploy step because the instance and its connection name don't change. Needs
`--project` (not implied) and the backup ID from `gcloud sql backups list` (it also accepts the
backup `NAME` for restoring into a different instance, in which case add `--backup-instance=budgetos-db`
so the target in `--restore-instance` can be a fresh instance instead of overwriting production —
prefer this when there is time, same verification as (b) step 4, then follow (b) steps 5–7 to cut
over).

## (d) Migration rollback

Migrations run **before** the new code deploys (`.github/workflows/deploy.yml`: `budgetos-migrate`
job, then `budgetos-app`/`budgetos-slack`/`budgetos-worker`). This is why every migration must be
expand/contract safe: the *previous* revision serves the *new* schema for the minutes between the
migration job finishing and the new revisions rolling out, and if the deploy fails after migrating,
the previous revision keeps serving the new schema indefinitely until the next successful deploy.
**Never drop or rename a column/table the currently-deployed code still reads in the same PR that
adds its replacement** — add in one PR, backfill, deploy the code that stops using the old shape,
then drop in a later PR (AGENTS §4, spec §3).

If `budgetos-migrate` fails partway:
1. Read the failure: `gcloud run jobs executions list --job budgetos-migrate --project dmus-gonzalo --region us-central1`, then that execution's logs.
2. If the migration's SQL did not actually apply (failed before or during its own statements),
   mark it rolled back so the next run retries it:
   ```bash
   # via the Cloud SQL Auth Proxy, as in (b) step 4
   DATABASE_URL="postgresql://budget:<admin password>@127.0.0.1:5433/budget" \
     pnpm --filter @budget/db exec prisma migrate resolve --rolled-back <migration_name>
   ```
3. If the SQL *did* apply (e.g. it failed on the bootstrap step after the SQL succeeded) but
   `_prisma_migrations` doesn't reflect it, mark it applied instead so Prisma doesn't try it again:
   ```bash
   DATABASE_URL="postgresql://budget:<admin password>@127.0.0.1:5433/budget" \
     pnpm --filter @budget/db exec prisma migrate resolve --applied <migration_name>
   ```
4. Fix the root cause, re-run the deploy workflow. Because every migration is `IF NOT EXISTS` /
   idempotent (AGENTS §3), a clean re-run of `prisma migrate deploy` is always safe.
5. There are no down migrations (M-2) — a migration that must be undone is undone by writing and
   applying a new forward migration that reverses it, never by editing or deleting the applied one.

## (e) Drills

A drill is: clone from PITR to a UTC timestamp from a few hours earlier, run the verification in
(b) step 4, record RTO (time from "start clone" to "clone verified"), then delete the clone. No
cutover, no production impact.

| Date | Who | Scenario | Result |
|---|---|---|---|
| — | — | — | pending — first drill |

## (f) What is NOT backed up by any of this

- **Redis** (query cache, rate limits) and the in-process preview store (W1-5 moves previews to
  Postgres) — purely ephemeral; losing them loses nothing durable, at worst a slower next request
  or an expired bulk-edit preview.
- **The uploads bucket's history beyond 7 days** until the lifecycle/versioning in
  `infra/modules/cloudsql` (B-4) is actually applied: today `gs://dmus-gonzalo-budgetos-uploads` has
  no versioning and no lifecycle rules, only the default 7-day soft-delete window, so an overwritten
  or deleted upload is unrecoverable after a week.
- **BigQuery** (`budgetos_closures`): closure snapshot tables are a one-way export, not backed up
  here; a closure can be re-run from Postgres if needed (`docs/runbooks/closures.md`).
- **Anything outside `dmus-gonzalo`**: Slack message history, the user's OpenAI account, GitHub.
