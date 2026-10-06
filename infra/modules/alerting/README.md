# alerting

Cloud Monitoring alert policies for the alerting half of `docs/STACK_AUDIT_2026-10-04.md` M-7 ("no
metrics, tracing, or alerting on worker failures or outbox backlog"), done as
`docs/STACK_HARDENING_PLAN.md` W5-8. One email notification channel plus six policies: worker
consumer failures, outbox dead-letters, API 5xx, migrate job failure, Cloud SQL backup failure, and
the worker dropping to zero instances. Each auto-closes after 7 days if it stops matching.

## Policies

| Policy | Resource | Fires when | Runbook |
|---|---|---|---|
| `worker_consumer_failures` | `budgetos-worker` logs | > 0 `local worker consumer failed` / `outbox row failed` ERROR lines in 10 min | `docs/runbooks/worker.md` |
| `outbox_dead_letters` | `budgetos-worker` logs | > 0 `outbox row failed` lines with `attempts >= outbox_max_attempts` in 1 h (see Assumptions) | `docs/runbooks/worker.md` "Listing/Replaying a dead-lettered row" |
| `api_5xx` | `budgetos-app` logs | > 5 responses with `httpRequest.status >= 500` in 5 min | `docs/runbooks/deploy.md` "Logs" |
| `migrate_job_failures` | `budgetos-migrate` job logs | > 0 ERROR+ lines in 5 min | `docs/runbooks/deploy.md` "When something fails" |
| `cloudsql_backup_failures` | Cloud SQL audit logs for `budgetos-db` | > 0 ERROR+ lines whose method mentions `backup` in 1 h | `infra/modules/cloudsql/README.md`, `docs/runbooks/restore.md` |
| `worker_zero_instances` | `budgetos-worker` Cloud Run instance-count metric | no data for 15 min (the metric stops reporting once a service has zero running instances) | `docs/runbooks/worker.md` |

All six: `combiner = "OR"`, one condition each, notify the email channel, `alert_strategy.auto_close
= var.auto_close_duration` (default 7 days), and a `documentation.content` pointing at the table
above plus the deploy/worker runbooks.

## Assumptions

- **No dedicated dead-letter log line exists yet.** `apps/workers/src/local-runner.ts`'s `runRow()`
  logs the same message — `"outbox row failed; consumers that succeeded are kept (processed_event
  dedupe), the rest retry with backoff"` — for every failed pass over a row, whether it is an
  ordinary retry or the one that sets `failed_at` (dead-letters it, `packages/db/src/outbox.ts`
  `markLocalFailure`). The only thing that distinguishes them in the log line is the `attempts`
  field, which equals `OUTBOX_MAX_ATTEMPTS` (`outbox_max_attempts`, default 8, matching the code's
  own default) exactly on the dead-lettering pass. `outbox_dead_letters`'s log-based metric filter
  therefore matches that exact message with `jsonPayload.attempts >= var.outbox_max_attempts`. If
  `OUTBOX_MAX_ATTEMPTS` is ever set to something other than this module's default in
  `.github/workflows/deploy.yml`, update `var.outbox_max_attempts` to match, or the dead-letter
  policy will under- or over-fire relative to `worker_consumer_failures`.
- **Cloud SQL backup failure uses a log filter, not a built-in metric.** The `cloudsql.googleapis.com/database/*` metric families (checked against the Google Cloud Monitoring provider's metric
  descriptors at the time of writing) describe CPU, memory, disk and replication state, not backup
  success/failure; there is no `backup_status` or similar gauge to alert on directly. The filter
  instead matches Cloud SQL audit log entries (`protoPayload.methodName=~"backup"`) at `severity>=ERROR`, which is the documented way operators surface a failed automated or on-demand backup.
  If GCP later ships a backup-outcome metric, prefer it — a metric-based condition does not depend
  on audit logging being enabled or on `protoPayload.methodName`'s exact spelling for backup RPCs.
- **`worker_zero_instances` depends on Cloud Run's own behavior of not emitting a `0` data point**
  for a revision with no running instances (it stops emitting the series instead), which is why
  this uses `condition_absent` rather than a threshold `< 1` — a threshold condition has nothing to
  evaluate once the series goes quiet.

## Follow-up (not in this PR)

The worker does not emit an outbox-backlog gauge (unpublished row count, how far behind it is)
today — `M-7`'s "no metrics ... on ... outbox backlog" is only partly closed by this module: these
policies catch failures and dead-letters, not a healthy-looking worker that is simply falling behind.
Two other open PRs (#174, #178) touch `apps/workers/src/local-runner.ts`; once one of them lands,
add a periodic `log.info({ backlogDepth, oldestUnpublishedAgeSeconds }, "outbox backlog")` (or
similar) pass, a matching `google_logging_metric` using a log-based **distribution** (not a count)
so it can threshold on the gauge value, and a `cloudsql_backup_failures`-style alert policy here.

## Validating

```bash
cd infra/envs/dmus-gonzalo
terraform init -backend=false
terraform validate
terraform fmt -check -recursive ../../modules/alerting
```

This module is instantiated from `infra/envs/dmus-gonzalo/main.tf` alongside `module "cloudsql"`. It
declares no `import` blocks (there is nothing live to adopt — every resource here is new) and no
`lifecycle { prevent_destroy = true }` (alert policies and notification channels are cheap to
recreate and carry no data), unlike `cloudsql`.

## Slack

An optional `google_monitoring_notification_channel` of type `slack` is included, commented out,
with the steps to configure it (the Slack app must be added to the target channel through the
Monitoring console first; Terraform cannot create that authorization by itself). This is a separate
Slack integration from the Budget OS app's own toolset (ADR-063) — this one is for the ops/infra
team, not end users.
