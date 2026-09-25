# ADR-024: Approvals inbox and request detail, and the History tab in every budget

## Status

Accepted.

## Context

T-029 (spec §18.5) adds the approvals UI: an inbox and a request detail with DiffTable, ContextCards, DecisionTimeline and DecisionBar. The done-when is the decide flow in Playwright. Plan 0.6 (product owner) adds that every budget always carries its edit history, accessibly.

## Decision

- **`GET /approvals/:id` answers the decision in advance.** `decision: { canDecide, reason, stepRole }` runs the same checks as `POST …/decisions`:
  - the request is open;
  - the caller is eligible for the step (SQL `eligible_approver()`, the step role's scope, self-approval);
  - they have not already decided this step;
  - no envelope is locked.
  - The DecisionBar disables its buttons with that `reason`, which satisfies the disabled-with-reason rule.
  - `people` maps the requester and every decider to names. Inbox rows carry `requestedByName`.
- **Inbox:**
  - tabs "Waiting for me" (`assignee=me`), "All open" and "Resolved";
  - rows show the summary, envelope count, requester, step, due date and status (as text, not colour alone).
- **Request detail:**
  - a diff (approved now, requested, change) with links to each envelope;
  - the chain, with the current step marked `aria-current="step"`;
  - a decision timeline: "X submitted it", then each decision as "account: decision · step" with its comment and time;
  - a decision bar where a comment is required to reject or request changes;
  - the envelope's History.
- **History in every budget (plan 0.6):** the envelope drawer has Details and History tabs (WAI-ARIA tabs; arrow keys move between them).
  - History is the Decision Timeline (`GET /envelopes/:id/timeline`, newest first, "Show older" pages on): what happened, by whom (or System), when, before → after amounts (screen readers hear "to"), and the reason or comment.
  - Comments join it as their own tab in T-030.

## Consequences

- The inbox's "Waiting for me" re-checks eligibility per row (the T-011 query), which is fine at golden size; T-034 measures it at scale.
- External evidence and withdraw are API-only in this UI for now.
