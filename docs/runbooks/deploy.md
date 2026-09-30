# Runbook: deployment on dmus-gonzalo (ADR-065)

Every push to `main` runs `.github/workflows/deploy.yml`: build the image, run `budgetos-migrate`, deploy `budgetos-app`, `budgetos-slack` and `budgetos-worker`. Actions → deploy → Run workflow redeploys by hand.

| What | Where |
|---|---|
| App (Google sign-in) | https://budgetos-app-666309304754.us-central1.run.app |
| Slack request URL | https://budgetos-slack-666309304754.us-central1.run.app/api/v1/slack/interactions (commands: `/api/v1/slack/commands`) |
| Database | Cloud SQL `budgetos-db`, database `budget` |
| Secrets | `budgetos-*` in Secret Manager |

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

## When something fails
- **Migrations:** `gcloud run jobs executions list --job budgetos-migrate --region us-central1 --project dmus-gonzalo`, then the execution's logs.
- **Worker:** logs of `budgetos-worker`. It must stay at one instance.
- **"Unknown or inactive user" for the superadmin:** re-run the workflow. The bootstrap is idempotent.

## One-time setup (done 2026-09-29)
The deployer may update only `budgetos-*` resources and never changes access, so these were done once, by hand, as a project owner:
- **Data resources:** Cloud SQL `budgetos-db` with database `budget`, the `budgetos-*` secrets (DB passwords and the two connection URLs), bucket `dmus-gonzalo-budgetos-uploads`, dataset `budgetos_closures`, Artifact Registry `budgetos`.
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
