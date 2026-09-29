# Runbook: the Slack bot

The bot posts alerts and approval requests, sends each request to its approvers and its outcome to the requester by direct message, and people act from Slack as their own BudgetOS account: Approve, Request changes and Reject on requests; Acknowledge, Snooze and Resolve on alerts; `/budget` for answers. Design: ADR-046 and `docs/SLACK_TOOLSET_PLAN.md`. Delivery and in-app notifications: `docs/runbooks/notify.md`.

## 1. Create the Slack app (once per environment)

One Slack app per Budget OS environment: **BudgetOS (dev)** for a laptop through a tunnel, **BudgetOS** for staging and production. Each has its own signing secret and bot token, and each environment holds the pair of the app that points at it.

1. **Get the manifest.** Admin › Slack › *Copy the manifest*, in the environment the app is for. It already carries that environment's URLs. For another URL: `pnpm -s slack:manifest --url https://<api host>`.
2. **Create the app.** api.slack.com/apps → *Create New App* → *From a manifest* → the agency's Slack workspace → paste → *Create*.
3. **Check the scopes.** The manifest asks for exactly these, and nothing else:

| Scope | Why | Slack calls |
|---|---|---|
| `commands` | the `/budget` command | the slash-command payload |
| `chat:write` | posting and editing channel posts and direct messages | `chat.postMessage`, `chat.update` |
| `im:write` | direct messages to approvers, requesters and mentioned people | `conversations.open`, then `chat.postMessage` there |
| `users:read`, `users:read.email` | who clicked or typed, by their profile email; finding a person for a direct message | `users.info`, `users.lookupByEmail` |

   No scope is needed for `auth.test` (linking) or `views.open` (the forms). The bot does not have `chat:write.public`: it posts only in channels it was invited to.

4. **Install it.** *Install App* → *Install to Workspace* → *Allow*. A Slack workspace that requires approval for new apps sends the request to its Slack admins (*Manage apps › Requests*); nothing works until they approve, so ask them first. After any scope change, Slack asks to reinstall.
5. **Copy the two credentials.**
   - *Basic Information › App Credentials › Signing Secret* → `SLACK_SIGNING_SECRET`.
   - *OAuth & Permissions › Bot User OAuth Token* (`xoxb-…`) → `SLACK_BOT_TOKEN`.

   Locally they go in `packages/db/.env` (gitignored); on GCP in Secret Manager (§6). Never in the repository or a chat. Admin › Slack only shows whether each is set.

## 2. Environment

| Variable | Read by | Value |
|---|---|---|
| `SLACK_BOT_TOKEN` | API, notify worker (local runner) | the app's `xoxb-…` token |
| `SLACK_SIGNING_SECRET` | API | the app's signing secret |
| `API_PUBLIC_URL` | API (the manifest, Admin › Slack) | what Slack calls: the tunnel or the load balancer, no trailing slash |
| `APP_BASE_URL` | API, notify worker | the web app, for links in messages (`http://localhost:5173` locally) |

The API reads the token once: restart after changing it. The worker warns at start when the token is set without `APP_BASE_URL`, because links would point at `https://budget-os.example`.

## 3. Local development (a tunnel)

Slack must reach the API over HTTPS. Deployed environments need no tunnel (§6).

1. `brew install ngrok`, sign up at ngrok.com (free), `ngrok config add-authtoken <token>`, and claim the free static domain (*Domains* in the ngrok dashboard). A static domain keeps the app's URLs the same every run.
2. `ngrok http --url=<name>.ngrok-free.app 3000` (the API; not Vite on 5173).
3. In `packages/db/.env`: the two credentials, `API_PUBLIC_URL=https://<name>.ngrok-free.app`, `APP_BASE_URL=http://localhost:5173`.
4. Restart `pnpm dev:local` from the checkout you are testing. Only one local stack can run: its ports are fixed.
5. **Your account.** The seeded personas have fake emails (`<persona>@local.golden.test`). Add yourself with your real Slack email and a role that decides (Org › People, or Admin › Roles in the workspace). For refusal checks, add a second person as VIEWER.

## 4. Channels, and who sees what

One Slack team (the agency's) serves every Budget OS workspace: the golden demo, OpenAI, each client. Each workspace is linked to the team in its own Admin › Slack.

- **Access is Budget OS's, not Slack's.** The bot finds the person's account by their Slack email and applies that account's roles in the workspace being acted on, exactly as the app and MCP do. Someone with a role only in OpenAI sees and does nothing in the golden workspace from Slack ("No role in this workspace"). A superadmin sees every workspace, and their audit rows say `superadmin`.
- **A channel is readable by all its members**, whatever their roles. So each client workspace gets its own **private** channel (`#budget-openai`) with only that client's team, and a shared channel only for workspaces everyone in it may see.
- **Invite the bot** to every channel it posts in: `/invite @BudgetOS`. For a private channel, paste its channel id (`C…`, from the channel's details) in Admin › Slack rather than its name.
- Direct messages go only to the approvers of the step a request waits on (and again when someone sends a reminder), the requester when it is decided, and the people a comment mentions, all in their own workspace. Admin › Slack can turn the approval ones off.

## 5. Link, test, and the live checklist

Admin › Slack → *Link to Slack* (records the team from `auth.test`) → set the default channel → *Send a test message*. Then:

- [ ] The test message arrives in the channel.
- [ ] A planner submits a change in the app; the channel gets "Approval requested" with Approve / Reject.
- [ ] Approve in Slack: the message becomes "Approved … by <you>"; the request is approved in the app; `approval_decision.channel = 'slack'`.
- [ ] Reject asks for a reason; the requester sees it in the app.
- [ ] Request changes asks what should change; the budget gets a blocking thread the requester resolves before sending it again.
- [ ] A VIEWER clicking Approve gets a private refusal; nothing changes.
- [ ] `/budget help`, `/budget`, `/budget approvals`, `/budget alerts`, `/budget <budget name>` answer, privately.
- [ ] `/budget request <budget name>` as a planner: the form opens; sending it creates a request, posted to the channel and sent to its approvers by direct message.
- [ ] `/budget approve #id` from an approver decides it; the channel post and the direct messages change to Approved.
- [ ] An unsigned or stale request to `/api/v1/slack/commands` is refused (403 in the API log).

```sql
SELECT decision, channel, decided_by, decided_at FROM approval_decision ORDER BY decided_at DESC LIMIT 3;
```

**When a URL changes** (a new tunnel domain, a new environment): regenerate the manifest (`pnpm -s slack:manifest --url …`) and paste it in the app's *App Manifest* page, or edit the request URLs under *Slash Commands* and *Interactivity & Shortcuts*.

## 6. GCP

The bot runs where everything else runs (spec §20): the API as `budget-api` and delivery in `notify-worker`, on Cloud Run.

- **Secrets:** `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` of that environment's app in Secret Manager, mounted as environment variables (`secret_env`) on `budget-api` (both) and `notify-worker` (the token).
- **Slack must reach `/api/v1/slack/*` without IAP**, since Slack has no Google identity: a path rule on the load balancer sends those paths to a backend with IAP off; everything else stays behind IAP. The routes accept only Slack-signed requests.
- **Pub/Sub:** one topic per entry of `OUTBOX_TOPICS` (`packages/domain/src/outbox-topics.ts`), with push subscriptions for the workers it names.
- **Three seconds:** keep one warm API instance (`min_instances = 1`) so a cold start never makes Slack time out.
- **Logs:** Slack requests carry request ids starting `slack-`.

The Terraform for this lands with T-008 (the GCP project); `docs/SLACK_TOOLSET_PLAN.md` §3.12 has the detail.

## 7. Commands

`/budget` answers only the person who typed it (an ephemeral reply). With roles in several linked workspaces, it answers for the one whose channel it was typed in, else the one they chose with `/budget workspace`, else the first by name.

| Command | Answers |
|---|---|
| `/budget` | your summary: the fiscal year so far, what waits on you, your budgets with pace |
| `/budget help` | this list |
| `/budget approvals` | the requests waiting on you, with Approve / Request changes / Reject; acting replaces the list with what is left |
| `/budget show #a1b2c3d4` | one request as a card: buttons if you may decide it, the reason if not |
| `/budget approve #a1b2c3d4 [comment]` | approves your step |
| `/budget reject #a1b2c3d4 <why>` · `changes #a1b2c3d4 <what>` | rejects, or returns it for changes (the reason is required) |
| `/budget withdraw #a1b2c3d4` · `remind #a1b2c3d4` | your own request: withdraw it, or remind its approvers (once an hour) |
| `/budget alerts` | open alerts you can see |
| `/budget search <text>` | budgets, approvals, alerts, targets |
| `/budget <budget name>` | the budget's card: where it sits, budget, spent, projected and pace over its dates, its open request and alerts. Several matches give a choice |
| `/budget request <budget name>` | a form for the budget's new amount and why; it goes through the approval policy (an admin's own change applies at once). A budget's card has the same "Request a change" button for people who may send one |
| `/budget workspace [name]` | which workspace answers you, with a button for each of yours; with a name, answer for that one from now on (a workspace's own channel still answers for it) |
| `/budget list [text]` | the top-level budgets this fiscal year (or yours, for a scoped role), or the budgets matching the text |

A request's id is on every request message (`Request #a1b2c3d4`): the last eight characters of its full id. A pasted link to the request works too.

A reply that says it could not be updated means Slack's link to that message expired (30 minutes, or five uses): the action stands; run the command again.

## 8. When something goes wrong

| Symptom | Cause and fix |
|---|---|
| Slack says "dispatch_failed" or "didn't respond" | Slack cannot reach the URL or the API took over three seconds: check the tunnel or the path rule, then the API log. |
| 403 in the API log for `/slack/*` | Wrong or missing `SLACK_SIGNING_SECRET`, a clock more than five minutes off, or a request not from Slack. |
| "Your Slack profile has no email Budget OS can match" / "No active Budget OS account…" | The Slack email does not match a Budget OS user: add the person with that email. |
| "This Budget OS workspace is not linked to your Slack workspace" | The workspace is linked to another team, or not linked: Admin › Slack › Link. |
| "No role in this workspace" | Working as designed: the person has no role there. |
| Nothing posts | No token (the worker logs "no SLACK_BOT_TOKEN"), no default channel, or the bot is not in the channel (`not_in_channel`: invite it). |
| Links open `budget-os.example` | `APP_BASE_URL` is not set for the worker. |
