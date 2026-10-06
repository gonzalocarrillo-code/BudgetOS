# ADR-005: API authentication and tenant resolution

## Status

Accepted.

## Context

T-009 needs Identity Platform JWT validation, a tenant interceptor, roles, a scope guard and a groups sync endpoint (spec §4, §5.4, §22; plan §7). The spec names `apps/api/src/common/tenant.interceptor.ts` and `scope.guard.ts`, says roles are "cached 60 s in Redis", and gives no code for token validation. `docs/LOCAL_BUILD_PHASES.md` finding 9 says tests mint Identity Platform shaped JWTs against a test JWKS and that there is no `SKIP_AUTH`.

Four points were not settled by the spec:

1. How the interceptor enforces a route's permission. Nest runs guards before interceptors, so a guard cannot see a tenant the interceptor builds.
2. Where the 60 s role cache lives before the API has a Redis client. No task before T-009 wires Redis, and on this machine port 6379 belongs to another project.
3. Which status an invalid token returns. Spec §5.1 has no 401 code.
4. Who may sync an org-wide Google group through a workspace-scoped route.

## Decision

- **Token validation.** `JwtVerifier` uses `jose` (MIT) `createRemoteJWKSet` + `jwtVerify`, RS256 only.
  - It reads `AUTH_AUDIENCE` (the Identity Platform project id), `AUTH_ISSUER` (default `https://securetoken.google.com/<project>`) and `AUTH_JWKS_URL` (default Google's securetoken JWKS).
  - Missing `AUTH_AUDIENCE` fails at startup. There is no bypass flag.
  - Users are matched on `app_user.google_sub` against `sub` or `firebase.identities["google.com"][0]`, then on email only if `email_verified` is true.
- **One interceptor does authentication, tenant resolution and the route permission check.**
  - Each route declares `@Permission(action | "workspace.member" | "authenticated")`. A route without a declaration is rejected (fail closed).
  - The workspace comes from `:ws` or `X-Workspace-Id`; they must agree, and the workspace must belong to the caller's org.
  - Assignments come from `role_assignment` for the user and the user's groups. ORG_ADMIN is org-wide (`workspace_id IS NULL`). An assignment with an unreadable scope grants nothing.
  - The result is `request.tenant = { ctx: TenantContext, user, roles, assignments }`.
- **Scope checks run once the target is known.** `assertInScope(auth, action, target)` and `envelopeScopeTarget(tx, envelopeId)` live in `scope.guard.ts` as functions that services call.
  - `matchesScope`, `canInScope` and `eligibleApprover` are pure functions in `@budget/domain`. They support `eq`, `in` and `descends_from` on dimensions; `descends_from` uses the value's ancestry.
  - `ScopeFilter` validates the assignment's scope on write.
- **Role cache.** A `RoleCache` interface with a per-process 60 s TTL implementation (`MemoryRoleCache`).
  - Every role or group change clears it after commit. Other instances converge within 60 s.
  - A Redis implementation of the same interface lands with the first task that wires Redis (idempotency keys, spec §17).
- **`UNAUTHENTICATED` → 401** is added to `ErrorCode`. `FORBIDDEN` stays 403. Unknown, inactive and other-org cases all return 403 with the same message shape.
- **Groups sync.** The route takes the full member list per group, the shape a Directory API reader produces.
  - A workspace admin can sync a group only if it grants roles in no other workspace. Otherwise an org admin must, so a workspace admin cannot escalate in a workspace they do not administer.
  - Live Directory API stays blocked (plan §16 question 6).
- **Constructor injection uses explicit `@Inject(Token)`.** Vitest compiles with esbuild, which does not emit decorator metadata, and the permission matrix boots the real Nest app.

## Consequences

- The permission matrix (`apps/api/src/common/permission-matrix.test.ts`) exercises every documented route × every role through the real HTTP stack with signed test JWTs. It fails if a route is added to `openapi.json` without a row.
- Until Redis is wired, a revoked role can survive up to 60 s on instances other than the one that processed the change. Plan §7.4 asks for "removed users lose sessions immediately"; that holds per instance only.
- Under vitest, DTO validation pipes do not run (no metadata), so commands re-validate with the domain schema. Invalid bodies return 422 in tests and 400 when metadata is emitted.
- `ErrorCode` differs from the spec §5.1 code block by one member.

## Addendum: org admins inside a workspace (T-010)

T-010's cross-workspace test found that an org admin who sent `X-Workspace-Id` for workspace B could read workspace A's envelope by id. The T-002 policies are `app_is_org_admin() OR workspace_id = app_workspace_id()`, and the interceptor set `app.is_org_admin` whenever the caller held ORG_ADMIN.

- **Decision:** `ctx.isOrgAdmin`, the RLS bypass, is true only for org-level calls, meaning no workspace resolved. `AuthContext.isOrgAdmin` carries the role for authorization (scope checks, groups sync).
- **Registry exception:** the registry controller elevates explicitly with `orgAdminCtx(auth)`, because writing org-wide registry rows (`workspace_id IS NULL`) is what org admins use it for.
- **Closed (migration `20260924000000_rls_org_scoped_admin`):** the bypass was not limited to the caller's org. `withTenant()` now also sets `app.org_id` from `TenantContext.orgId`, which the interceptor fills from the authenticated user's org.
  - Tenant tables and `audit_event` read `workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])`. That is the session's own workspace, plus every workspace of `app.org_id` when the bypass is on.
  - `dimension` rows, including org-wide rows (`workspace_id IS NULL`), are visible only when `org_id = app_org_id()`. Before, every session could read other orgs' org-wide dimensions. Only an org admin can write org-wide rows, and only for its own org.
  - The bypass with no org (`orgId: null`) reads no bypass rows and no org-wide rows (fail closed).
  - Child tables keep their `EXISTS (parent)` policies and narrow with the parent.
  - The array form uses an InitPlan and keeps `workspace_id` indexes usable. On 200k envelopes across 50 workspaces, `count(*)` takes 2.7 ms (non-admin) and 5.3 ms (admin). The old policy seq-scans at about 80 ms, and so does the OR form with `IN (SELECT …)`.
  - The API-level rule above stays: `ctx.isOrgAdmin` is set only for org-level calls and for registry elevation.
  - `packages/db/src/rls.org-admin.test.ts` asserts all of this.
- **`role_assignment` RLS (migration `20260924020000_rls_org_tables`):** the table is scoped by the principal's org, because ORG_ADMIN rows have no workspace and principals are org-wide.
  - Reads cover the whole org. Groups sync must see a group's grants in other workspaces to stop a workspace admin escalating.
  - Writes are limited to the session's visible workspaces. Org-wide rows need the org-admin bypass.
  - `AccessRepository.access` now takes the user's org and reads assignments inside `withTenant()`.
- **Identity tables RLS (migration `20260924030000_rls_identity_tables`):** `organization`, `workspace`, `app_user` and `app_group` are readable only within `app.org_id`.
  - Writes: org admin only for `workspace` and `app_user`. A session may update its own workspace row (`bumpDataVersion`). The org admin may update its own `organization` row, and `budget_app` never inserts or deletes one. Any session of the org writes `app_group`, because groups sync runs as a workspace admin.
  - **Pre-org user match:** `withIdentity()` sets `app.auth_subs` and `app.auth_email` from the verified token, and an `app_user` policy exposes only the matching rows. The email is set only when `email_verified` is true. A SECURITY DEFINER lookup would not bypass FORCE ROW LEVEL SECURITY, because FORCE also applies to the owner.
  - The interceptor's workspace-to-org check and `/me`'s workspace list now run in `withTenant()`. Another org's workspace is invisible, so it still gets the same 403.
  - `app_is_org_admin()` now treats `''` as false. After a `SET LOCAL` transaction on a pooled connection the setting reads `''`, and the old cast raised 22P02 in any later session that did not set it.
  - `app_group_member` (migration `20260924040000_rls_group_member`) follows `app_group`, and a write also needs the member to be a user of the same org. `AccessRepository.access` reads memberships inside `withTenant()`.

## Addendum (2026-10-05): `audit_event` insert policy bound to the tenant (W2-4, audit S-4)

`packages/db/prisma/migrations/0002_platform/migration.sql` created `audit_insert` as `FOR INSERT WITH CHECK (true)` and it was never replaced: any session that can reach `audit_event` — including the read-only `budget_mcp` role, which holds `INSERT` on this one table (ADR-019) — could write an audit row into another workspace's trail, or with `workspace_id NULL` claiming any org as an org-level event. Separately, `audit_read`'s `workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))` is `NULL`, not `true`, for a `workspace_id IS NULL` row, so org-level audit rows (`slack.service.ts`'s `slack.org_linked`/`slack.org_unlinked`, the superadmin actions in `org-people.ts` and `lifecycle.ts`) were invisible to everyone, including the org admins who caused them.

- **Decision:** `audit_event` gets a nullable `org_id` (migration `20261010030000_audit_event_org_scoped_insert`), the same shape as `dimension`'s `workspace_id IS NULL` org-wide rows: a NULL workspace with an org is a legitimate row, not a gap to close with `workspace_id NOT NULL`.
  - `org_id` defaults from `nullif(current_setting('app.org_id', true), '')::uuid` — the same pattern `actor_context` already uses for `app.acting_as` — so `audit()` in `packages/db/src/sql.ts` and every raw `INSERT INTO audit_event` (registry.ts, bulk.ts, the workers' purge/retention/integrity paths) need no code change; `withTenant()` already sets `app.org_id` in every transaction.
  - Backfill: `org_id` is filled from `workspace.org_id` for workspace-scoped rows, and from `app_user.org_id` via `actor_id` for `workspace_id IS NULL` rows whose actor is known, run with `audit_event_immutable` disabled for the one-time `UPDATE` (Postgres clones trigger enable/disable from the partitioned parent to every partition).
  - `audit_insert`: `(workspace_id IS NOT NULL AND workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])) OR (workspace_id IS NULL AND org_id = app_org_id())`. The NULL-workspace branch deliberately does not also require `app_is_org_admin()`: `apps/mcp/src/server.ts`'s `list_workspaces` tool writes an `mcp.list_workspaces` audit row with `workspace_id` NULL (there is no single workspace to name) for every authenticated caller, not only org admins — requiring org-admin broke that write path (`apps/mcp/src/tools.test.ts` caught it). Matching the row's `org_id` to the session's own org already closes S-4: a session can never write a NULL-workspace row claiming another org.
  - `audit_read` keeps the stricter, org-admin-only shape for NULL-workspace rows: `(workspace_id IS NOT NULL AND workspace_id = ANY (...)) OR (workspace_id IS NULL AND app_is_org_admin() AND org_id = app_org_id())`. Nothing in the codebase reads NULL-workspace rows back today, and before this migration they were invisible to everyone (including org admins), so the read side can afford to stay narrower than the write side.
  - `budget_mcp` needed no new grant: `app_org_id()`, `app_visible_workspace_ids()` and `app_is_org_admin()` were never revoked from `PUBLIC`, so the role could already evaluate them (it already relies on them through every other table's RLS policy on `SELECT`).
  - `packages/db/src/rls.org-admin.test.ts` asserts all of this, including that `budget_mcp` inserting for a workspace outside its session is refused.

## Addendum (2026-10-05): the owner role has no BYPASSRLS (W2-3, audit S-2, S-3, S-21)

`apps/api/src/deploy/bootstrap.ts` ran `ALTER ROLE CURRENT_USER BYPASSRLS` once and left it set
permanently, so the owner role — also used, until this item, by the worker's poll loop
(`apps/workers/src/local-runner.ts`, audit S-2) — held a standing bypass of every RLS policy on
every FORCE-RLS table, for the sake of three tables (`organization`, `app_user`,
`role_assignment`) it only ever writes once per deploy, before any org admin exists to authorize
those writes under their ordinary org-scoped policies.

- **Decision:** the owner role never holds BYPASSRLS, ever. Migration
  `20261010050000_owner_bootstrap_policies` instead binds one explicit, permanent, unconditional
  policy per table — `organization`, `app_user`, `role_assignment` — to the literal role that runs
  the migration (and `bootstrap.ts`) via `TO CURRENT_USER`, resolved once at migration-apply time in
  every environment. `bootstrap.ts`'s identity writes (find-or-create the org, find-or-create the
  superadmin, reactivate them, create their org-wide `ORG_ADMIN` assignment) run in one transaction
  that needs nothing beyond these three policies. The later metrics-seeding check
  (`workspace.findFirst`, `metricDefinition.count`, `ensureDefaultMetrics`) already works under the
  ordinary org-admin tenant context (`withTenant`) — `workspace`'s `org_read` policy only requires
  `org_id = app_org_id()` — so it needs no owner policy at all.
- **Two mechanisms were tried first and do not work, for the record:**
  - `SET LOCAL row_security = off` does not bypass FORCE ROW LEVEL SECURITY for a non-owner,
    non-BYPASSRLS role. Per Postgres's own documentation (confirmed against Postgres 16) it has no
    effect for a role that already bypasses RLS, and for one that does not, it turns silent
    filtering into a hard error — `ERROR: query would be affected by row-level security policy for
    table "…"` — the opposite of what a one-time bootstrap write needs.
  - A non-superuser role cannot `ALTER ROLE CURRENT_USER BYPASSRLS` (or unset it) on itself even
    with `CREATEROLE`: Postgres 16 additionally requires `ADMIN OPTION` on the target role, which a
    role cannot hold on itself through ordinary `GRANT` (it is already an implicit member of
    itself). A transaction-scoped bypass toggle — on, write, off, commit — was the next idea, and
    would have kept `rolbypassrls` false at rest; it was dropped once this restriction made it
    impossible to implement without broader, Cloud-SQL-specific privileges this codebase cannot
    assume.
- **SECURITY DEFINER functions:** FORCE ROW LEVEL SECURITY applies to the owner too (this ADR's
  original text, above), so a SECURITY DEFINER function owned by the owner is a full bypass only if
  the owner itself can bypass — which, after this addendum, it cannot. Grepping every migration for
  `SECURITY DEFINER` finds four: `ensure_fact_partitions` and its `fact_partitions_lock` replacement
  only run DDL (`CREATE TABLE`/`LOCK TABLE`/`REVOKE`) and never touch an RLS table's rows, so they
  need nothing here. `app_set_my_name` (`20260930010000`) and `app_set_my_slack_settings`
  (`20261008010000`) both `UPDATE app_user` — `app_user`'s only other write policy,
  `org_admin_write`, requires `app_is_org_admin()`, which a non-admin changing their own name or
  Slack settings does not have. The `owner_bootstrap` policy on `app_user`, already needed for
  bootstrap's own read/create/reactivate, covers both as a side effect: SECURITY DEFINER makes
  `current_user` the owner for the duration of the call, and the owner already has unconditional
  access to that one table. No separate, narrower policy was added; a `WHERE id = app_user_id()`
  scoped policy would have been redundant given `owner_bootstrap`'s unconditional access already
  covers it.
- **Consequences:** the owner role's blast radius drops from "every RLS policy, every FORCE-RLS
  table, forever" to "three identity tables, and only for connections authenticated as the specific
  role that ran the migrations" — which, after W2-3, is only the `budgetos-migrate` job, never a
  service that serves live traffic or processes external input. `packages/db/src/runner.ts`'s
  discovery queries and the worker's outbox claim/mark run as `budget_publisher`
  (`PUBLISHER_DATABASE_URL`) instead, per ADR-010. `apps/api/src/common/assert-app-role.ts` is a
  second line of defense for the API specifically: it refuses to start if its own connection turns
  out to hold `rolbypassrls` or `rolsuper`, whatever the cause.
