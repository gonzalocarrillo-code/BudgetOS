# ADR-040: Rules on who can set budgets without approval

## Status

Accepted.

## Context

Product feedback (2026-09-26): "we need true rules and permissions: some people can set budgets without approvals."

Approval policies (spec §9) match a change by what it is: amount, delta, dimensions, level, over-allocation. The first active policy by priority decides; a policy with no steps approves at once. Two things were missing:

- Nothing matched on who is asking.
- The Approval policies admin page was a placeholder, so no rule could be seen or changed without the API.

## Decision

- **`requester` condition.** `PolicyConditions` gains `requester: { roles?, userIds? }`. It matches when the person sending the change holds one of the roles in the workspace (direct or through a group, as `AuthContext.roles` has them) or is one of the people named. Every submit path passes the requester to `matchPolicy`: a single draft, a bulk or family change, a structural change, a target, manual results. With no steps, the result is "these people set budgets without approval".
- **Re-routing after a move** re-matches an open request without a requester. The person moving it is not who asked, so requester rules do not apply there; the request keeps its policy unless another one matches.
- **Approval policies page** (`/admin/policies`, `policy.manage`):
  - policies in priority order, each read in plain language ("When: a budget change · asked by Budget owner — Then: set at once, no approval");
  - create and edit: name, order, what changes, who is asking (the roles that can send a change: planner, budget owner, workspace admin), an amount range, and either "Set at once" or ordered approval steps;
  - active or off.
  
  Conditions the form does not edit (dimensions, `any`, named people) are kept as they are. A new policy starts at the top, before the catch-all ones.
- **The drawer says where a draft goes.** `GET /envelopes/:id` includes `draftPolicy`, the policy the open draft would match for this caller now. The button reads "Apply now" when that policy has no steps, and otherwise says who approves first.

## Consequences

- Admins can give a role (or, through the API, named people) direct budget-setting rights, visibly and audited. Policy changes bump the policy version; open requests keep their snapshot.
- **Still to do:** the Roles admin page, where role assignments and scopes are managed, is still a placeholder. Roles are assigned through the API and seed until it is built.
- **Tests:**
  - `policy-matcher.test.ts`: the requester condition.
  - `e2e/policies.spec.ts`: an admin adds the rule; a budget owner's draft applies at once; a planner's goes for approval.
