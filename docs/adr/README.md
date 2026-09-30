# Architecture decision records

One file per decision, numbered in order (`0000-template.md` is the template). A task that deviates
from the spec or the plan writes one and cites it in its PR (`AGENTS.md` §1). This index lists every
record with its status line; regenerate it when you add one.

| ADR | Decision | Status |
|---|---|---|
| [ADR-002](0002-grid-core.md) | Grid core | Accepted |
| [ADR-003](0003-timeline-core.md) | Timeline core | Accepted |
| [ADR-004](0004-license-check.md) | Licence check over the pnpm workspace | Accepted |
| [ADR-005](0005-auth-and-tenancy.md) | API authentication and tenant resolution | Accepted |
| [ADR-006](0006-planner-bench.md) | planner bench warm-up and calibration | Accepted, 2026-09-23 |
| [ADR-007](0007-golden-seed.md) | Golden seed generator location and clock | Accepted |
| [ADR-008](0008-bulk-previews-redis.md) | Bulk edit previews in Redis, set-based commit | Accepted |
| [ADR-009](0009-targets-and-kpi-rollups.md) | Targets, the metric library and KPI roll-ups | Accepted |
| [ADR-010](0010-outbox-publisher-role.md) | Outbox publisher role and exactly-once consumers | Accepted |
| [ADR-011](0011-ingestion-and-gcs-emulator.md) | Ingestion pipeline, object store and GCS emulator | Accepted |
| [ADR-012](0012-pacing-evaluator.md) | Pacing evaluator — period, streaks, one open alert | Accepted |
| [ADR-013](0013-threads-and-mentions.md) | Threads, mentions and who may resolve | Accepted |
| [ADR-014](0014-search-index.md) | Search index, scope and suggest | Accepted |
| [ADR-015](0015-notify-slack.md) | notify-worker Slack delivery | Accepted |
| [ADR-016](0016-rollup-cache.md) | Roll-up cache and the tree read | Accepted |
| [ADR-017](0017-exports.md) | Export jobs, file formats and the BigQuery curated views | Accepted |
| [ADR-018](0018-closure-sink.md) | Closures, the ClosureSink and what a restatement restores | Accepted |
| [ADR-019](0019-read-only-mcp.md) | The read-only MCP server | Accepted |
| [ADR-020](0020-web-shell.md) | Web shell, sign-in token, route files and design tokens | Accepted |
| [ADR-021](0021-design-tokens.md) | Design tokens from the product screenshots | Accepted |
| [ADR-022](0022-explorer.md) | The Explorer on /query: tree and pivot row sources, edits, paste | Accepted |
| [ADR-023](0023-global-search-ui.md) | Global search palette | Accepted |
| [ADR-024](0024-approvals-ui-history.md) | Approvals inbox and request detail, and the History tab in every budget | Accepted |
| [ADR-025](0025-threads-ui-reactions.md) | Thread panel, comment editor without TipTap, emoji reactions per account | Accepted |
| [ADR-026](0026-registry-admin-ui.md) | Registry admin UI — granularities with icons, value trees, hierarchies, metrics | Accepted |
| [ADR-027](0027-envelope-structure-ui.md) | Envelope structure from the UI: add child, move, split, merge, with a server preview | Accepted |
| [ADR-028](0028-alerts-closures-sources-ui.md) | Alerts, rule editor, closures, sources and the mapping wizard; a local ingest runner | Accepted |
| [ADR-029](0029-overview-dashboard.md) | The Overview dashboard in one server call; pace, not projection, for "variances" | Accepted |
| [ADR-030](0030-load-suite.md) | The CI load suite at spec scale | Accepted |
| [ADR-030](0030-planner-projection-measures.md) | Projection measures in the planner: one lateral per envelope, after the page when possible | Accepted, 2026-09-26 |
| [ADR-031](0031-naming-templates-match-keys.md) | Naming templates, match keys and how facts match | Accepted |
| [ADR-032](0032-gantt-timeline.md) | The Gantt timeline (GET /timeline and BudgetTimeline) | Accepted |
| [ADR-033](0033-experiments.md) | Experiments | Accepted |
| [ADR-034](0034-golden-seed-speed.md) | Golden seed speed: fewer round trips, same commands, same data | Accepted, 2026-09-26 |
| [ADR-034](0034-manual-result-entry.md) | Manual result entry | Accepted |
| [ADR-035](0035-home-tours-templates.md) | Home, guided tours and workspace templates | Accepted |
| [ADR-036](0036-settings-search.md) | Settings in global search | Accepted |
| [ADR-037](0037-spend-month.md) | Monthly spend totals for the planner's actual | Accepted |
| [ADR-038](0038-tree-from-rollup-cache.md) | The Explorer's tree is served from the roll-up cache | Accepted |
| [ADR-039](0039-budget-family-editing.md) | Editing a budget family top-down | Accepted |
| [ADR-040](0040-requester-rules.md) | Rules on who can set budgets without approval | Accepted |
| [ADR-041](0041-fiscal-calendar.md) | The workspace's own fiscal calendar | Accepted |
| [ADR-042](0042-heavy-queries.md) | Heavy queries: warehouse routing and a query cache | Accepted |
| [ADR-043](0043-search-at-scale.md) | Search at scale: bounded candidates and a word list for typos | Accepted |
| [ADR-044](0044-rollup-status-events.md) | The roll-up worker consumes status-only events | Accepted |
| [ADR-045](0045-overview-layout.md) | Overview layout per person, and editing from the heatmap | Accepted |
| [ADR-046](0046-slack-bot.md) | The Slack bot: acting from Slack, and keeping its messages current | Accepted |
| [ADR-047](0047-pace-against-period-share.md) | Pace compares spend with the budget's share of the period | Accepted |
| [ADR-048](0048-admin-approval-final.md) | An admin's approval is final | Accepted |
| [ADR-049](0049-free-hierarchies.md) | Hierarchies are free, and a missing granularity is not a tree level | Accepted |
| [ADR-050](0050-budget-structure-tree.md) | Budgets opens on the budget structure | Accepted |
| [ADR-051](0051-one-headline-budget.md) | One definition of "the budget" in headline numbers | Accepted |
| [ADR-052](0052-superadmins-and-workspace-lifecycle.md) | Superadmins, and archiving and deleting workspaces | Accepted (product feedback round 6, docs/UX_AUDIT_AND_ADMIN_PLAN.md Part 3) |
| [ADR-053](0053-budget-snapshots.md) | Budget snapshots saved by hand | Accepted (product feedback round 7, docs/BUDGET_HISTORY_PLAN.md revision 2) |
| [ADR-054](0054-replica-and-retention.md) | The BigQuery replica, and moving old facts out of Postgres | Accepted (product feedback round 8, docs/DATA_PLAN.md §1, tasks D-001 to D-003) |
| [ADR-055](0055-mapping-profiles-and-synonyms.md) | Mapping profiles, synonyms and the mapping preview | Accepted (product feedback round 8, docs/DATA_PLAN.md §2, tasks D-004 to D-006) |
| [ADR-056](0056-budget-csv-import.md) | Importing budgets from a CSV | Accepted (product feedback round 8, docs/DATA_PLAN.md §3, tasks D-007 to D-009) |
| [ADR-057](0057-mcp-orientation.md) | What the MCP server tells an AI | Accepted (product feedback round 8, docs/DATA_PLAN.md §7, tasks D-010 to D-012) |
| [ADR-058](0058-tenant-isolation-for-history.md) | Snapshots and history never cross tenants | Accepted (product feedback round 8, docs/DATA_PLAN.md §8, tasks D-013 to D-015) |
| [ADR-059](0059-unallocated-holdings.md) | Pivots and trees count what each budget holds itself | Accepted (product feedback 2026-09-29) |
| [ADR-060](0060-editable-dates.md) | A budget's dates are editable, through approval once it has an approved amount | Accepted (product feedback 2026-09-29) |
| [ADR-061](0061-timeline-drag.md) | Timeline bars drag to change a budget's dates | Accepted (product feedback 2026-09-29 |
| [ADR-062](0062-pace-as-of-the-data.md) | Home and the Overview read pace as of the data | Accepted |
| [ADR-063](0063-home-is-the-desk.md) | Home is each person's desk | Accepted |
| [ADR-064](0064-ahead-of-plan.md) | Ahead of plan, pace in money | Accepted |
| [ADR-065](0065-hosting-on-dmus-gonzalo.md) | Hosting on the dmus-gonzalo project, signed in by IAP | Accepted (product owner, 2026-09-29) |
| [ADR-066](0066-mcp-oauth.md) | The MCP server signs people in with OAuth, through the app's Google sign-in | Accepted (product owner, 2026-09-29: "make sure the MCP is live with OAuth") |
