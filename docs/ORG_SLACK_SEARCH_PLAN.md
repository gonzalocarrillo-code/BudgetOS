# Round 11: search index, Slack in two places, org-only pages

Author: proposal for the product owner, 2026-09-30. Status: **proposal, nothing built.** Tasks follow `AGENTS.md` (one PR each, "done when" as a test). Decisions for the owner are in §5.

## 0. Summary

Four things the first day on `dmus-gonzalo` showed:

1. **Search finds nothing** on the deployed app, although the budgets exist. The search index is filled by the search indexer, which the deployed worker never runs; the local stack reindexed at start and hid this.
2. **Slack setup is per workspace.** Connecting the bot (secrets, request URLs, manifest, the Slack team) is a one-time job for the organisation, yet every workspace shows it and every workspace has to click "Link". With 100 workspaces that is 100 clicks and 100 copies of instructions that mention environment variables nobody sets from the app.
3. **Routing still belongs to the workspace.** Which channel gets LATAM's alerts is LATAM's decision; that part stays in workspace Settings, reduced to its four fields.
4. **Workspace templates and tours sit in workspace Settings** where every workspace admin sees them, although only an org admin may create a workspace (the API already says so) and both are shared by every workspace of the org.

Everything below is additive to the deployment: no new Cloud Run resources, one migration.

## 1. What exists

- `apps/workers/src/local-runner.ts` is the deployed worker (ADR-065). It polls the outbox for the ingest, roll-up and notify topics. The search indexer (`search-indexer/indexer.ts`, `handleSearchEvent`, `reindexWorkspace`) subscribes to *every* topic in the Pub/Sub design (spec §12.1) and is not in the loop. `search-indexer/main.ts reindex --workspace --org` reindexes one workspace by hand.
- Slack settings live in `workspace.settings.slack` (`SlackSettings`: `teamId`, `teamName`, `defaultChannel`, `alertChannel`, `alertSeverities`, `approvals`, `dms`). `PATCH …/integrations/slack { link: true }` calls Slack's `auth.test` and stores the bot's team on *that workspace*. `identity.ts` refuses a Slack request whose team is not the workspace's `teamId`; `linkedWorkspaces()` lists the workspaces of the person's org whose `teamId` matches. `/budget` already picks the workspace by channel, by the person's only workspace, or by their `/budget workspace` choice (S-010).
- `routes/w.$ws.admin.slack.tsx` shows connection status, link, routing, test, and a five-step setup with the manifest and URLs.
- `organization` has no `settings` column. `workspace.settings` is the precedent for integration state.
- Org console: `/org/workspaces`, `/org/people` (`org.tsx` refuses non-superadmins). Templates (`/w/$ws/admin/templates`, API `org.admin`) and tours (`/w/$ws/admin/tours`, edits need `user.manage`, so any workspace admin) are listed in the Settings hub groups "workspace" and "onboarding".

## 2. Design

### 2.1 Search
The worker's loop handles every outbox row twice over: the existing handlers, then `handleSearchEvent` for the same row (the indexer decides what the topic touches). At startup, and once a day, the worker reindexes every workspace whose index is empty or older than its `dataVersion`, so budgets created before this change appear without a hand-run command. `budgetos-worker` gets no new settings.

### 2.2 Slack: the organisation connects, the workspace routes

| Where | Who | What |
|---|---|---|
| Org console › Slack | org admin | Status: bot token and signing secret present, linked to team *X* (or not). "Link to Slack" (one `auth.test`, stored on the org). Manifest and the two request URLs to copy. "Send test message" to a channel. |
| Workspace Settings › Slack | workspace admin (`user.manage`) | One line: "Connected to *DEPT Slack*" or "Not connected: ask your org admin". Channel for approvals, channel for alerts, alert severities, approvals on/off, DMs on/off, test to the chosen channel. |

- `organization.settings.slack = { teamId, teamName, linkedBy, linkedAt }`. `SlackSettings` on the workspace drops `teamId`/`teamName`; `slackAuth` and `linkedWorkspaces` read the org's team, so **every workspace of the org is linked the moment the org is**. A workspace with no channel set posts nothing and answers `/budget` anyway (reads need no channel).
- Existing per-workspace `teamId` values (the local stack's) are read once as a fallback until the org is linked, then ignored; a follow-up migration deletes them.
- Roll-out to 100 workspaces: nothing per workspace unless it wants its own channels. Approvals DM the approvers, so a workspace without channels still works for the people in it.
- New endpoints: `GET/PATCH /org/integrations/slack`, `POST /org/integrations/slack/test` (`org.admin`). The workspace endpoints lose `link`.

### 2.3 Org-only pages
- **Workspace templates** move to `/org/templates`; the Settings hub entry goes. Home's "manage demo data" link points there for org admins and disappears for others.
- **Tours** move to `/org/tours`; `PATCH /tours/:id` becomes `org.admin`. Completing a tour stays per person (`workspace.member`).
- Settings hub groups: "workspace" keeps General and Fiscal calendar; "onboarding" goes; "data" keeps Spend data and Slack (routing).
- Org console navigation: Workspaces · People · Templates · Tours · Slack.

## 3. Tasks

| ID | Task | Files (main) | Done when | Days |
|---|---|---|---|---|
| R11-001 | Worker indexes search: every outbox row also goes to `handleSearchEvent`; reindex at startup and daily for stale or empty indexes | `apps/workers/src/local-runner.ts`, `search-indexer/indexer.ts` (an `indexIsStale(tx, ws)` helper) | Worker test: a `budget.changed` row indexes the budget; a workspace with an empty index is reindexed on the first pass. Deployed: "latam" finds the LATAM budget | 0.5 |
| R11-002 | Org-level Slack connection: `organization.settings`, `OrgSlackSettings` in `@budget/domain`, `GET/PATCH/test /org/integrations/slack`, `slackAuth`/`linkedWorkspaces` read the org's team; the workspace `link` goes | migration `organization_settings`, `packages/domain/src/slack.ts`, `modules/slack/*`, `identity.ts`, `openapi.json` | `slack.test.ts`: linking the org makes `/budget` answer in a workspace that never touched Slack; a request from another team is refused; permission-matrix rows for the three routes | 1.5 |
| R11-003 | Org console › Slack page; workspace page reduced to routing with the connection line | `routes/org.slack.tsx`, `routes/w.$ws.admin.slack.tsx`, `components/shell.tsx`, i18n | Playwright: as finance, Settings › Slack shows "ask your org admin" and no manifest; as superadmin the org page links and tests; `slack.spec.ts` updated | 1 |
| R11-004 | Templates and tours in the Org console; `PATCH /tours/:id` needs `org.admin`; Settings hub without them | `routes/org.templates.tsx`, `routes/org.tours.tsx`, the two `w.$ws.admin.*` routes removed, `shell.tsx`, `home.controller.ts`, `routeTree.gen.ts` | Playwright: a workspace admin has no Templates or Tours in Settings and gets the org console's 403 page by URL; the superadmin creates a workspace from `/org/templates`; `home-tours.spec.ts` and `settings.spec.ts` green | 1 |

Order: R11-001 (a bug, deploys alone), then R11-002 → R11-003 (stacked), then R11-004. About four days.

## 4. Not in this round
- Per-channel routing rules beyond the two channels (a rule already names its own channel).
- Slack user mapping other than by email.
- Removing the old workspace `teamId` values (a follow-up migration once every deployment is on R11-002).

## 5. Decisions for the owner
- **R1.** Tours editable by org admins only (proposed), or keep workspace admins able to edit them.
- **R2.** A workspace with no channels: post nothing to channels but keep DMs and `/budget` (proposed), or fall back to an org-wide default channel set on the org page.
- **R3.** `organization.settings` as a JSON column like `workspace.settings` (proposed, one migration), or a separate `org_integration` table.
