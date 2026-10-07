# Users & roles — build plan (round 11)

Date: 2026-10-06. Three PRs, built in order, each its own branch off `main` in its own worktree
(see memory: worktrees). Written so a builder can follow it step by step without re-deriving
anything. Every file path and line below was checked against `main` on 2026-10-06.

| PR | Branch | Fixes | Size |
|---|---|---|---|
| 1 | `feat/users-signin` | "Not signed in yet" never clears | ½ day |
| 2 | `feat/users-ws-scope` | A superadmin in workspace A sees every user of workspace B | ½ day |
| 3 | `feat/users-org-console` | Org console can't add/remove a person to/from a workspace | 1 day |

ADR: write `docs/adr/0064-workspace-scoped-people.md` in PR 2 (template `docs/adr/0000-template.md`).
Check `ls docs/adr` first; if 0064 is taken use the next free number and fix the references here.

---

## 0. Background the builder needs

**Data model (no change except PR 1's column).**
- `app_user` (Prisma `User`, [schema.prisma:44](../packages/db/prisma/schema.prisma)): `id, orgId, email (unique), name, googleSub (unique, nullable), isActive, createdAt`. Org-level, not per workspace.
- `role_assignment` (Prisma `RoleAssignment`): `id, workspaceId (null = org-wide), principalType ("user"|"group"), principalId, role, scope (jsonb), createdBy`. **A user is "in" a workspace iff they hold ≥1 assignment there** (directly or through a group). Superadmin = row with `workspaceId null, role ORG_ADMIN`.
- RLS: `app_user` is readable within the org, writable only when `app.is_org_admin = true` (migration `20260924030000_rls_identity_tables`). During login, `withIdentity()` ([packages/db/src/tenant.ts:59](../packages/db/src/tenant.ts)) exposes only the row matching `app.auth_subs` / `app.auth_email`.

**Existing code you will touch.**
- Login: `authenticate()` [apps/api/src/common/auth/authenticate.ts:25](../apps/api/src/common/auth/authenticate.ts) → `AccessRepository.findUser()` [access.repository.ts:26](../apps/api/src/common/auth/access.repository.ts).
- Workspace Roles page API: `listPeople` [apps/api/src/modules/admin/queries/people.ts](../apps/api/src/modules/admin/queries/people.ts) (GET `/workspaces/:ws/members`), `addPerson` [admin/commands/add-person.ts](../apps/api/src/modules/admin/commands/add-person.ts) (POST `/workspaces/:ws/members`, already adds by email), `revokeRole` [admin/commands/revoke-role.ts](../apps/api/src/modules/admin/commands/revoke-role.ts) (has the last-admin guard). Routes in [admin.controller.ts](../apps/api/src/modules/admin/admin.controller.ts).
- Org console API: `listOrgPeople`, `updateOrgPerson` [apps/api/src/modules/workspaces/org-people.ts](../apps/api/src/modules/workspaces/org-people.ts); routes in [workspaces.controller.ts](../apps/api/src/modules/workspaces/workspaces.controller.ts) (`@Permission("org.admin")`, call `this.cache.clear()` after writes).
- Schemas: `PeopleResponse` [packages/domain/src/access.ts:37](../packages/domain/src/access.ts); `OrgPerson`, `OrgPeopleResponse`, `UpdateOrgPersonInput`, `AddMemberInput` [packages/domain/src/workspaces.ts:43-71](../packages/domain/src/workspaces.ts). Round-trip fixtures in `packages/domain/src/schemas.roundtrip.test.ts:145-151` — **update them whenever a schema changes**.
- Web: [apps/web/src/routes/w.$ws.admin.roles.tsx](../apps/web/src/routes/w.$ws.admin.roles.tsx) (badges at line 68, add-person card ~183), [apps/web/src/routes/org.people.tsx](../apps/web/src/routes/org.people.tsx), [apps/web/src/routes/org.workspaces.tsx](../apps/web/src/routes/org.workspaces.tsx). Strings in [packages/ui/src/i18n.ts](../packages/ui/src/i18n.ts) (`roles.*` ~616, `org.people.*` ~52).
- Tests: [apps/api/src/modules/admin/members.test.ts](../apps/api/src/modules/admin/members.test.ts), [apps/api/src/modules/workspaces/lifecycle.test.ts](../apps/api/src/modules/workspaces/lifecycle.test.ts) — copy their harness setup (`ownerDb`, `startHarness`, `testUser`, `h.mint`, `h.call`). E2E: `apps/web/e2e/org-console.spec.ts`.

**Running checks locally** (memory: local Postgres on 5434, Node 22 via nvm path): `pnpm typecheck && pnpm lint && pnpm test && pnpm license-check`. After any API shape change: regenerate OpenAPI + `apps/web/src/lib/api.gen.ts` (the repo's `pnpm --filter @budget/api build` / `gen` script — check `apps/api/package.json` and `apps/web/package.json` for the exact names).

---

## PR 1 — Sign-in status that actually updates

### Root cause
`signedIn` is computed as `u.googleSub !== null` ([people.ts:28](../apps/api/src/modules/admin/queries/people.ts), [org-people.ts:33](../apps/api/src/modules/workspaces/org-people.ts)). A person added by email has `googleSub = null`. On login `findUser` falls back to matching by email and **nothing ever writes `googleSub`**, so they stay "Not signed in yet" forever. Gonzalo's row is the live example.

### Step 1 — migration
Create `packages/db/prisma/migrations/20261006100000_user_sign_in/migration.sql`:

```sql
-- Round 11 (PR 1): remember when a person last signed in, and bind their account id on the first
-- email-matched sign-in, so "Not signed in yet" clears.
-- Reverse: DROP FUNCTION app_record_sign_in(text); ALTER TABLE app_user DROP COLUMN last_sign_in_at;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz;

-- Anyone who already has an account id has signed in before.
UPDATE app_user SET last_sign_in_at = created_at WHERE google_sub IS NOT NULL AND last_sign_in_at IS NULL;

-- Runs inside withIdentity(): touches only the row that the verified token already exposes
-- (app.auth_subs / app.auth_email), the same rows the app_user identity policy shows.
-- Writes at most once per 15 minutes. Binds google_sub only when it is still empty.
-- Returns true when google_sub was bound by this call.
CREATE OR REPLACE FUNCTION app_record_sign_in(p_sub text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  bound boolean := false;
  target uuid;
BEGIN
  SELECT id INTO target FROM app_user
   WHERE google_sub = ANY (app_auth_subs())
      OR (app_auth_email() IS NOT NULL AND email = app_auth_email())
   ORDER BY (google_sub = ANY (app_auth_subs())) DESC NULLS LAST
   LIMIT 1;
  IF target IS NULL THEN RETURN false; END IF;
  UPDATE app_user
     SET google_sub = coalesce(google_sub, p_sub),
         last_sign_in_at = now()
   WHERE id = target
     AND (last_sign_in_at IS NULL OR last_sign_in_at < now() - interval '15 minutes' OR google_sub IS NULL)
  RETURNING (google_sub = p_sub AND p_sub IS NOT NULL) INTO bound;
  RETURN coalesce(bound, false);
END $$;
REVOKE ALL ON FUNCTION app_record_sign_in(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_sign_in(text) TO budget_app;
```

Notes:
- Mirrors `app_set_my_name` (migration `20260930010000_set_my_name`), which already updates `app_user` from a definer function — so the same privilege path works.
- `bound` is only "true" in a useful sense on the first bind; the TS side decides whether to audit by checking `googleSub` before the call (Step 3), so don't over-engineer the return.
- `google_sub` is `UNIQUE`: if `p_sub` already belongs to another row the UPDATE raises `23505`. Catch that in TS (Step 3) and ignore it — never block a login on bookkeeping.

### Step 2 — Prisma
In `model User` add:
```prisma
  lastSignInAt DateTime? @map("last_sign_in_at") @db.Timestamptz
```
Run `pnpm --filter @budget/db prisma generate`. Do **not** let `prisma migrate dev` generate a second migration for the column (it's in the SQL above); if it tries, use `prisma migrate resolve` / follow how earlier hand-written migrations were applied (`pnpm db:migrate`).

### Step 3 — record the sign-in
In `AccessRepository` ([access.repository.ts](../apps/api/src/common/auth/access.repository.ts)):

1. Add `googleSub: string | null` and `lastSignInAt: Date | null` to `AppUserRef` (Prisma returns them already from `findFirst`/`findUnique`).
2. Add:
```ts
  /**
   * Round 11: remember the sign-in (at most every 15 min) and bind the account id on the first
   * email-matched sign-in, so later sign-ins match by id and "Not signed in yet" clears.
   * Bookkeeping only: a failure here never blocks the request.
   */
  async recordSignIn(identity: VerifiedIdentity): Promise<void> {
    const subs = [identity.sub, ...(identity.googleSub ? [identity.googleSub] : [])];
    const email = identity.emailVerified ? identity.email : null;
    const sub = identity.googleSub ?? identity.sub;
    try {
      await withIdentity(this.prisma, { subs, email }, (tx) => tx.$executeRawUnsafe(`SELECT app_record_sign_in($1)`, sub));
    } catch (e) {
      this.logger?.warn({ err: e }, "recordSignIn failed");
    }
  }
```
   Use whatever logger the module already injects (search `PinoLogger` / `Logger` in `apps/api/src/common`); if none is available in this class, swallow silently with a comment — but **no `console.log`**.
3. In-process throttle so we don't open a transaction on every request: a `Map<string, number>` keyed by `user.id`, skip if `< 15 min` since last call in this process. Put it in `AccessRepository` as a private field.

In `authenticate()` ([authenticate.ts:27](../apps/api/src/common/auth/authenticate.ts)), right after the `isActive` check:
```ts
  if ((input.actorType ?? "user") === "user" && (user.lastSignInAt === null || user.googleSub === null || Date.now() - user.lastSignInAt.getTime() > 15 * 60_000)) {
    void deps.access.recordSignIn(identity);
  }
```
- Fire-and-forget (`void`), so login latency doesn't change. Tests must `await` something to observe it — see Step 6 (expose the promise or poll the row).
- **Do not** call it from `authenticateVerifiedEmail` (Slack-vouched email is not a sign-in) or for `actorType: "mcp"`.

Audit: when `user.googleSub === null` before the call (first bind), emit one `audit_event` `user.signed_in_first_time` + one outbox `access.changed { kind: "user.identity_bound", userId }` **per workspace where the user holds a role** — copy the loop from `updateOrgPerson` ([org-people.ts:56-60](../apps/api/src/modules/workspaces/org-people.ts)). Run it inside `withTenant(prisma, { workspaceId: null, orgId, userId, isOrgAdmin: true, actorType: "user", requestId })`. Put this in a small function `recordFirstSignIn(prisma, user, requestId)` in a new file `apps/api/src/common/auth/first-sign-in.ts`, called from `recordSignIn` only when the pre-call `googleSub` was null. Per-login updates are **not** audited (noise).

### Step 4 — schemas
- `PeopleResponse.users[]` ([access.ts:38](../packages/domain/src/access.ts)): add `lastSignInAt: z.string().nullable()`.
- `OrgPerson` ([workspaces.ts:43](../packages/domain/src/workspaces.ts)): add `lastSignInAt: z.string().nullable()`.
- Keep `signedIn: z.boolean()` (UI and Slack code use it).
- Update fixtures in `schemas.roundtrip.test.ts:149,151` (add `lastSignInAt: null` / an ISO string).

### Step 5 — queries
- `people.ts:28`: `signedIn: u.lastSignInAt !== null || u.googleSub !== null, lastSignInAt: u.lastSignInAt?.toISOString() ?? null`.
- `org-people.ts:33`: same two fields.

### Step 6 — web
- `packages/ui/src/i18n.ts`: add `"roles.lastSeen": "Last seen {when}"` and `"roles.invited": "Invited, not signed in yet"`; keep `roles.notSignedIn` key (rename its text to "Invited, not signed in yet" is fine).
- `org.people.tsx:54` and `w.$ws.admin.roles.tsx:68`: when `signedIn`, show muted text `t("roles.lastSeen", { when: relative(p.lastSignInAt) })` under the email. Use the relative-time helper the app already has (search `formatRelative` / `timeAgo` in `apps/web/src/lib`); if none, `Intl.RelativeTimeFormat` inline — no new dependency.
- Regenerate `api.gen.ts`.

### Step 7 — tests (write first)
New file `apps/api/src/common/auth/sign-in.test.ts` (copy harness setup from `members.test.ts`):
1. Create user `{ email, googleSub: null, lastSignInAt: null }` with a VIEWER role in `ws`.
2. Call `GET /api/v1/me` with a token minted for that email (check `h.mint` / `testUser` in `apps/api/src/test-support/harness.ts` for how to mint a token whose `sub` differs from the DB `googleSub` and has `email_verified: true`).
3. Poll the row via `owner.user.findUnique` (≤ 2 s, 50 ms steps): expect `googleSub` = token's google sub (or `sub`) and `lastSignInAt` not null.
4. `GET /workspaces/:ws/members` as the ws admin → that user `signedIn: true`, `lastSignInAt` ISO string.
5. Exactly one `audit_event` `user.signed_in_first_time` and one `outbox` row for that user in `ws`.
6. Second `/me` call immediately: `lastSignInAt` unchanged (throttle).
7. Another org user already owns the sub → login still 200, no throw (unique-violation swallowed).
8. Slack path: `authenticateVerifiedEmail` for an invited user leaves `lastSignInAt` null.

Also update `members.test.ts:61` if fixtures now need `lastSignInAt`.

### Step 8 — live fix for existing users
The backfill in Step 1 covers people with `google_sub`. People like Gonzalo (email-matched, `google_sub` null) clear on their **next** sign-in after deploy. Verify on `dmus-gonzalo` after deploy: sign in once, reload Org console › People → no "Invited" chip, "Last seen just now".

### Done when
Steps 7.1–7.8 pass; shared DB migrated; live check in Step 8 done.

---

## PR 2 — Workspace view shows only that workspace's people

### Root cause
`listPeople` ([people.ts:25](../apps/api/src/modules/admin/queries/people.ts)): `visible = auth.isOrgAdmin || withRole.has(...)`. A superadmin opening *OpenAI › Roles* sees every org user, including Sandbox-only people. Done on purpose in ADR-052 so a superadmin could pick anyone; adding by email ([add-person.ts](../apps/api/src/modules/admin/commands/add-person.ts)) already covers that need, so the org-wide view is no longer required.

### Step 1 — ADR
`docs/adr/0064-workspace-scoped-people.md`: Context (above), Decision ("a workspace's people list shows only principals with a role in that workspace, for every caller; superadmins browse the org only in the org console; adding someone from a workspace is by email"), Consequences (superadmin can't pick from the org list inside a workspace; they use email or the org console — PR 3). Supersedes the "superadmin sees the whole org" sentence of ADR-052.

### Step 2 — API
In `people.ts`:
```ts
    const visible = (type: string, id: string) => withRole.has(`${type}:${id}`);
```
- Update the file's doc comment: remove "A superadmin sees the whole org, to give anyone a role here."
- Superadmins acting in a workspace where they hold no role do **not** appear in the list (they're not members). The UI already shows an "acting as superadmin" banner — leave it.
- `orgAdmin` badge stays (computed from `admins`) for superadmins who also hold a role here.

### Step 3 — add-person flow
`addPerson` already: finds org user by email or creates one; refuses other-org emails; workspace admins default to VIEWER; superadmin may add with **no role**. Change: a superadmin adding with no role would now create someone **invisible** on this page. So in `add-person.ts:18`:
```ts
  const role: Role = input.role ?? "VIEWER";
```
and drop the `role === null` branch (lines with `if (role === null) return ...`). Update the doc comment. Update `AddMemberInput` comment only (schema stays — `role` optional, default applied in the command).

### Step 4 — web
`w.$ws.admin.roles.tsx`:
- If there is any UI that lists org users for a superadmin to assign a role to (search the file for `orgAdmin` / `isOrgAdmin` / a principal picker over `data.users`), it now only shows members — fine; the add-person card (~line 183) is the way to add. Make the role select in that card required with VIEWER default (no "no role" option).
- Rename the per-person "remove" action label to `t("roles.removeFromWorkspace")` = "Remove from workspace" when it would delete the person's **last** role here (compute: `roles.length === 1`). It still calls `DELETE /roles/:id`.
- i18n: add `roles.removeFromWorkspace`; edit `org.people.intro` later in PR 3.

### Step 5 — tests
`members.test.ts`:
- Line 56 test title and lines 63-65: change expectation — superadmin `GET /workspaces/:ws/members` returns **only** `admin` and `planner` (the users with a role in `ws`), not `orgAdmin`.
- New test: create workspace `ws2` in the same org with user `sandboxOnly` (PLANNER in ws2 only). As `orgAdmin` and as `admin`, `GET /workspaces/:ws/members` does **not** contain `sandboxOnly`.
- Line 84-85 test (superadmin adds with no role): now expect `role: "VIEWER"` and the person to appear in `/members`.
- Permission matrix: no new route; nothing to add.

### Done when
A superadmin's view of workspace A contains no user who only holds roles in workspace B (test above) and the e2e `org-console.spec.ts` still passes.

---

## PR 3 — Org console manages who is in which workspace

### Goal
Org console › People: per person, **+ Add to workspace** (workspace + role) and **×** on each workspace chip to remove them from it; **Invite person** at the top. Org console › Workspaces: per workspace a **Members** drawer with the same actions.

### Step 1 — schemas (`packages/domain/src/workspaces.ts`, export from `index.ts:39`)
```ts
/** POST /org/people — a superadmin adds someone to the org, always into one workspace with a role (D4). */
export const InviteOrgPersonInput = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(1).max(200),
  workspaceId: z.string().uuid(),
  role: RoleEnum.exclude(["ORG_ADMIN"]).default("VIEWER"),
});
export type InviteOrgPersonInput = z.infer<typeof InviteOrgPersonInput>;

/**
 * PUT /org/people/:id/workspaces/:ws — set a person's direct roles in one workspace. An empty list
 * removes them from it. Group-derived roles are not touched (they come from Google Groups).
 */
export const SetWorkspaceRolesInput = z.object({ roles: z.array(RoleEnum.exclude(["ORG_ADMIN"])).max(10) });
export type SetWorkspaceRolesInput = z.infer<typeof SetWorkspaceRolesInput>;

export const SetWorkspaceRolesResult = z.object({ userId: z.string().uuid(), workspaceId: z.string().uuid(), roles: z.array(z.string()), added: z.array(z.string()), removed: z.array(z.string()) });
```
Import `RoleEnum` from where `AddMemberInput` gets it. Add round-trip fixtures for all three.

Also extend `OrgPerson.workspaces[]` items with `viaGroup: z.boolean()` — true when that workspace's access comes only from groups (so the UI disables ×, with a reason).

### Step 2 — commands
New file `apps/api/src/modules/workspaces/org-membership.ts`:

```ts
const wsCtx = (auth: AuthContext, workspaceId: string) => ({ ...auth.ctx, workspaceId, isOrgAdmin: true, actingAs: "superadmin" as const });
```

`setWorkspaceRoles(prisma, auth, rawUserId, rawWs, raw)`:
1. `if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", ...)`; parse ids with `parseId`, body with `parseInput(SetWorkspaceRolesInput, raw)`; dedupe roles.
2. `withTenant(prisma, wsCtx(auth, ws), async (tx) => { ... })`:
   - Workspace exists in `auth.user.orgId`, `deletedAt: null`, status `ACTIVE` → else `NOT_FOUND` / `LOCKED` ("Restore the workspace first").
   - User exists in org → else `NOT_FOUND`. Inactive user + non-empty roles → `CONFLICT` "Turn their access back on first".
   - `current = tx.roleAssignment.findMany({ where: { workspaceId: ws, principalType: "user", principalId: userId } })`.
   - `toRemove = current.filter(r => !roles.includes(r.role))`, `toAdd = roles.filter(r => !current.some(c => c.role === r))`.
   - **Last-admin guard** (same rule and message as `revoke-role.ts:15-17`): if any `toRemove` is `WORKSPACE_ADMIN` and `count({ workspaceId: ws, role: "WORKSPACE_ADMIN" }) - removedAdmins < 1` → `CONFLICT` with `{ lastAdmin: true }`.
   - Delete each `toRemove`; create each `toAdd` with `newId()`, `scope: {}`, `createdBy: auth.user.id`.
   - For **each** removed/added row: one `audit` (`role.revoked` / `role.assigned`, entity `role_assignment`, same `before`/`after` shape as `revoke-role.ts` / `add-person.ts`) and one `outbox` (`topic: "access.changed"`, same payload shape). This matches existing role writes so downstream consumers (Slack, notify) need no change.
   - Return `{ userId, workspaceId: ws, roles: final roles, added, removed }`.
   - Keep each person's existing **scope** on roles that stay (don't recreate unchanged roles).

`inviteOrgPerson(prisma, auth, raw)`:
1. Org admin check, `parseInput(InviteOrgPersonInput, raw)`.
2. In `withTenant(prisma, { ...auth.ctx, workspaceId: null, isOrgAdmin: true, actingAs: "superadmin" }, ...)`: find by email; other org → `CONFLICT` (copy the P2002 handling from `add-person.ts:28-31`); else create. Audit `user.added` + outbox in `input.workspaceId` (that is why the workspace is required: `audit_event` needs one). Then call `setWorkspaceRoles` for `[input.role]`.
3. Return `{ id, email, name, created }`.

Both callers: controller calls `this.cache.clear()` after success (like `updatePerson`).

### Step 3 — routes (`workspaces.controller.ts`)
```ts
  @Post("org/people")
  @Permission("org.admin")
  async invite(@Tenant() auth: AuthContext, @Body() body: InviteOrgPersonDto) { const out = await inviteOrgPerson(this.prisma, auth, body); this.cache.clear(); return out; }

  @Put("org/people/:id/workspaces/:wsId")
  @Permission("org.admin")
  async setRoles(@Tenant() auth: AuthContext, @Param("id") id: string, @Param("wsId") wsId: string, @Body() body: SetWorkspaceRolesDto) { const out = await setWorkspaceRoles(this.prisma, auth, id, wsId, body); this.cache.clear(); return out; }
```
- Path param is `wsId`, **not** `ws`: these are org-scoped routes (no `x-workspace-id`), and the tenant interceptor may treat `:ws` specially. Check how `@Patch("workspaces/:ws")` + `@WorkspaceLifecycle()` handles it and mirror whatever keeps the request org-scoped.
- Add DTOs in `apps/api/src/modules/workspaces/dto.ts` the same way `UpdateOrgPersonDto` is defined (zod → DTO helper).
- Add `Put` to the `@nestjs/common` import.
- Add both routes to the permission-matrix test (find it: `grep -rln "org/people" apps/api/src --include='*.test.ts'`): superadmin 2xx, workspace admin / planner / viewer 403.

### Step 4 — org people query
`listOrgPeople` ([org-people.ts](../apps/api/src/modules/workspaces/org-people.ts)): also load group role assignments + `groupMember` rows; for each person build workspaces from direct **and** group roles; set `viaGroup = no direct role in that ws`. Roles list = union.

### Step 5 — web: Org console › People (`org.people.tsx`)
- Header row: **Invite person** button → dialog: name, email, workspace select (active workspaces from `GET /api/v1/workspaces`, already used by `org.workspaces.tsx`), role select (default VIEWER). Submit → `POST /api/v1/org/people`. On success invalidate `["org-people"]`.
- Each workspace chip (currently a `<Link>` at ~line 61): keep the link on the name; add a small **×** button (`aria-label={t("org.people.removeFrom", { ws: w.name })}`, `data-testid="org-person-remove-ws"`). Click → confirm dialog ("Remove {name} from {ws}? They lose access to it right away.") → `PUT .../workspaces/{wsId}` with `{ roles: [] }`. If `w.viaGroup`: render × `disabled reason={t("org.people.viaGroup")}` (eslint `budget/no-bare-disabled`). On `CONFLICT` with `lastAdmin`, show the server message inline (`role="alert"`).
- Clicking the role text on a chip opens a small popover with role checkboxes → `PUT` with the checked list (lets you change roles too).
- After the chips: **+ Add to workspace** (`data-testid="org-person-add-ws"`) → popover: workspace select (only workspaces the person isn't in), role select → `PUT` with `{ roles: [role] }`. Hide for inactive people.
- Update `org.people.intro`: "Everyone in your organization and the workspaces they're in. Add people to workspaces or remove them here; turn off access for someone who left."
- Every new button gets a `data-tour` attribute (`org-people-invite`, `org-people-add-ws`).

### Step 6 — web: Org console › Workspaces (`org.workspaces.tsx`)
- In each workspace row, the existing `members` count becomes a button **Members (n)** → side drawer listing people in that workspace (filter the already-fetched `["org-people"]` query client-side by `workspaces[].workspaceId` — this is display filtering of a list the server already scoped to the org, not data roll-up), each with role popover + × (same mutations), plus an "Add person" row (email + name + role → `POST /org/people` with that `workspaceId`). Extract the chip/popover/mutations from Step 5 into `apps/web/src/components/org-membership.tsx` and reuse in both pages.

### Step 7 — i18n keys (packages/ui/src/i18n.ts)
`org.people.invite`, `org.people.inviteTitle`, `org.people.addToWorkspace`, `org.people.removeFrom`, `org.people.removeConfirm`, `org.people.viaGroup` ("Access comes from a Google group; change the group"), `org.people.changeRoles`, `org.workspaces.members`, `org.workspaces.membersTitle`.

### Step 8 — tests (write first)
New `apps/api/src/modules/workspaces/org-membership.test.ts` (copy setup from `lifecycle.test.ts`, which already has `superadmin`, `admin`, `planner`, `ws`, `other`):
1. Superadmin `PUT /org/people/{planner}/workspaces/{other}` `{ roles: ["VIEWER"] }` → 200; planner's `GET /workspaces/{other}/members` call (header `x-workspace-id: other`) works; one `audit_event role.assigned` + one `outbox access.changed` in `other`.
2. `{ roles: [] }` → 200; planner now gets 403 on `other` (role cache cleared); one `role.revoked` audit + outbox.
3. Removing the only `WORKSPACE_ADMIN` of `ws` → 409, `details.lastAdmin === true`, nothing changed.
4. Change roles `["PLANNER"] → ["PLANNER","APPROVER"]` keeps the original PLANNER row id (scope preserved).
5. Workspace admin / planner calling either route → 403.
6. Archived workspace → 423; deleted → 404; user in another org → 404.
7. `POST /org/people` with new email + `workspaceId` + role → user created, role in that ws, `user.added` + `role.assigned` audits; same email again → 200 `created: false`; email from another org → 409.
8. `GET /org/people` returns `viaGroup: true` for a ws reached only through a group.
E2E in `apps/web/e2e/org-console.spec.ts`: superadmin adds a person to a workspace from People, sees the chip, removes it, chip gone.

### Done when
Tests 8.1–8.8 + e2e green; superadmin can add/remove/change workspace roles for anyone from the org console on `pnpm dev` and on `dmus-gonzalo` after deploy.

---

## Checklist per PR (AGENTS.md §6)
- [ ] Tests written first and failing, then green: `pnpm typecheck && pnpm lint && pnpm test && pnpm license-check`
- [ ] Zod schemas changed in `@budget/domain` + round-trip fixtures; OpenAPI + `api.gen.ts` regenerated
- [ ] Migration idempotent with a "Reverse:" comment (PR 1 only)
- [ ] Every write: one `audit_event` + one `outbox` per affected workspace, asserted in tests
- [ ] New routes in the permission-matrix test (PR 3)
- [ ] `this.cache.clear()` after role writes
- [ ] All strings via i18n; disabled controls have `reason`; new buttons have `data-tour`
- [ ] PR body uses AGENTS.md §7 template; after merge: migrate the shared DB, deploy via `deploy.yml`

## Decisions taken (change here if the owner disagrees)
- D1: Inside a workspace, people are added **by email only**; browsing the org is the org console's job.
- D2: Invited-but-never-signed-in people don't expire; shown as "Invited, not signed in yet".
- D3: Google-group membership is not edited from the org console this round (shown read-only via `viaGroup`).
- D4: Inviting from the org console always puts the person in a workspace with a role (needed for the per-workspace audit row).
