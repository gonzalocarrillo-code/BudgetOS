# ADR-058: Snapshots and history never cross tenants

## Status

Accepted (product feedback round 8, docs/DATA_PLAN.md §8, tasks D-013 to D-015).

## Context

The owner asked for absolute protection: snapshots and history never duplicated and never cross-referenced across tenants. RLS already hid other workspaces' rows from every application role, and the code always scoped reads to the caller's workspace. The database did not itself refuse a cross-tenant row, and BigQuery, which has no row-level security, held every tenant in one dataset.

## Decision

- **Composite keys (D-013).** `budget_baseline (id, workspace_id)` and `envelope (id, workspace_id)` are unique. A snapshot row references `(baseline_id, workspace_id)` and `(envelope_id, workspace_id)`, so Postgres refuses a row whose workspace is not its snapshot's or its budget's, whatever the code does.
- **Every snapshot read names the workspace.** The compare-to check, the planner's baseline join, the tree and the change report's rows all filter on the workspace as well as the id. RLS already scoped these, including a superadmin's session inside a workspace; this is the second line.
- **A two-workspace isolation test.** From workspace B, every read of workspace A's snapshot is 404: list, header, rows, CSV, report, report against it, rename, and a query comparing with it. That holds for B's admin and for a superadmin acting in B. Postgres refuses both kinds of cross-tenant row, and the read-only MCP role in B's session reads nothing of A.
- **BigQuery per workspace (D-014).** The base replica dataset is for the platform's own data team only (`reader_groups`). Each client workspace that reads BigQuery gets its own dataset (`budget_os_<env>_ws_<key>`), whose views select that workspace's rows from each curated view and are authorized on the base dataset. Its readers are granted that dataset, never the base one. Every curated view carries `workspace_id`, and the views test checks it.
- **A weekly integrity check (D-015).** For every workspace, in an org-level session, it confirms three things: no snapshot row belongs to another workspace than its snapshot or its budget, and every snapshot's row count and total match its rows. A finding writes one audit event (`integrity.snapshots`), one outbox row (`integrity.alert`), and an in-app notification to each of the org's superadmins. `SNAPSHOT_INTEGRITY=off` disables it.

## Consequences

- A bug that tried to write a cross-tenant snapshot row fails at the database, and one that corrupted a header shows up within a week.
- Adding a BigQuery reader for a client is a `workspace_readers` entry, never a grant on the base dataset.
