# ADR-048: An admin's approval is final

## Status

Accepted. This amends spec §9.3 (step advancement) and §5.4 (approver eligibility).

## Context

Product feedback (2026-09-28): "I added a budget but it doesn't approve once I approved it."

In a new workspace with one person, a raise matched "Major / over-allocation":

1. Budget owner, 1 approval.
2. Finance, 2 approvals.

The org admin approved both steps. Step 2 still needed a second, different Finance approver, so the request stayed pending forever. #72 already applies an admin's *own* change directly. A request raised by someone else, or raised before #72, still had no way through.

## Decision

- **Eligibility:** an org admin, or a workspace admin whose assignment scope covers the request's envelopes, may decide any step. This includes their own changes. The rule lives in both `eligibleApprover()` and SQL `eligible_approver()`.
- **Final approval:** an approve by either admin approves the request outright, whatever steps and approval counts remain (`advanceIfComplete(…, final)`). It writes one decision, one audit event and one outbox row, as any decision does.
- **Unchanged:** approvals by everyone else follow the chain and its `minApprovals`.

## Consequences

- A workspace admin can no longer be counted as one of several independent approvers; their approve ends the request. If a workspace needs four-eyes control over its admins, that becomes a policy setting (a follow-up).
