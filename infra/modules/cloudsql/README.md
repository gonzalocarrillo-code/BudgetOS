# cloudsql

Puts the production Postgres instance (`budgetos-db`) and the uploads bucket
(`dmus-gonzalo-budgetos-uploads`) under Terraform (docs/STACK_AUDIT_2026-10-04.md B-1, B-4; ADR-065,
ADR-017). Both were created once by hand (`docs/runbooks/deploy.md` "One-time setup") and have run
unmanaged since. This module does not recreate them: it adopts the live resources with `import`
blocks, then applies the hardening the audit asked for.

## What changes on first apply

Read live with `gcloud sql instances describe budgetos-db --project dmus-gonzalo` and
`gcloud storage buckets describe gs://dmus-gonzalo-budgetos-uploads` (2026-10-05):

| Setting | Live | This module |
|---|---|---|
| `backup_configuration.point_in_time_recovery_enabled` | not set (false) | `true` |
| `backup_configuration.backup_retention_settings.retained_backups` | 7 | 35 |
| `backup_configuration.transaction_log_retention_days` | 7 | 7 (unchanged; required for PITR) |
| `deletion_protection` (Terraform) / `settings.deletion_protection_enabled` (GCP) | off | `true` |
| Bucket `versioning.enabled` | off | `true` |
| Bucket lifecycle rules | none | delete `exports/*` after 7 days (ADR-017); delete noncurrent versions after 30 days |

Everything else — `ZONAL` availability, `db-g1-small` tier, `PD_SSD` 10 GB autoresizing disk,
public IP, Postgres 16, `ENTERPRISE` edition, the bucket's uniform access / enforced
public-access-prevention / 7-day soft-delete policy — is pinned to the live value so the first
`terraform plan` after import shows only the hardening diff above, not a destroy/recreate.

## Import (project owner only; do not `terraform apply` as this change's author)

```bash
cd infra/envs/dmus-gonzalo
terraform init
terraform plan   # the import blocks make this a plan to adopt + harden, not create
terraform apply  # project owner decides when; this flips PITR, retention and deletion protection on
```

Terraform ≥ 1.5 `import` blocks for the three resources below live in
`infra/envs/dmus-gonzalo/main.tf`, not in this module — Terraform rejects an `import` block inside
a child module ("Import blocks are only allowed in the root module"), so the root env config is
the one place they can live, addressed through the module (`module.cloudsql.<resource>`):
- `google_sql_database_instance.budgetos_db` ← `dmus-gonzalo/budgetos-db`
- `google_sql_database.budget` ← `dmus-gonzalo/budgetos-db/budget`
- `google_storage_bucket.uploads` ← `dmus-gonzalo-budgetos-uploads`

If a plan ever proposes replacing the instance or the bucket instead of updating them in place,
stop — that means a live setting drifted from the defaults in `variables.tf` (e.g. `edition`,
`tier`, `location`) and the fix is to update the variable to match reality, not to let the apply
run. Both resources carry `lifecycle { prevent_destroy = true }` as a backstop.

## Login roles and users

`google_sql_user` resources are intentionally not in this module. `budget_app`, `budget_publisher`
and `budget_mcp` are created and owned by the hand-written SQL migrations in `packages/db`
(spec §3; AGENTS §4 "SQL strings live only in `packages/db`"), not by Terraform. This module only
owns the instance and the `budget` database it contains.

## Private IP (out of scope here)

The instance is public-IP only (`ipv4_enabled = true`, no `private_network`). Moving it behind a
VPC with a private IP — which `infra/modules/datastream` already assumes for its own peering — is
a separate, larger change (new VPC, Cloud SQL Auth Proxy or VPC connector wiring for Cloud Run, a
maintenance window) and is out of scope for this hardening item. Track it before the Datastream
replica (`infra/modules/datastream`, `infra/modules/bigquery`) is actually turned on in this
project: today neither is applied to `dmus-gonzalo` (only the unrelated `budgetos_closures`
dataset exists, owned by the closures sink, ADR-018).

## Backups and recovery

See `docs/runbooks/restore.md` for the clone-from-PITR procedure, the backup-restore procedure,
migration rollback, and the drill log. See `docs/adr/0065-hosting-on-dmus-gonzalo.md` ("Backups
and recovery" addendum) for the decision record.
