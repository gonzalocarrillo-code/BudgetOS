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
