# Architecture decision records

One file per decision, numbered in order (`0000-template.md` is the template). A task that deviates
from the spec or the plan writes one and cites it in its PR (`AGENTS.md` §1). This index lists every
record with its status line; regenerate it when you add one.

| ADR | Decision | Status |
|---|---|---|
| [ADR-0000](0000-template.md) |  | Proposed, Accepted, or Superseded. |
| [ADR-0002](0002-grid-core.md) | Grid core | Accepted. |
| [ADR-0003](0003-timeline-core.md) | Timeline core | Accepted. |
| [ADR-0004](0004-license-check.md) | Licence check over the pnpm workspace | Accepted. |
| [ADR-0005](0005-auth-and-tenancy.md) | API authentication and tenant resolution | Accepted. |
| [ADR-0006](0006-planner-bench.md) | planner bench warm-up and calibration | Accepted, 2026-09-23. Not a §22 task. Branch `task/planner-bench-stable`, stacked on `task/bench-macos`. |
| [ADR-0007](0007-golden-seed.md) | Golden seed generator location and clock | Accepted. |
| [ADR-0008](0008-bulk-previews-redis.md) | Bulk edit previews in Redis, set-based commit | Superseded by [ADR-0072](0072-previews-in-postgres.md) (the "Redis in every deployed environment" |
| [ADR-0009](0009-targets-and-kpi-rollups.md) | Targets, the metric library and KPI roll-ups | Accepted. |
| [ADR-0010](0010-outbox-publisher-role.md) | Outbox publisher role and exactly-once consumers | Accepted. |
| [ADR-0011](0011-ingestion-and-gcs-emulator.md) | Ingestion pipeline, object store and GCS emulator | Accepted. |
| [ADR-0012](0012-pacing-evaluator.md) | Pacing evaluator — period, streaks, one open alert | Accepted. |
| [ADR-0013](0013-threads-and-mentions.md) | Threads, mentions and who may resolve | Accepted. |
| [ADR-0014](0014-search-index.md) | Search index, scope and suggest | Accepted. |
| [ADR-0015](0015-notify-slack.md) | notify-worker Slack delivery | Accepted. |
| [ADR-0016](0016-rollup-cache.md) | Roll-up cache and the tree read | Accepted. |
| [ADR-0017](0017-exports.md) | Export jobs, file formats and the BigQuery curated views | Accepted. |
| [ADR-0018](0018-closure-sink.md) | Closures, the ClosureSink and what a restatement restores | Accepted. |
| [ADR-0019](0019-read-only-mcp.md) | The read-only MCP server | Accepted. |
| [ADR-0020](0020-web-shell.md) | Web shell, sign-in token, route files and design tokens | Accepted. |
| [ADR-0021](0021-design-tokens.md) | Design tokens from the product screenshots | Accepted. Replaces the "shadcn defaults" part of ADR-020. |
| [ADR-0022](0022-explorer.md) | The Explorer on /query: tree and pivot row sources, edits, paste | Accepted. |
| [ADR-0023](0023-global-search-ui.md) | Global search palette | Accepted. |
| [ADR-0024](0024-approvals-ui-history.md) | Approvals inbox and request detail, and the History tab in every budget | Accepted. |
| [ADR-0025](0025-threads-ui-reactions.md) | Thread panel, comment editor without TipTap, emoji reactions per account | Accepted. |
| [ADR-0026](0026-registry-admin-ui.md) | Registry admin UI — granularities with icons, value trees, hierarchies, metrics | Accepted. |
| [ADR-0027](0027-envelope-structure-ui.md) | Envelope structure from the UI: add child, move, split, merge, with a server preview | Accepted. |
| [ADR-0028](0028-alerts-closures-sources-ui.md) | Alerts, rule editor, closures, sources and the mapping wizard; a local ingest runner | Accepted. |
| [ADR-0029](0029-overview-dashboard.md) | The Overview dashboard in one server call; pace, not projection, for "variances" | Accepted. |
| [ADR-0030](0030-load-suite.md) | The CI load suite at spec scale | Accepted. |
| [ADR-0031](0031-naming-templates-match-keys.md) | Naming templates, match keys and how facts match | Accepted. |
| [ADR-0032](0032-gantt-timeline.md) | The Gantt timeline (GET /timeline and BudgetTimeline) | Accepted. |
| [ADR-0033](0033-experiments.md) | Experiments | Accepted. |
| [ADR-0034](0034-manual-result-entry.md) | Manual result entry | Accepted. |
| [ADR-0035](0035-home-tours-templates.md) | Home, guided tours and workspace templates | Accepted. |
| [ADR-0036](0036-settings-search.md) | Settings in global search | Accepted. |
| [ADR-0037](0037-spend-month.md) | Monthly spend totals for the planner's actual | Accepted. |
| [ADR-0038](0038-tree-from-rollup-cache.md) | The Explorer's tree is served from the roll-up cache | Accepted. |
| [ADR-0039](0039-budget-family-editing.md) | Editing a budget family top-down | Accepted. |
| [ADR-0040](0040-requester-rules.md) | Rules on who can set budgets without approval | Accepted. |
| [ADR-0041](0041-fiscal-calendar.md) | The workspace's own fiscal calendar | Accepted. |
| [ADR-0042](0042-heavy-queries.md) | Heavy queries: warehouse routing and a query cache | Accepted. |
| [ADR-0043](0043-search-at-scale.md) | Search at scale: bounded candidates and a word list for typos | Accepted. |
| [ADR-0044](0044-rollup-status-events.md) | The roll-up worker consumes status-only events | Accepted. |
| [ADR-0045](0045-overview-layout.md) | Overview layout per person, and editing from the heatmap | Accepted. |
| [ADR-0046](0046-slack-bot.md) | The Slack bot: acting from Slack, and keeping its messages current | Accepted. |
| [ADR-0047](0047-pace-against-period-share.md) | Pace compares spend with the budget's share of the period | Accepted. This supersedes the pace formula in spec §6 and ADR-038. |
| [ADR-0048](0048-admin-approval-final.md) | An admin's approval is final | Accepted. This amends spec §9.3 (step advancement) and §5.4 (approver eligibility). |
| [ADR-0049](0049-free-hierarchies.md) | Hierarchies are free, and a missing granularity is not a tree level | Accepted. This amends spec §8 (hierarchy template validation) and §18.2 (the Explorer tree). |
| [ADR-0050](0050-budget-structure-tree.md) | Budgets opens on the budget structure | Accepted. This amends spec §18.2 (the Explorer tree) and §23 (the timeline). The hierarchy templates of spec §8 stay; they become one option. |
| [ADR-0051](0051-one-headline-budget.md) | One definition of "the budget" in headline numbers | Accepted. Amends ADR-016 (totals sum live leaves) for headline numbers only; the heatmap, pivots and hierarchy-template trees still sum leaves. |
| [ADR-0052](0052-superadmins-and-workspace-lifecycle.md) | Superadmins, and archiving and deleting workspaces | Accepted (product feedback round 6, docs/UX_AUDIT_AND_ADMIN_PLAN.md Part 3). Amends AGENTS §4 "never hard-deleted" for one case: purging a deleted workspace. |
| [ADR-0053](0053-budget-snapshots.md) | Budget snapshots saved by hand | Accepted (product feedback round 7, docs/BUDGET_HISTORY_PLAN.md revision 2). Phase E1 (H-001, H-002, H-005) added snapshots. Phase E2 (H-011, H-012) added ending and reintroducing a budget. |
| [ADR-0054](0054-replica-and-retention.md) | The BigQuery replica, and moving old facts out of Postgres | Accepted (product feedback round 8, docs/DATA_PLAN.md §1, tasks D-001 to D-003). Applying the Datastream stream waits for a GCP project; everything else runs locally. |
| [ADR-0055](0055-mapping-profiles-and-synonyms.md) | Mapping profiles, synonyms and the mapping preview | Accepted (product feedback round 8, docs/DATA_PLAN.md §2, tasks D-004 to D-006). |
| [ADR-0056](0056-budget-csv-import.md) | Importing budgets from a CSV | Accepted (product feedback round 8, docs/DATA_PLAN.md §3, tasks D-007 to D-009). Decisions F4 and F5 follow the plan's proposals. |
| [ADR-0057](0057-mcp-orientation.md) | What the MCP server tells an AI | Accepted (product feedback round 8, docs/DATA_PLAN.md §7, tasks D-010 to D-012). |
| [ADR-0058](0058-tenant-isolation-for-history.md) | Snapshots and history never cross tenants | Accepted (product feedback round 8, docs/DATA_PLAN.md §8, tasks D-013 to D-015). |
| [ADR-0059](0059-unallocated-holdings.md) | Pivots and trees count what each budget holds itself | Accepted (product feedback 2026-09-29). Amends ADR-016: roll-up nodes and the Budgets pivot no longer sum only live leaves. |
| [ADR-0060](0060-editable-dates.md) | A budget's dates are editable, through approval once it has an approved amount | Accepted (product feedback 2026-09-29). Decisions by the product owner: |
| [ADR-0061](0061-timeline-drag.md) | Timeline bars drag to change a budget's dates | Accepted (product feedback 2026-09-29; plan epic 2.5). Builds on ADR-060. |
| [ADR-0062](0062-pace-as-of-the-data.md) | Home and the Overview read pace as of the data | Accepted. Amends the inputs of ADR-047 for Home and the Overview; the formula is unchanged. |
| [ADR-0063](0063-home-is-the-desk.md) | Home is each person's desk | Accepted. Extends ADR-035 (Home, tours and templates); follows `docs/HOME_OVERVIEW_PLAN.md` §3.1 and decisions G1, G4 and G5. |
| [ADR-0064](0064-ahead-of-plan.md) | Ahead of plan, pace in money | Accepted. |
| [ADR-0065](0065-slack-toolset.md) | Slack as a working toolset | Accepted. Amends ADR-046. Plan: `docs/SLACK_TOOLSET_PLAN.md` (round 10). |
| [ADR-0066](0066-mcp-oauth.md) | The MCP server signs people in with OAuth, through the app's Google sign-in | Accepted (product owner, 2026-09-29: "make sure the MCP is live with OAuth"). |
| [ADR-0067](0067-google-sign-in.md) | Budget OS signs people in with Google itself | Accepted (product owner, 2026-09-30: "accessible by anyone, and use OAuth as login, both in and outside deptagency.com"). Supersedes ADR-065's use of IAP for signing in; the rest of ADR-065 stands. |
| [ADR-0071](0071-fact-identity-and-reconciliation.md) | Fact identity and reconciliation | Accepted. Supersedes spec §14 pipeline step 3 (`rowHash = sha256(sourceId + JSON.stringify(sortedRow))`) and the `ON CONFLICT (workspace_id, source_row_hash, period_date)` upsert of step 4. Amends ADR-037 (`spend_month` counts only live facts) and ADR-054 (retention compares live totals). |
| [ADR-0072](0072-previews-in-postgres.md) | Bulk-edit and budget-import previews in Postgres | Accepted. |
| [ADR-0073](0073-ci-timing-budgets.md) | timing budgets scale in CI | Accepted. |
| [ADR-0074](0074-security-overrides.md) |  | Pending |
| [ADR-0075](0075-slack-identity-pin.md) | Pin the Slack identity to the app user (S-14) | Accepted. Amends ADR-065. |
| [ADR-0076](0076-closure-budget-basis.md) | Closures record and show their budget basis | Accepted (owner decision D-1, 2026-10-05; audit T-12). |
| [ADR-0078](0078-planner-projection-measures.md) | Projection measures in the planner: one lateral per envelope, after the page when possible | Accepted, 2026-09-26. Not a §22 task. Branch `task/planner-projection-perf`. |
| [ADR-0079](0079-golden-seed-speed.md) | Golden seed speed: fewer round trips, same commands, same data | Accepted, 2026-09-26. Not a §22 task. Branch `task/golden-seed-speed`. |
| [ADR-0080](0080-hosting-on-dmus-gonzalo.md) | Hosting on the dmus-gonzalo project, signed in by IAP | Accepted (product owner, 2026-09-29). Replaces the Identity Platform sign-in page for the deployed app; the multi-tenant infrastructure of spec §20 stays the target. |
| [ADR-0081](0081-idempotency-keys.md) | Idempotency-Key on every mutating route, stored in Postgres | Accepted (W3-2, audit I-6, spec §17) |
| [ADR-0084](0084-data-version-at-commit.md) | The data version moves at commit (deferred outbox trigger), off the workspace row | Accepted (W3-8, audit I-14) |
| [ADR-0091](0091-demo-facts-written-onto-their-leaf.md) | Demo facts are written onto their demo leaf, not matched (amends ADR-0087) | Accepted (HF-3) |
