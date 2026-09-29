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
