# ADR-052: Superadmins, and archiving and deleting workspaces

## Status

Accepted (product feedback round 6, docs/UX_AUDIT_AND_ADMIN_PLAN.md Part 3). Amends AGENTS §4 "never hard-deleted" for one case: purging a deleted workspace.

## Context

The product owner asked for:

- **superadmins** who create and delete workspaces;
- **workspace admins** who cannot touch any workspace but their own;
- workspaces that are "completely independent".

The org-wide `ORG_ADMIN` role (a `role_assignment` with `workspace_id IS NULL`) already did everything a superadmin needs except delete. Row-level security already kept each workspace's rows apart. The audit found four places where a workspace admin reached outside their workspace. The fixes for those are in the plan (ORG-005 to ORG-007).

## Decision

- **Superadmin is `ORG_ADMIN`.** The enum value stays in the database and code; every screen and message says "Superadmin". `/me` returns `isSuperadmin` beside `isOrgAdmin`. Renaming the value would touch SQL functions, migrations, the permission matrix and Slack for no change in behaviour (decision D2).
- **Superadmin actions are marked.** Inside a workspace a superadmin's session sets `app.acting_as = 'superadmin'`. `audit_event.actor_context` defaults from it, so every audit row they cause says so without changing any audit call.
- **Workspace lifecycle** (`workspace.status`, `archived_at`, `archived_by`, `deleted_at`, `purge_after`, `purged_at`):
  - **Archive** (`PATCH /workspaces/:ws { status: "ARCHIVED" }`, superadmin): the workspace leaves `/me` for its members. Superadmins still open it read-only. Every write returns `423 LOCKED`, except restore and delete. Workers skip it.
  - **Restore** (`{ status: "ACTIVE" }`): back as it was.
  - **Delete** (`DELETE /workspaces/:ws { confirmName, reason }`, superadmin): only an archived workspace, and only with its exact name typed. The row becomes a tombstone (`deleted_at`), its slug is freed, and it disappears everywhere. `purge_after` is `deleted_at` + `WORKSPACE_RETENTION_DAYS` (default 30). Until then, `POST /workspaces/:ws/undelete` brings it back archived.
  - **Purge** (the workers' `workspace-purge` job, never a request handler): after `purge_after`, it deletes the workspace's tenant rows in dependency order, child tables first, and sets `purged_at`. It keeps `audit_event` rows and the tombstone row, so the org's audit trail still resolves the workspace id.
- Each lifecycle step writes one `audit_event` and one `outbox` row (`workspace.changed`, `workspace.deleted`, `workspace.purged`).

## Consequences

- AGENTS §4 says versions, approvals, decisions, comments and facts are never hard-deleted. The purge is the one exception, and it applies only to a workspace a superadmin deleted and did not restore within the retention window.
- Audit rows of purged workspaces stay forever (plan §16 question 8 still decides their hot retention).
- A superadmin is not a member of every workspace. The switcher lists every active workspace for them, marked "Superadmin", and archived ones separately.
- Tests: the permission matrix covers every new route × role; `workspaces.lifecycle.test.ts` covers archive → 423 → restore, delete with a wrong name → 422, and the purge leaving audit rows.
