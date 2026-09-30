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
