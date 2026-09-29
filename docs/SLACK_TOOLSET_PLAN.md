# Slack as a working toolset: approvals, commands and budgets from Slack

Product feedback, round 10 (2026-09-29): "set up our Slack integration to work as a real toolset: approve or send approvals of budgets through Slack, through commands; approve and reject with buttons; view budgets with simple commands." What exists is in §1, what is missing in §2, the design in §3, tasks in §5, decisions for the product owner in §6, how it is verified in §7. Status rows live in `docs/TASKS_STATUS.md`.

Related: ADR-046 (the Slack bot, PR #71), ADR-015 (notify-worker Slack delivery, PR #24), `docs/runbooks/notify.md`, plan §6.3 and §8.5, Epic 2.2, spec §19 and §20, AGENTS.md §4 (audit + outbox, "never send Slack from a request handler").

## 0. The short answer

**The bot exists and is merged, but it has never talked to a real Slack app.** Round 3 (PR #71, ADR-046) built signed `/budget` and interaction endpoints, Approve / Reject buttons with a reject-reason form, alert buttons, the worker that posts and edits messages, and Admin › Slack with the app manifest. `docs/TASKS_STATUS.md` still lists T-021 as "blocked: live Slack workspace"; the local stack runs with no `SLACK_*` variables; neither `ngrok` nor `cloudflared` is installed on this machine.

Three things turn it into a toolset:

1. **Connect it for real, and fix what reading the code found** (Phase S1): a Slack app from the manifest, the two secrets, a tunnel to the API, a Budget OS account with your real Slack email, then a live checklist. Four bugs come with it: email case, a missing permission check on the Slack path, request types that never reach Slack, and an outbox topic nobody consumes.
2. **Complete approvals** (Phase S2): approvers get a direct message with the buttons, requesters get the outcome; Request changes and Withdraw from Slack; `/budget approvals` lists what waits on you; `approve`, `reject`, `changes` and `withdraw` as commands with short ids that fit in a message.
3. **Budgets by command, and a request from Slack** (Phases S3 and S4): `/budget` is your summary, `/budget <name>` is a budget card, `/budget list` the top-level budgets; `/budget request <name>` opens a form that creates a draft and sends it through the approval policy, exactly as the app would.

Phase S5 (hardening: replies within Slack's three seconds, an App Home tab) is optional and decided in §6. The Slack side is written out step by step in §3.10, who may see which workspace in §3.11, and the GCP hosting in §3.12: like the rest of the system, the bot runs on Cloud Run behind the load balancer; the tunnel in §3.9 is only for clicking buttons on a laptop before the GCP project exists. Nothing here changes how approvals work: Slack runs the same commands as the app, as the person's own account, with the same permissions, audit rows and outbox rows.

## 1. What exists, precisely

| Capability | Where | Notes |
|---|---|---|
| Signed Slack endpoints, no JWT | `apps/api/src/modules/slack/slack.controller.ts` (`POST /slack/interactions`, `POST /slack/commands`, permission `slack.signed`), `signature.ts`, `apps/api/src/common/tenant.interceptor.ts:44-47` | HMAC `v0=` over the raw form body, five-minute window. Form bodies keep their raw text (`configure-app.ts`); JSON bodies do not. |
| Who acts | `slack.service.ts` `slackAuth()` → `users.info` → `authenticateVerifiedEmail()` (`common/auth/authenticate.ts:61-79`) | The Slack user becomes the Budget OS account with the same email, in a workspace whose `settings.slack.teamId` is their Slack team. |
| Approve / Reject buttons | `slack.service.ts` `handleInteraction()`; `decide()` with `channel: "slack"` | Reject opens a modal asking for the reason. Refusals show in a small modal. |
| Alert buttons | same; `updateAlert()` | Acknowledge, Snooze (fixed seven days), Resolve. |
| `/budget` | `slack.service.ts` `handleCommand()` | `help`, `alerts`, `search <text>`, `<budget name>` (one line each from the search index). Ephemeral replies. Answers for the first linked workspace, alphabetically, where the person has a role. |
| Posting and editing | `apps/workers/src/notify/slack.ts`; `blocks/alert.ts`, `blocks/approval.ts`, `blocks/mention.ts` | New requests, escalations and outcomes post to the default channel; `slack_message` records channel and ts; `approval.changed` / `alert.changed` edit every recorded message. Mentions are DMs found by email. |
| Settings | `packages/domain/src/slack.ts` `SlackSettings` in `workspace.settings.slack`; `apps/web/src/routes/w.$ws.admin.slack.tsx` | Team link (`auth.test`), default and alerts channels, severities, the Approve / Reject toggle, a test message, setup steps with the manifest. |
| Configuration | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `API_PUBLIC_URL`, `APP_BASE_URL` (`packages/db/.env.example:11-16`) | Environment only, one Slack app per deployment. `pnpm dev:local` passes `packages/db/.env` to the API and the runner. |
| Local delivery | `apps/workers/src/local-runner.ts` | Polls the outbox for the notify topics and calls the real handlers; posts when the token is set. |
| Tests | `apps/api/src/modules/slack/slack.test.ts` (fake Slack, signed requests, golden workspace), `apps/workers/src/notify/notify.test.ts`, `blocks/blocks.test.ts` (snapshots), `apps/web/e2e/slack.spec.ts`, permission-matrix rows | Nothing runs against Slack itself. |

## 2. What is missing or wrong

Found reading the code on 2026-09-29; each becomes a task in §5.

| # | Finding | Where | Effect |
|---|---|---|---|
| a | Never connected: no Slack app, no secrets in `packages/db/.env`, no tunnel tool installed, the personas' emails are fake (`<persona>@local.golden.test`) | environment | Buttons and `/budget` have never been exercised live. |
| b | The Slack profile email is not lowercased before matching; `app_user.email` is stored lowercase and matched exactly | `slack-api.ts:25`, `access.repository.ts:33` | A profile with capitals finds no account. |
| c | The Slack path never calls `authorize()`; `decide()` checks step eligibility, not `approval.decide` | `slack.service.ts:176-184`, `authenticate.ts:82-94` | A PLANNER on a planner step can decide from Slack and is refused in the app (`ChainStep.role` allows PLANNER). |
| d | Bulk commits and structural requests (split, merge, end, reintroduce, import) create requests without an `approval.changed` outbox row | `envelopes/bulk/commit.ts`, `envelopes/commands/structure.ts` `routeStructural`; only `recordRequestChange` emits it | Those requests never post to Slack and never notify approvers in-app; only their outcome does. |
| e | `slack.settings.changed` has no consumer and the local runner does not poll it | `slack.service.ts:84`, `local-runner.ts:29` | Rows stay unpublished locally; a deployed publisher needs the topic to exist. |
| f | Approval requests go to the default channel only; approvers get no DM; requesters learn the outcome in-app only | `notify/slack.ts` `approvalPosts` | An approver who is not watching the channel is not told. |
| g | Request ids are UUIDs, nowhere shown in Slack | messages, `/budget` | Nothing to type in a command. |
| h | No Request changes, no Withdraw from Slack | `SLACK_ACTIONS` | Parity with the app's inbox is missing. |
| i | `/budget` picks the first linked workspace alphabetically; no way to choose | `slack.service.ts:210-242` | Wrong workspace for people in several. |
| j | Everything runs inside Slack's three-second window; `response_url` is never used | `handleCommand`, `handleInteraction` | Slow answers time out silently; ephemeral messages with buttons cannot be refreshed. |
| k | The worker posts to Slack inside the `handleOnce` transaction (15 s timeout) | `notify/slack.ts:242-289` | A slow Slack call rolls the dedupe row back; the post is repeated on redelivery (at least once, ADR-015). Accepted; noted. |
| l | The worker's default `APP_BASE_URL` is `https://budget-os.example` | `notify/slack.ts:238` | Links in messages are dead unless the variable is set. |

## 3. Design

### 3.1 Rules that do not change (ADR-046), and one that is added

- **Slack runs the app's commands as the person's own account.** Same permissions, scope, separation of duties, audit rows and outbox rows. New: every Slack action first calls `authorize(auth, <the route's permission>)`, so Slack refuses exactly what the app refuses.
- **The API never posts to a channel.** The notify worker posts and edits. **Added:** the API may answer *the interaction it is handling* through Slack's `response_url`: replace the ephemeral message that carried a button, or deliver a command's answer after acknowledging it. That is the reply to a request Slack made, not a channel post; it is valid for thirty minutes and five uses, and it needs no scope.
- **No new dependency.** `@slack/web-api` 8.1.1 stays. Bolt would own the HTTP server for signature checking and routing the API already has.
- **One Slack app per deployment, secrets in the environment.** OAuth "Add to Slack" with per-team tokens waits for a second client Slack (decision S9).

### 3.2 The command surface

Every reply is ephemeral: only the person who typed sees it. An error is the command's `DomainError.message`, the same text the app shows.

| Command | Answers | Runs (existing code) | Permission |
|---|---|---|---|
| `/budget` | Your summary: budget, spent, spent %, open alerts; what waits on you; the top-level budgets with pace | `getHome` (`modules/home/home.ts`) | `workspace.member` |
| `/budget <name>`, `/budget show <name>` | One budget's card: path, period, budget, spent, projected, spent %, pace, owner, status, the open request if any, open alerts. Buttons: Open budget, Request a change | `search` (type envelope) then `getEnvelope` + the planner totals over the subtree (the same query as Home's strip and MCP `get_budget`) | `envelope.read` |
| `/budget list [text]` | The top-level budgets (or those matching the text) with budget, spent, pace | Home's planner query / `search` | `envelope.read` |
| `/budget approvals` | Requests waiting on you, each with Approve / Reject / Changes / Review | `listApprovals({ assignee: "me" })` | `workspace.member` |
| `/budget show #id` | One request's card: what changes, who asked, which step, due date, buttons | `getApproval` | `envelope.read` |
| `/budget approve #id [comment]` | Approves the step | `decide` | `approval.decide` |
| `/budget reject #id <reason>` | Rejects | `decide` | `approval.decide` |
| `/budget changes #id <comment>` | Requests changes (opens the blocking thread) | `decide` | `approval.decide` |
| `/budget withdraw #id [comment]` | Withdraws your own request | `withdrawRequest` | `envelope.submit` |
| `/budget remind #id` | Tells the current step's approvers again (decision S3) | outbox `approval.reminded` → worker DMs | requester or admins |
| `/budget request <name>` | Opens the request form (§3.7) | `submitDraft` (new, §3.7) | `envelope.edit_draft` + `envelope.submit` |
| `/budget alerts` | Open alerts you can see (exists) | `listAlerts` | `envelope.read` |
| `/budget search <text>` | Budgets, approvals, alerts, targets (exists) | `search` | `workspace.member` |
| `/budget workspace [name]` | Which workspace answers you (§3.6) | `app_user.settings.slack` | any member |
| `/budget help` | The list above | | |

The parser is a zod schema in `packages/domain/src/slack.ts` (`SlackCommand`): verb, id, free text. Unknown verbs fall back to `<name>`, as today.

### 3.3 Buttons, and keeping messages current

| Message | Buttons |
|---|---|
| Approval request (channel post, DM, `/budget approvals` row, `/budget show #id`) | Approve (primary), Reject (danger, reason form), Request changes (comment form), Review (link) |
| Approval outcome | Open (link) |
| Budget card | Open budget (link), Request a change (form, hidden without `envelope.submit` in scope) |
| Alert | Acknowledge, Snooze, Resolve, Open alert, Open budget (unchanged; snooze length is decision S8) |
| Disambiguation ("which budget?") | One button per candidate (`budget.show`) |

Channel posts and DMs are recorded in `slack_message` and edited by the worker when the request changes, from Slack or from the app (exists). Ephemeral messages cannot be edited by the worker, so the interaction handler replaces them through the interaction's `response_url` ("✅ Approved · #a1b2c3d4 · Open"). Buttons disappear once there is nothing left to do (exists).

Double clicks and late clicks are already safe: `decide()` answers `CONFLICT` ("You already decided this step", "Request is APPROVED") and the person sees that message.

### 3.4 Short ids

`#` followed by the last eight hexadecimal characters of the request id. Ids are UUID v7 (`@budget/domain/ids`): the head is the time, so it repeats for requests made in the same minute; the tail is random, so eight characters tell requests apart. Shown in every Slack message and list. Commands accept `#a1b2c3d4`, `a1b2c3d4`, the full UUID, or a pasted Budget OS link (`/approvals/<uuid>`). Resolved with `right(id::text, 8)` among the workspace's requests (a new helper in `packages/db/src/approvals.ts`); two matches answer "say which: …". Nothing new is stored.

### 3.5 Who is told, and where (S2)

| Event | Channel | Direct messages |
|---|---|---|
| Request created or escalated | Default channel, with buttons (exists) | Each eligible approver of the current step: the list the in-app consumer already computes (`notify/in-app.ts` `stepApprovers`), found in Slack by email; with buttons; recorded in `slack_message` so the worker edits it too |
| Approved, rejected, changes requested, withdrawn | The original post is edited; a final outcome also posts (exists) | The requester (never the person who decided) |
| `/budget remind #id` | nothing | The step's approvers again (decision S3) |

- Admin › Slack gains one toggle, "Direct messages to approvers and requesters" (`SlackSettings.dms`, default on). Per-person opt-out and digests stay Epic 2.2.
- Every request type posts on creation: bulk, split, merge, end, reintroduce and import requests emit `approval.changed` with action `approval.requested`, as single-version, target and manual-entry requests already do (finding d). One audit row and one outbox row per request, in the creating transaction, like `submitVersion`.
- The approval card grows: budget path (`envelopePaths`), period, before → after in the envelope's currency with the delta %, the rationale, the dimension values, the step and the due date. Pure builder, snapshot-tested (ADR-015).

### 3.6 Identity and workspace choice (S3)

- **Remembered choice.** `app_user` gets a `settings` JSON column (default `{}`), mirroring `workspace.settings`; `settings.slack = { defaultWorkspaceId? }` (`SlackUserSettings` in `@budget/domain`), written only through the definer function `app_set_my_slack_settings`, and the place Epic 2.2 will put notification preferences. Decision S4 chooses this over a table. *As built (ADR-065):* identity stays the Slack email through a cached `users.info`; remembering the Slack user id was dropped, because row security exposes `app_user` only by Google id or email.
- **Which workspace answers `/budget`.** In order: the workspace whose default or alerts channel is the channel the command was typed in (`channel_name` in the payload against `SlackSettings` channels); else `settings.slack.defaultWorkspaceId`; else the only linked workspace where the person has a role; else the first alphabetically, with a footer "answering for *Local* · `/budget workspace <name>` to change". `/budget workspace` with no name lists the choices as buttons.
- Buttons carry `{ ws, id }` already, so a click always acts in the right workspace.

### 3.7 Sending a budget for approval from Slack (S4)

`/budget request <name>` (or the card's button) resolves the budget, then opens a modal (`views.open`, within the three seconds the trigger allows): the budget and its current amount, **New amount** (the envelope's currency; digits with optional thousands separators and decimals), **Why** (required, becomes the rationale). Submitting runs a new command `submitDraft(prisma, auth, envelopeId, { amount, rationale })` in `apps/api/src/modules/envelopes/commands/submit-draft.ts`: one transaction that writes the draft version (`version-writer.ts` helpers, based on the head version) and submits it (`submitVersionIn`). It is the same path as editing a cell and pressing Submit in the app:

- a planner's change becomes a PENDING request: "Sent for approval as #a1b2c3d4; the approvers were told" (the worker posts the request and DMs the approvers, §3.5);
- an admin's change applies directly (ADR-048, "Admins apply directly"): "Applied: USD 120,000 is the new budget";
- a draft already waiting → the modal shows "A request is already open (#…)" with a link; a closed period → the LOCKED message; out of scope → the FORBIDDEN message.

Period dates, phasing and structure stay in the app (decision S5). Audit and outbox: `envelope.version.created` and `approval.requested`, one pair each, in that transaction.

### 3.8 Hardening (S5, optional)

- **Three seconds.** A command races its work against a 2,500 ms timer: if the work wins, the reply is the answer; if the timer wins, the reply is "Working on it…" and the answer goes to `response_url` (ephemeral, `replace_original`). Slack API calls made by the handler get a two-second timeout. Elapsed time is logged with the request id.
- **App Home** (decision S6): the Events API needs a JSON content-type parser that keeps the raw body (`configure-app.ts`), `POST /slack/events` (`url_verification` echo; `app_home_opened` → `views.publish` of the same summary as `/budget`), the manifest's `app_home` feature and event subscription, an OpenAPI path and a permission-matrix row.
- **Manifest.** The bot's display name (decision S7), the `/budget` usage hint, `app_home` when S6 says so. Scopes stay `chat:write`, `chat:write.public`, `commands`, `users:read`, `users:read.email`, `im:write`; DMs need nothing more.

### 3.9 Local development: the tunnel, and the first live gate (S1)

- **Only for a laptop.** Deployed environments need no tunnel: Slack calls the load balancer (§3.12). Until T-008 gives a GCP project, the tunnel is the one way to click a button.
- **Tunnel.** `brew install ngrok`, a free ngrok account, its one static domain: `ngrok http --url=<name>.ngrok-free.app 3000`. `API_PUBLIC_URL=https://<name>.ngrok-free.app`. A quick tunnel (no account) changes its URL every run, so the Slack app's URLs would change every run: not recommended (decision S1).
- **Environment** in `packages/db/.env`, which `pnpm dev:local` passes to the API and the runner: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `API_PUBLIC_URL`, `APP_BASE_URL=http://localhost:5173`. Restart the stack: the API reads the token once. The stack must run from the branch under test (today it runs from `BudgetOS-real`, which is `main`).
- **The Slack app.** Admin › Slack → Copy the manifest → api.slack.com/apps → Create from a manifest → Install to the workspace → invite the bot to its channel (`/invite @Budget OS`) → bot token (OAuth & Permissions) and signing secret (Basic Information) into the environment. Creating and installing the app is the owner's action, in their Slack.
- **Account.** Add yourself to the `local` workspace with your real Slack email and a role that decides (Org › People or Admin › Roles; the personas' emails are fake). For refusal tests, a second person with VIEWER.
- **Link and test.** Admin › Slack → Link to Slack → default channel → Send a test message.
- **Checklist (the live gate for S-002; later phases add rows):** the test message arrives; a planner submits a change in the app and the channel gets "Approval requested" with buttons; Approve edits the message to "Approved … by you"; `approval_decision.channel = 'slack'`; Reject asks for a reason and the requester sees it; a viewer clicking Approve gets the refusal form; `/budget help`, `/budget alerts`, `/budget <name>` answer; a stale or unsigned request is refused (403 in the API log).
- `pnpm slack:manifest` prints the manifest with the current `API_PUBLIC_URL` (a twenty-line tsx script), for the times the tunnel changes.

### 3.10 The Slack side, step by step (S-002)

One Slack app per environment (decision S11): **BudgetOS (dev)**, whose URLs point at the tunnel, and **BudgetOS** for staging and production, whose URLs point at the load balancer (§3.12). Each app has its own signing secret and bot token, and each Budget OS environment holds the pair of the app that points at it. The manifest is the same JSON with different URLs: Admin › Slack copies it for the environment it runs in, and `pnpm slack:manifest --url https://…` prints it for any other.

1. **Create the app.** api.slack.com/apps → Create New App → *From a manifest* → choose the agency's Slack workspace → paste the manifest → Create. The manifest sets the bot user (name per S7), the scopes below, the `/budget` command with its request URL, and interactivity with its request URL. Socket mode, org-wide deployment and token rotation stay off.
2. **Check what it asks for.** The scopes are exactly these; nothing else is requested:

| Scope | Needed for | Slack calls |
|---|---|---|
| `commands` | `/budget` | the slash-command payload |
| `chat:write` | posting and editing channel posts and DMs | `chat.postMessage`, `chat.update` |
| `im:write` | opening a DM with an approver or a requester | `chat.postMessage` to a user id |
| `users:read`, `users:read.email` | who clicked or typed (their email), and finding a person for a DM | `users.info`, `users.lookupByEmail` |
| `chat:write.public` | posting in public channels the bot was not invited to | **dropped** (decision S10): every channel invites the bot, so nothing posts where nobody chose |
| no scope | linking a workspace to the team; opening the reject, changes and request forms | `auth.test`, `views.open` |
| no scope, App Home only (S6) | the Home tab | `views.publish`; the bot event `app_home_opened` |

3. **Install it.** *Install to Workspace* → the consent screen lists the scopes → Allow. A Slack workspace that requires approval for new apps sends the request to its Slack admins (*Manage apps › Requests*); nothing works until they approve, so ask them first.
4. **Copy the credentials.** *Basic Information › App Credentials › Signing Secret* → `SLACK_SIGNING_SECRET`. *OAuth & Permissions › Bot User OAuth Token* (`xoxb-…`) → `SLACK_BOT_TOKEN`. Locally they go in `packages/db/.env`; on GCP in Secret Manager (§3.12). Never in the repository, never in Admin › Slack, which only shows whether they are set.
5. **Channels.** One channel per Budget OS workspace (§3.11): a private one for a client (`#budget-openai`), a shared one for internal workspaces (`#budget-ops`), and optionally a separate alerts channel. Invite the bot to each (`/invite @BudgetOS`); this is required for private channels, and for every channel once `chat:write.public` is gone. In that workspace's Admin › Slack, set the default channel; for a private channel paste its id (`C…` or `G…`, from the channel's details) rather than its name.
6. **Link and test.** Admin › Slack → *Link to Slack* (records the team id from `auth.test`) → *Send a test message* → the checklist in §3.9.
7. **When a URL changes** (a new tunnel domain, a new environment): *App Manifest* in the app's settings takes the regenerated manifest in place; or edit the request URL under *Slash Commands* and *Interactivity & Shortcuts*.
8. **App Home** (only if S6 says now): the manifest adds `features.app_home.home_tab_enabled: true` and `settings.event_subscriptions` with the events URL and the bot event `app_home_opened`. Slack verifies the events URL with a `url_verification` challenge when the manifest is saved, so the API must be reachable at that moment.

### 3.11 Accounts: who sees which workspace, and how

One Slack team, the agency's, and many Budget OS workspaces: one per client account (the golden demo, OpenAI, the next client), every one of them linked to the same team id. **The bot has no access rules of its own.** It finds the person's Budget OS account by email, then applies that account's roles in the workspace in question, exactly as the app and the MCP server do. A workspace someone has no role in does not exist for them in Slack.

| Case | What the bot does |
|---|---|
| Roles in OpenAI only, types `/budget` | Answers for OpenAI, the one workspace where they have a role. A button on a golden post, or `/budget workspace golden`, is refused with "No role in this workspace"; nothing about golden is shown. |
| Roles in both | One workspace at a time, chosen as in §3.6: the channel the command was typed in, else their default, else asked. The footer says which. |
| A superadmin (org-wide ORG_ADMIN) | Every workspace, and every audit row they cause from Slack says `acting_as = superadmin` (ADR-052; S-001 adds the marking to the Slack path). |
| In Slack, but no active Budget OS account with that email | "No active Budget OS account for this Slack user's email." Nothing else is revealed. |
| From another Slack team (a Slack Connect guest, another company's workspace) | "This Budget OS workspace is not linked to your Slack workspace." The team id must match before anything is looked up. |
| A dimension scope inside a workspace (for example Brazil only) | The same scope checks as the app: lists and search are filtered by read scope, a request outside the scope answers "not an eligible approver", and a change outside it is refused. |

**Where a workspace's data appears.** Its posts go only to its own channels (default, alerts, or the rule's), and its DMs only to its own eligible approvers and requesters. The rule for channels: one private channel per client workspace, with only that client's team in it, and a shared channel only for workspaces everyone in it may see. A message in a channel is readable by the channel's members whatever their roles; the buttons still refuse anyone without a role, but the amounts in the text are visible. Two workspaces should not share a channel unless that is intended (decision S13).

**The checks, in order,** for the reviewer of any Slack change: Slack signature → team id → email → an active account in the same org → the workspace exists and is neither deleted nor archived → roles in that workspace → `authorize(<the route's permission>)` (S-001) → the command's own scope and eligibility checks → row-level security under `withTenant(ws)`, so a request id from another workspace is simply not found. `slack.test.ts` already covers another team and an unknown user; S-001 adds "no role in this workspace" and "a role in another workspace only"; S-010 adds channel inference and a refused workspace switch.

**Why access lives in Budget OS, not in Slack.** Roles are assigned once (Admin › Roles, Org › People) and cover the app, MCP and Slack. A Slack allowlist per workspace would be a second list to keep in sync (§4).

**Client people.** In this round everyone acts from the agency's Slack team, as members or guests. Letting a client act from their own Slack (a Slack Connect channel carries their team id, and their profile is only partly visible to our bot) is decision S12 and needs a spike first.

### 3.12 Hosting on GCP

The bot runs where the rest of the system runs (spec §20): the API as the `budget-api` Cloud Run service, message delivery in the `notify-worker` Cloud Run service fed by Pub/Sub push subscriptions, secrets in Secret Manager mounted as environment variables, the web app and the API behind the IAP load balancer. What Slack adds:

| Piece | What | Where |
|---|---|---|
| Secrets | `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` of the environment's app as Secret Manager secrets; `secret_env` on `budget-api` (both) and `notify-worker` (the token) | `infra/modules/cloudrun_service` (spec §20; to be written under T-008) |
| URLs | `API_PUBLIC_URL` = the load balancer's API host, `APP_BASE_URL` = the web host, plain environment variables on both services | same |
| Slack reaching the API | Slack calls `/api/v1/slack/*` with no Google identity, so those paths cannot sit behind IAP. The load balancer's URL map sends `/api/v1/slack/*` to a second backend service on the same `budget-api` serverless NEG with IAP off; everything else stays behind IAP. Those routes authenticate by Slack signature (exists) and nothing else is reachable through them | `infra/modules/iap` (spec §20), one path rule |
| Pub/Sub | Topics `budget-os.alert.triggered`, `alert.changed`, `approval.changed`, `thread.changed`, `slack.test`, `slack.settings.changed` and `approval.reminded` (S-004), each with a push subscription to `notify-worker` (OIDC, dead-letter). The publisher fails a whole batch on a missing topic (ADR-010), so the list of topics is generated from one source in `@budget/domain` that the API, the local runner and Terraform all read | `infra/modules/pubsub`, `packages/domain/src/outbox-topics.ts` (new) |
| Three seconds | A cold start of the API can exceed Slack's window: `min_instances = 1` for `budget-api` in staging and production; S-012's deferred replies cover slow answers | Terraform |
| Environments | dev = the tunnel and the dev app; staging and production = the load balancer hosts and their app; each environment's secrets are its app's | §3.10 |
| Logs | Slack requests carry request ids `slack-<uuid>`; in Cloud Logging, `jsonPayload.requestId =~ "^slack-"` finds them. Delivery failures surface as push retries and the dead-letter topic | `docs/runbooks/slack.md` |

**Dependency.** T-008 (the GCP project, Terraform state, WIF, IAP, Identity Platform) is pending, and `infra/` holds only the BigQuery and Datastream modules today. S-015 writes the Slack pieces inside the spec's modules when T-008 lands, and the GCP live gate repeats the §3.9 checklist against staging with that environment's app. Until then the tunnel in §3.9 is the only way to click a button, which is why S1 starts there.

## 4. Alternatives considered

| Option | Why not |
|---|---|
| Slack Bolt | Owns the HTTP server and routing; the API already verifies signatures and routes; one more dependency for what exists. |
| Socket Mode for local development (no tunnel) | Needs an app-level token and a long-lived WebSocket process, a second code path next to the HTTP one Cloud Run needs. A tunnel is one command. |
| OAuth install with per-team tokens in a table | Only needed when several Slack workspaces install the app; the org runs one. ADR-046 stands (decision S9). |
| A `slack_identity` table for the link and the default workspace | A JSON column on `app_user` mirrors `workspace.settings`, needs no RLS work, and is where notification preferences go next. |
| A per-workspace sequence number for requests | A new column and a counter; the UUID's random tail is free and unique enough. |
| Posting from the API when a button is clicked | ADR-046 and AGENTS.md §9: the worker posts and edits; `response_url` covers the one case (ephemeral messages) the worker cannot reach. |
| A Slack allowlist of who may use the bot, per workspace | Access is the person's Budget OS roles in that workspace, the same as the app and MCP; a second list would drift. |

## 5. Tasks

One PR per task, stacked per phase (`feat/slack-s1-fixes` → …), like rounds 6 to 8. The next free ADR number is 0060 (0059 is on `fix/pivot-totals`).

| Phase | ID | Task | Files | Done when |
|---|---|---|---|---|
| S1 | S-001 | Fixes: lowercase the Slack email; `authorize()` before every Slack action (`approval.decide`, `envelope.edit_draft` for alerts, `envelope.submit` for withdraw); the local runner polls `slack.settings.changed` and the worker acknowledges it; the worker warns at start when the token is set without `APP_BASE_URL`; the Slack path marks a superadmin `acting_as` like the JWT path (ADR-052) | `apps/api/src/modules/slack/slack-api.ts`, `slack.service.ts`, `apps/api/src/common/auth/authenticate.ts`, `apps/workers/src/local-runner.ts`, `notify/slack.ts`, `notify/main.ts` | `slack.test.ts`: a PLANNER on a planner step is refused from Slack as in the app; a person with a role only in another workspace is refused with "No role in this workspace"; `Planner@Example.com` is matched; an org admin acting from Slack in a workspace where they hold no role gets `actor_context = superadmin` on the audit row; the runner's topic list covers every topic the API writes |
| S1 | S-002 | Slack apps and the runbook: `docs/runbooks/slack.md` with the Slack-side steps (§3.10), the scopes and why, the access model (§3.11) and the checklist; `pnpm slack:manifest --url <api url>`; the manifest without `chat:write.public` (S10) and with the bot name (S7); the dev app through the tunnel; `.env.example` notes; Admin › Slack copy | `docs/runbooks/slack.md`, `packages/db/.env.example`, `apps/api/src/modules/slack/manifest.cli.ts`, `slack.service.ts` (the manifest), `package.json`, `packages/ui/src/i18n.ts`, `apps/web/src/routes/w.$ws.admin.slack.tsx` | The §3.9 checklist passes on the local stack against the owner's Slack with the dev app (a live gate, recorded like T-021's); a manifest test pins the scopes |
| S1 | S-003 | Every request type posts on creation: `approval.changed` (`approval.requested`) from bulk commit, `routeStructural` (split, merge, end, reintroduce, import) (targets and manual entry already do) | `apps/api/src/modules/envelopes/bulk/commit.ts`, `envelopes/commands/structure.ts`, `approvals/engine.ts` | `notify.test.ts`: a split request is posted with buttons and its approvers get in-app rows; the epic 1.4 acceptance asserts the audit + outbox pair |
| S1 | S-015 | GCP hosting (§3.12): Secret Manager secrets and `secret_env` for `budget-api` and `notify-worker`; `API_PUBLIC_URL` and `APP_BASE_URL`; the non-IAP path rule for `/api/v1/slack/*`; Pub/Sub topics and push subscriptions for the notify topics, generated from one list; `min_instances` for the API; the staging app | `infra/modules/cloudrun_service`, `infra/modules/iap`, `infra/modules/pubsub` (spec §20, new under T-008), `packages/domain/src/outbox-topics.ts`, `apps/workers/src/local-runner.ts`, `docs/runbooks/slack.md` | Blocked on T-008. Then: `terraform plan` clean in dev; the §3.9 checklist passes on staging with the staging app; an unsigned `POST /api/v1/slack/commands` through the load balancer is a 403 from the API, and `GET /api/v1/me` on the same host without a Google identity is redirected by IAP |
| S2 | S-004 | DMs: approvers on request and escalation, the requester on the outcome, recorded in `slack_message` and edited on change; the `dms` toggle; `/budget remind #id` (decision S3) | `apps/workers/src/notify/slack.ts`, `notify/in-app.ts` (export `stepApprovers`), `packages/domain/src/slack.ts`, `apps/web/src/routes/w.$ws.admin.slack.tsx`, `packages/ui/src/i18n.ts`, `apps/api/src/modules/slack/*` (remind) | `notify.test.ts`: two eligible approvers get a DM by email, the requester gets the outcome, the DM is edited when the request is approved, the toggle off sends none; remind writes audit + outbox and DMs again |
| S2 | S-005 | Request changes button and form; the richer card (path, period, delta %, rationale, dimension values, `#id`); snooze length per S8 | `apps/workers/src/notify/blocks/approval.ts`, `blocks/alert.ts`, `notify/slack.ts`, `packages/domain/src/slack.ts` (`SLACK_ACTIONS`), `slack.service.ts`, snapshots | Snapshots updated; `slack.test.ts`: request changes from Slack closes the request and opens the blocking thread |
| S2 | S-006 | `/budget approvals` and ephemeral flows: the list with buttons; `response_url` replacement after a click; `SlackActionValue.origin`; the Slack module split into `commands/`, `interactions.ts`, `respond.ts` (an injectable `response_url` client) | `apps/api/src/modules/slack/commands/approvals.ts`, `interactions.ts`, `respond.ts`, `blocks/` (API-side builders), `packages/domain/src/slack.ts` | `slack.test.ts` with a fake `response_url`: the list shows the golden pending request with buttons; Approve from the list decides and replaces the ephemeral message |
| S2 | S-007 | Decision commands: `approve`, `reject`, `changes`, `withdraw`, `show #id`; id resolution (short, UUID, link); the `SlackCommand` parser | `packages/domain/src/slack.ts`, `packages/db/src/approvals.ts` (find by suffix), `apps/api/src/modules/slack/commands/approvals.ts` | `slack.test.ts` covers each command, the refusals (not eligible, already decided, reason missing, not the requester) and a pasted link |
| S3 | S-008 | `/budget` summary from `getHome`: totals, waiting on me, top-level strip with pace, buttons | `apps/api/src/modules/slack/commands/summary.ts`, `blocks/summary.ts` | Snapshot and golden test; a viewer with no budgets in scope gets "nothing to show" not an error |
| S3 | S-009 | `/budget <name>` card and `/budget list [text]`: resolution by search, disambiguation buttons, the card from `getEnvelope` plus the subtree totals | `commands/budgets.ts`, `blocks/budget.ts` | Tests: exact name, ambiguous name (two candidates), unknown name, a viewer sees numbers but no Request button |
| S3 | S-010 | Workspace choice and the remembered link: `app_user.settings` (migration, `UserSettings`), `findBySlackUser`, channel inference, `/budget workspace [name]`, the footer, `PATCH /me` accepts `settings.slack.defaultWorkspaceId` | `packages/db/prisma/schema.prisma` + migration, `packages/domain/src/access.ts` or `home.ts`, `apps/api/src/common/auth/access.repository.ts`, `modules/auth/commands/*` (me), `modules/slack/identity.ts` | Tests: a command typed in workspace B's alerts channel answers for B; `/budget workspace openai` sticks across calls; the second call makes no `users.info` call (the fake counts) |
| S4 | S-011 | `/budget request <name>` and the card button → modal → `submitDraft` (draft + submit in one transaction); outcomes and errors in the modal | `apps/api/src/modules/envelopes/commands/submit-draft.ts`, `modules/slack/commands/request.ts`, `interactions.ts`, `packages/domain/src/slack.ts` (amount parsing) | `slack.test.ts`: a planner's request is PENDING with both audit + outbox pairs and the worker posts it and DMs the approver; an admin's applies directly; a pending draft is refused in the modal; `120,000`, `120000.50` parse, `12k` does not |
| S5 | S-012 | Deferred replies and timeouts (§3.8) | `modules/slack/respond.ts`, `slack-api.ts`, `commands/*` | A fake slow query gets "Working on it…" within three seconds and the answer through `response_url` |
| S5 | S-013 | App Home (decision S6): JSON raw-body parser, `POST /slack/events`, `views.publish`, manifest, OpenAPI, matrix row | `apps/api/src/configure-app.ts`, `modules/slack/slack.controller.ts`, `events.ts`, `openapi.ts`, `common/permission-matrix.test.ts` | A signed JSON event is verified and an unsigned one refused; `app_home_opened` publishes the summary (fake) |
| S5 | S-014 | ADR-060 (amends ADR-046: `response_url`, DMs, `app_user.settings`, commands, short ids), runbooks, `LOCAL_BUILD_PHASES.md` note that Epic 2.2's "interactive Slack approve/reject" is delivered, OpenAPI and web client regenerated | `docs/adr/0060-slack-toolset.md`, `docs/runbooks/notify.md`, `docs/runbooks/slack.md`, `docs/LOCAL_BUILD_PHASES.md`, `apps/api/openapi.json`, `apps/web/src/lib/api.gen.ts` | Merged with the round's last PR |

Every task: `pnpm typecheck && pnpm lint && pnpm test && pnpm license-check`, `docs/TASKS_STATUS.md` updated, the PR template in AGENTS.md §7. Any new route gets a permission and a permission-matrix row; any new write asserts its audit and outbox rows.

## 6. Decisions for the product owner

| # | Question | Default if unanswered |
|---|---|---|
| S1 | Tunnel for local development: ngrok with a free static domain, a `cloudflared` named tunnel, or test only on a deployed environment (needs the GCP project, T-008)? | ngrok, static domain |
| S2 | Direct messages: approvers on request and escalation, requesters on the outcome, on by default per workspace? | Yes, with the workspace toggle; per-person opt-out in Epic 2.2 |
| S3 | `/budget remind #id`: build it? | Yes (small; the worker DMs the step's approvers again) |
| S4 | Where a person's Slack link and default workspace live: `app_user.settings` JSON, or a `slack_identity` table? | `app_user.settings` |
| S5 | What a request from Slack may change: the amount and the reason only, or also period dates and phasing? | Amount and reason; the rest in the app |
| S6 | App Home tab (the `/budget` summary as the bot's Home): now (S-013) or later? | Later |
| S7 | The bot's display name: "BudgetOS" like the product (round 6), or keep "Budget OS"? | "BudgetOS" (a one-time manifest paste) |
| S8 | Snooze from Slack: keep one week, or a choice (a day, a week, until month end)? | Keep one week |
| S9 | Keep one Slack app per deployment with environment secrets (ADR-046), or build the OAuth install now? | Keep; revisit with a second client Slack |
| S10 | Drop `chat:write.public`, so the bot posts only in channels it was invited to? | Drop it |
| S11 | One Slack app per environment (dev through the tunnel, staging, production), each with its own secrets? | Yes |
| S12 | Client people acting from their own Slack (Slack Connect): this round, or later after a spike? | Later; this round everyone acts from the agency's team, as members or guests |
| S13 | One private channel per client workspace, or shared channels? | Private per client; shared only where everyone in it may see every workspace posting there |

## 7. How this is verified

**Automated** (every task; DB tests need the local Postgres on port 5434 and turbo's loose env mode, and the API test files run one at a time):

```bash
export PATH=~/.nvm/versions/node/v22.23.3/bin:$PATH
DATABASE_URL=postgresql://budget:budget@localhost:5434/budget APP_DATABASE_URL=postgresql://budget_app:replace-in-secret-manager@localhost:5434/budget pnpm --filter @budget/api exec vitest run src/modules/slack/slack.test.ts
DATABASE_URL=postgresql://budget:budget@localhost:5434/budget APP_DATABASE_URL=postgresql://budget_app:replace-in-secret-manager@localhost:5434/budget pnpm --filter @budget/workers exec vitest run src/notify
pnpm typecheck && pnpm lint && pnpm license-check
```

- `slack.test.ts` drives every command and button through the real HTTP stack with a fake `SlackApi` (`setSlackApi`), signed bodies (`signSlackBody`), the golden workspace and its personas; new tests add a fake `response_url` client. Assertions read `approval_decision.channel`, `audit_event.actor_id` and the outbox.
- `notify.test.ts` runs the worker against the database with a fake `SlackClient`; `blocks.test.ts` pins every message shape by snapshot.
- `pnpm test:acceptance` for the approvals epic after S-003; `apps/web/e2e/slack.spec.ts` for the settings page after S-004.

**Live** (S-002's gate, repeated as each phase lands): the §3.9 checklist on the local stack with the owner's Slack app. The app side (Admin › Slack, submitting a change, the inbox) can be driven in the built-in browser; the clicks in Slack and `/budget` need a person in Slack. Proof after each step: the edited message in the channel, and

```sql
SELECT decision, channel, decided_by, decided_at FROM approval_decision ORDER BY decided_at DESC LIMIT 3;
```

The Slack connector attached to this Claude session can read the channel to confirm posts and edits without a screenshot.

**GCP** (S-015, after T-008): the same checklist on staging with the staging app, plus the edge checks: an unsigned `POST /api/v1/slack/commands` through the load balancer answers 403 from the API, and `GET /api/v1/me` on the same host without a Google identity is redirected by IAP, never answered.

## 8. Out of scope, for later

Per-person notification preferences and digests (Epic 2.2, the settings column from S-010 is where they go), email, the Slack thread mirror (Epic 2.7), webhooks (Epic 2.5), OAuth multi-team install (S9), Slack commands for targets, closures and experiments (their buttons already work where a request exists), Snowflake or Sheets from Slack.

## 9. Assumptions

- "Send approvals of budgets through Slack" means both: the request reaches its approvers in Slack (S2, DMs and the channel post) and a person can send a budget change for approval from Slack (S4). If only one was meant, S2 stays and S4 waits.
- One Slack team, the agency's, holds every Budget OS workspace's channels; a Budget OS workspace is one client account. Client people who need to act join that team as members or guests; acting from a client's own Slack is decision S12.
- Slack profile emails match Budget OS emails (both from Google Workspace). Where they do not, the person is told and an admin fixes the Budget OS email.
- The first live gate runs on the `local` workspace through a tunnel with the dev app. The GCP gate (S-015) runs on staging once T-008 gives a project; the bot is hosted like the rest of the system (§3.12).
