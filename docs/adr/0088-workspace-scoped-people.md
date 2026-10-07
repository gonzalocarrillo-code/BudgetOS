# ADR-088: A workspace's people list is scoped to that workspace

## Status

Accepted (Users & roles build plan, round 11, PR 2). Supersedes the sentence of ADR-052 that let a
superadmin's view of `GET /workspaces/:ws/members` include the whole org.

## Context

`listPeople` (`apps/api/src/modules/admin/queries/people.ts`) computed visibility as
`auth.isOrgAdmin || withRole.has(...)`: a superadmin opening any workspace's Roles page saw every
person in the organization, including people who only ever worked in a completely different
workspace (e.g. a superadmin opening *OpenAI › Roles* saw everyone who works only in *Sandbox*).
This was intentional at the time (ADR-052): a superadmin needed to be able to pick anyone when
giving a role in a workspace they were setting up, and there was no other way to browse the org.

Two things have since made the org-wide view unnecessary:
- `addPerson` (`POST /workspaces/:ws/members`) already lets a workspace admin or superadmin add
  anyone in the org by exact email, without browsing a list.
- PR 3 of this plan adds an org console (`org/people`) whose entire job is to browse the org and
  manage who is in which workspace.

Leaving the org-wide view in place after PR 3 ships would just be a second, inconsistent way to do
the same thing, and the one that leaks cross-workspace information a workspace admin can never see
in the Roles page itself (ORG-005's whole premise).

## Decision

- A workspace's people list (`GET /workspaces/:ws/members`) shows only principals (users and
  groups) with at least one role assignment in that workspace — direct or through a group — for
  every caller, superadmins included.
- A superadmin acting in a workspace where they hold no role of their own does not appear in that
  workspace's list; they are not a member of it. The existing "acting as superadmin" banner already
  tells them this.
- Browsing the whole org, and adding someone to a workspace without already knowing their email, is
  the org console's job from here (PR 3). Adding someone from inside a workspace stays by-email-only
  (decision D1 of the plan).
- A superadmin adding someone from inside a workspace now always gives them a role (default
  `VIEWER` when none is chosen) instead of "no role yet": a person with no role in the workspace
  would otherwise be invisible on the very page that just added them.

## Consequences

- A superadmin can no longer pick a name from an org-wide list inside a workspace's Roles page; they
  use add-by-email there, or the org console (PR 3) to add someone to a workspace from the org side.
- `addPerson`'s "add with no role, give one later" path is removed. `AddMemberInput.role` stays
  optional in the schema; the command now always applies a role (default `VIEWER`).
- Tests: `members.test.ts` now asserts a superadmin's view of workspace A excludes a user who only
  holds a role in workspace B, and that adding with no role yields `VIEWER` and workspace visibility.
