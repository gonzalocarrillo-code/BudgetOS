# Runbook: deployment on dmus-gonzalo (ADR-065)

Deploys happen only after `.github/workflows/ci.yml` succeeds on `main` (the `deploy` workflow triggers on that run's completion and checks `conclusion == success`); `.github/workflows/deploy.yml` then builds the image, runs `budgetos-migrate`, and deploys `budgetos-app`, `budgetos-slack` and `budgetos-worker`. Actions → deploy → Run workflow still redeploys by hand (`workflow_dispatch`), independent of CI state.

| What | Where |
|---|---|
| App (Google sign-in) | https://budgetos-app-666309304754.us-central1.run.app |
| Slack request URL | https://budgetos-slack-666309304754.us-central1.run.app/api/v1/slack/interactions (commands: `/api/v1/slack/commands`) |
| Database | Cloud SQL `budgetos-db`, database `budget` |
| Secrets | `budgetos-*` in Secret Manager |

## Image (W2-8, audit S-10/M-6)
The `Dockerfile` is multi-stage: `deps`/`build` do a full `pnpm install` (with devDependencies)
and compile every server-side package/app with `tsc`, in place — a `.js` file next to each
`.ts` file, not a separate `dist/` — see the Dockerfile header and `docker/build-server.sh` for
why. A second, independent `deps-prod` stage does a fresh `pnpm install --prod` and runs
`prisma generate` directly in it (copying the generated client from the full `build` stage does
not work: `@prisma/client`'s pnpm store path hashes differently with and without the
`typescript` devDependency present). The `runtime` stage copies only the pruned production
`node_modules`, the compiled output, and `apps/web/dist` onto a plain `node:22-slim`, and runs
as the image's built-in `node` user (non-root).

Every `@budget/*` package.json still points its `"exports"` at TypeScript source, unchanged, so
`pnpm dev`/`tsx`/`vitest` are unaffected by any of this. In the runtime image only,
`docker/resolve-hooks.mjs` (a Node module customization hook, registered once via
`NODE_OPTIONS=--import`) redirects that resolution from `.ts` to the compiled `.js` sibling.
`docker/tsx-shim.mjs` is copied over the (now-pruned) `node_modules/.bin/tsx` at the two paths
this runbook and `.github/workflows/deploy.yml` invoke it from, so every command below and in
that workflow keeps working unchanged — including the ad hoc `tsx src/deploy/slack-sandbox.ts`
run further down this page.

Measured locally (`docker build` on this repo; a laptop's Docker Desktop VM, not Cloud Run, so
treat the ratio rather than the absolute seconds as the signal): image size dropped from 2.12 GB
to 1.21 GB. Five interleaved `docker run` + poll-for-`GET /health 200` runs of each image, same
host and moment, with a throwaway `APP_DATABASE_URL`: the old single-stage (`tsx`-at-boot) image
averaged ~3.9 s, the new multi-stage (precompiled) image ~3.0 s (~25% faster; every run of the
new image was at or below the matching run of the old one). A plain `node` process outside Docker
entirely (no container virtualization overhead) showed a clearer gap: ~5.2 s precompiled vs.
~11.2 s under `tsx` — roughly half. The 25–30 s figure in the Dockerfile's own history (the
reason `budgetos-slack` keeps a warm instance) is a production Cloud Run cold start, which this
local setup cannot reproduce exactly; compiling ahead of time removes `tsx`'s JIT transpilation
from the request path regardless of environment.

## Give someone access
1. IAP: `gcloud iap web add-iam-policy-binding --project dmus-gonzalo --resource-type=cloud-run --service=budgetos-app --region=us-central1 --member=user:<email> --role=roles/iap.httpsResourceAccessor` (or `--member=domain:deptagency.com` for everyone at DEPT).
2. In the app, the superadmin adds them in Org console › People and gives them a role in a workspace. Without a user and role the app answers "Unknown or inactive user".

## Slack
1. Create the Slack app from the manifest in Admin › Slack, with the request URLs above.
2. Store the secrets:
   - `printf %s '<xoxb-…>' | gcloud secrets versions add budgetos-slack-bot-token --project dmus-gonzalo --data-file=-`
   - the same for `budgetos-slack-signing-secret`.
3. Run the deploy workflow once. It adds a secret to the services only when that secret has a value.
4. In Admin › Slack, link the Slack team and send the test message.

## OpenAI (mapping suggestions)
`budgetos-openai-api-key`, the same way. Without it the route answers 503.

## Logs
`budgetos-app` logs JSON (pino, W5-1, audit M-3): every line from a request carries `requestId`
(the incoming `X-Request-Id`, echoed back as a response header on every response including errors,
or a uuid main.ts minted when the caller sent none), and `workspaceId`/`actorId` once
`TenantInterceptor` resolves the caller — so a single request's lines, including the one line any
unhandled error logs at `error` with its stack, all share one `requestId`. To pull one request's
full trace in Cloud Logging:
```
resource.type="cloud_run_revision" resource.labels.service_name="budgetos-app"
jsonPayload.requestId="<id from the X-Request-Id response header, or from the error body>"
```
`Authorization`, `Cookie`, `X-Goog-Iap-Jwt-Assertion` and any `password`/`token`/`secret` field are
redacted (`[Redacted]`) before the line is written, not just before display — they are never in the
log store to begin with. `LOG_LEVEL` (`.env.example`) controls verbosity; default `info`.

## When something fails
- **Migrations:** `gcloud run jobs executions list --job budgetos-migrate --region us-central1 --project dmus-gonzalo`, then the execution's logs. For a partial failure or a rollback, see `docs/runbooks/restore.md` (d).
- **Worker:** logs of `budgetos-worker`. It must stay at one instance. See `docs/runbooks/worker.md`
  for how the poll loop retries, backs off and dead-letters a failing outbox row, and how to list
  and replay one (W1-2, ADR-010 Decision D-3: this loop is the production design, not a stand-in).
  Since W2-3 (audit S-2, S-3, S-21) it runs on two connections, neither the owner role:
  `PUBLISHER_DATABASE_URL` (secret `budgetos-publisher-database-url`, role `budget_publisher`) for
  the poll loop itself, `APP_DATABASE_URL` for the consumer handlers. The API also no longer falls
  back to `DATABASE_URL` if `APP_DATABASE_URL` is missing — it refuses to start instead.
- **"Unknown or inactive user" for the superadmin:** re-run the workflow. The bootstrap is idempotent.

## Before a risky migration

Take an extra backup first, on top of the daily one: `gcloud sql backups create --instance budgetos-db --project dmus-gonzalo`. See `docs/runbooks/restore.md` for how to recover if it goes wrong.

## One-time setup (done 2026-09-29)
The deployer may update only `budgetos-*` resources and never changes access, so these were done once, by hand, as a project owner:
- **Data resources:** Cloud SQL `budgetos-db` with database `budget`, the `budgetos-*` secrets (DB passwords and the three connection URLs — owner, app and publisher, the last added in W2-3), bucket `dmus-gonzalo-budgetos-uploads`, dataset `budgetos_closures`, Artifact Registry `budgetos`.

  The instance and the bucket are now *described* in `infra/modules/cloudsql` (B-1, B-4 in
  `docs/STACK_AUDIT_2026-10-04.md`) — point-in-time recovery, 35 retained backups, deletion
  protection, a versioned/lifecycle-managed bucket — but Terraform does not manage them yet. A
  project owner must adopt the live resources with the `import` blocks before the first
  `terraform apply`:
  ```bash
  cd infra/envs/dmus-gonzalo
  terraform init
  terraform plan    # the import blocks adopt the hand-created instance/database/bucket; confirm the
                     # diff is only the hardening in infra/modules/cloudsql/README.md, not a replace
  ```
  `terraform apply` is a deliberate decision for the project owner, not part of this setup step —
  see `infra/modules/cloudsql/README.md` and `docs/runbooks/restore.md`.
- **Accounts and GitHub:** service accounts `budgetos-runtime` and `budgetos-deployer` with their grants (ADR-065), and the workload identity pool `budgetos-github` with repository variables `GCP_WIF_PROVIDER` and `GCP_DEPLOYER_SA`.
- **First creation:** `budgetos-migrate`, `budgetos-app`, `budgetos-slack` and `budgetos-worker`, with the flags in `deploy.yml`.
- **Access:**
  - `gcloud beta run services update budgetos-app --iap`;
  - `roles/run.invoker` on `budgetos-app` for `service-666309304754@gcp-sa-iap.iam.gserviceaccount.com`;
  - `roles/iap.httpsResourceAccessor` for the superadmin;
  - `roles/run.invoker` for `allUsers` on `budgetos-slack`.

## MCP server (ADR-066)
- URL for MCP clients: `https://budgetos-mcp-666309304754.us-central1.run.app/mcp` (Streamable HTTP, OAuth). Adding it in Claude or the MCP Inspector opens Google sign-in, then an "Allow" page.
- Access is the same as the app: the person needs IAP access and an app user with a role. Tools are read-only.
- Signing key: `budgetos-mcp-oauth-key`. Adding a new version signs every MCP client out.

## Slack sandbox (test data for the bot)
`apps/api/src/deploy/slack-sandbox.ts` creates the workspace "Slack sandbox" (demo budgets) and a test user "BudgetOS Tester" (Planner). The superadmin gets Budget owner, Approver and Finance there. Each run adds approval requests from the tester (while budgets are free), three alerts, and comments that @mention the superadmin. Run it after Slack is linked; the worker marks events it cannot post as delivered.

```bash
gcloud run jobs execute budgetos-migrate --project dmus-gonzalo --region us-central1 --wait \
  --update-env-vars SANDBOX_CHANNEL=#budgetos-test \
  --args="-c,cd /app/apps/api && node_modules/.bin/tsx src/deploy/slack-sandbox.ts"
```

## Google sign-in (ADR-067)
Until the OAuth client exists, the app stays behind IAP. To switch:
1. In dmus-gonzalo: APIs & Services › Credentials › Create OAuth client ID › **Web application** (a Desktop client has no redirect URIs). Add the authorized redirect URI `https://budgetos-app-666309304754.us-central1.run.app/auth/callback`. The consent screen is the project's shared one ("DEPT BrandOS"); outside accounts need it External and In production.
2. Store the client:
   - `printf %s '<client id>' | gcloud secrets versions add budgetos-google-oauth-client-id --project dmus-gonzalo --data-file=-`
   - the same for `budgetos-google-oauth-client-secret`.
3. Once, as a project owner:
   - `gcloud beta run services update budgetos-app --project dmus-gonzalo --region us-central1 --no-iap`
   - `gcloud run services add-iam-policy-binding budgetos-app --project dmus-gonzalo --region us-central1 --member=allUsers --role=roles/run.invoker`
4. Run the deploy workflow. It sees the client secret and deploys session mode.
