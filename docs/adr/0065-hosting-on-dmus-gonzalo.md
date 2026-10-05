# ADR-065: Hosting on the dmus-gonzalo project, signed in by IAP

## Status
Accepted (product owner, 2026-09-29). Replaces the Identity Platform sign-in page for the deployed app; the multi-tenant infrastructure of spec §20 stays the target.

## Context
The owner hosts Budget OS in the GCP project `dmus-gonzalo`, which runs other systems, each in its own Cloud SQL, Cloud Run, storage and BigQuery. Budget OS must deploy from GitHub without touching them, and people sign in with their Google account ("login with Google IAM"), not by pasting an ID token.

## Decision
- **Sign-in is Identity-Aware Proxy on Cloud Run** (`budgetos-app`). IAP signs people in with Google; who may pass is IAM (`roles/iap.httpsResourceAccessor` on the service). The API runs with `AUTH_MODE=iap` and verifies IAP's ES256 assertion (`x-goog-iap-jwt-assertion`, issuer `https://cloud.google.com/iap`, audience `/projects/<number>/locations/us-central1/services/budgetos-app`). The web build (`VITE_AUTH_MODE=iap`) holds no token, and Sign out clears IAP's cookie. Passing IAP is not enough: the person must be an active user of the app with a role (added in the org console), as before.
- **One image, four Cloud Run resources, all `budgetos-*`:**
  - `budgetos-app`: the API, also serving the SPA (`WEB_DIST`), so one origin and no CORS. Behind IAP.
  - `budgetos-slack`: the same API with `PUBLIC_ROUTES=slack`. It answers only `/api/v1/slack/*` (Slack-signed) and `/health`, so Slack can call it without IAP.
  - `budgetos-worker`: the outbox loop (ingest, roll-ups, in-app and Slack notifications), and pacing every 15 minutes. Always on, internal ingress. It is the local runner with `LOCAL_WORKSPACE_PREFIX=` (every workspace of this single-tenant database).
  - `budgetos-migrate` (job): `prisma migrate deploy`, then `apps/api/src/deploy/bootstrap.ts`. The bootstrap sets the login roles' passwords from Secret Manager and makes the superadmin an `ORG_ADMIN` of the "DEPT" org.
- **Its own data resources:** Cloud SQL `budgetos-db` (Postgres 16), bucket `dmus-gonzalo-budgetos-uploads`, BigQuery dataset `budgetos_closures`, Artifact Registry `budgetos`, and `budgetos-*` secrets.
- **GitHub deploys through its own workload identity pool** (`budgetos-github`, this repository only) as `budgetos-deployer`. That account's Cloud Run admin role is limited by an IAM condition to resource names starting with `budgetos-`; it can write only to the `budgetos` registry. The runtime account `budgetos-runtime` reads only its secrets, bucket and dataset, and connects only to `budgetos-db` (conditioned Cloud SQL client).

## Consequences
- The Pub/Sub outbox publisher and push subscriptions (spec §19) are not used here; the worker polls the outbox. Its throughput is one instance, which is enough for one org.
- The MCP server is not deployed yet.
- `budgetos-slack` is public by design; every route on it checks Slack's signature.
- Operating notes are in `docs/runbooks/deploy.md`.

## Backups and recovery (2026-10-05)

`docs/STACK_AUDIT_2026-10-04.md` (B-1, B-4) found that `budgetos-db` and
`dmus-gonzalo-budgetos-uploads` were created once by hand with no Terraform, no restore runbook and
no recorded RPO/RTO. Reading the live settings (`gcloud sql instances describe budgetos-db`,
`gcloud storage buckets describe gs://dmus-gonzalo-budgetos-uploads`, both 2026-10-05) confirmed:
daily backups were on (7 retained, 07:00 UTC) but **point-in-time recovery was off**, **deletion
protection was off**, and the uploads bucket had **no versioning and no lifecycle rules** (only the
default 7-day soft-delete window).

**Decision:** turn point-in-time recovery on (7-day transaction log retention, the edition's
maximum), raise retained daily backups from 7 to 35, turn on deletion protection at both the
Terraform and the GCP level, and add versioning plus two lifecycle rules (delete `exports/` objects
after 7 days per ADR-017; delete non-current object versions after 30 days) to the uploads bucket.
Both resources move under Terraform (`infra/modules/cloudsql`), adopted via `import` blocks rather
than recreated, with ZONAL availability, `db-g1-small` and the public IP left unchanged — a private
IP migration is a separate, larger change and is out of scope here. `docs/runbooks/restore.md`
records the resulting RPO/RTO (PITR: RPO ≈ minutes, RTO ≈ 30–60 min; backup-only, as before this
change: RPO up to 24 h), the clone-from-PITR and restore-from-backup procedures, the migration
rollback procedure, and a drill log — empty until the first drill is actually run.

## Consequences (2026-10-05 addendum)
- `terraform apply` for `infra/modules/cloudsql` is a deliberate action for a project owner
  (`docs/runbooks/deploy.md` "One-time setup"), not automatic; this PR only adds the module and
  does not run it.
- The BigQuery replica and Datastream CDC pipeline (spec §20, D-001) are still not deployed to
  `dmus-gonzalo` — only the unrelated `budgetos_closures` dataset exists there — and
  `infra/modules/datastream` cannot be instantiated for this project until the private-IP migration
  above happens, since it assumes a VPC-peered Cloud SQL instance.
- The restore runbook's drill table has one open row ("pending — first drill"); scheduling that
  drill is tracked separately, not by this change.
