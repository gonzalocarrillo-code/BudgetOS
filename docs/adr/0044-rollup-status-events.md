# ADR-044: The roll-up worker consumes status-only events

## Status

Accepted.

## Context

`rollup_cache` measures include `pendingCount`: the live leaves with `envelope.status = 'PENDING'`. Spec §19 subscribes `rollup-worker` to `budget.changed`, `facts.loaded` and `registry.changed` only. Several writes move an envelope into or out of PENDING without a `budget.changed`. After them the cached `pendingCount` stayed stale until an unrelated event refreshed the same path.

Writes that change `envelope.status` to or from PENDING, and the one outbox row each emits:

| Write | Status change | Outbox topic | Payload |
|---|---|---|---|
| `submitVersionIn` (policy with a chain) | → PENDING | `approval.changed` | `{ requestId, action: "approval.requested", versionId, envelopeId, policy, policyVersion, status: "PENDING", step, supersededRequests }` |
| `decide` reject | PENDING → APPROVED / DRAFT (`closeRequest`) | `approval.changed` | `{ requestId, action: "approval.reject", step, comment, status: "REJECTED", threadId }` |
| `decide` request_changes | PENDING → APPROVED / DRAFT | `approval.changed` | `{ requestId, action: "approval.request_changes", …, status: "CHANGES_REQUESTED", threadId }` |
| `withdrawRequest` / `withdrawEnvelope` | PENDING → APPROVED / DRAFT | `approval.changed` | `{ requestId, action: "approval.withdrawn", comment, status: "WITHDRAWN" }` |
| `moveEnvelope` → `rerouteOpenRequest` | PENDING → APPROVED / DRAFT | `approval.changed` (plus the move's own `budget.changed` for the moved envelope) | `{ requestId, action: "approval.rerouted", status: "CHANGES_REQUESTED", threadId, newPolicy }` |
| the three above on a `bulk_change` request (`closeBulkVersions`, `archiveEnvelopes`) | PENDING → APPROVED / DRAFT / ARCHIVED, for every envelope of the bulk change | `approval.changed` | as above; the envelopes are found through the request's bulk change |
| `closePeriod` (`lockPeriodEnvelopes`) | PENDING → LOCKED | `period.closing` when the close starts (ADR-018 addendum, W3-1); `period.closed` when its rows are written | `{ closureId, periodId, periodKey, table, lockedEnvelopes }` |
| `closePeriod` sink failure, `abandonClosure` (`unlockClosureEnvelopes`) | LOCKED → PENDING (prior status) | `period.closure_failed` | `{ closureId, periodId, periodKey, table, unlockedEnvelopes, error }` |
| `restate` (`unlockClosureEnvelopes`) | LOCKED → PENDING (prior status) | `period.restated` | `{ closureId, periodId, periodKey, unlockedEnvelopes, reason }` |

Already covered by `budget.changed`: the last approving decision or external evidence (`approveVersion` → `{ envelopeId, versionId, kind: "approved" }`), auto-approval, bulk commit (`{ bulk, bulkChangeId, requestId, versionIds }`), split and merge (`{ kind, sourceId(s), partIds / targetId, bulkChangeId, requestId }`). Escalation, a non-final approve and non-counting evidence leave the envelope status as it is.

## Decision

- Every write above already emits exactly one outbox row. `rollup-worker` consumes those rows instead of the writes emitting a second `budget.changed`, so "one audit_event and one outbox row per write" (AGENTS.md §4) holds.
- `rollup-worker` also subscribes to `approval.changed`, `period.closing`, `period.closed`, `period.closure_failed` and `period.restated` (`ROLLUP_TOPICS` in `apps/workers/src/rollup/rollup.ts`; the local runner's `TOPICS`).
- For `approval.changed`, the worker refreshes only on the actions that change status: `approval.requested`, `approval.reject`, `approval.request_changes`, `approval.withdrawn`, `approval.rerouted`. It resolves the envelopes from the request: the version's envelope for `envelope_version`, or every envelope of the bulk change (versions, archived sources, created parts) for `bulk_change`. Target and manual-entry requests have no envelope status and are skipped.
- For closures, the worker refreshes only the closure's envelopes whose `prior_status` was PENDING. LOCKED and APPROVED count the same in every other measure, so no other node changes.
- The refresh is the existing `refreshTemplate` path, which the refresh == rebuild test already guards.

## Consequences

- Spec §19's subscriber list for `rollup-worker` grows by three topics. The deployed Pub/Sub push subscription (`infra/modules/pubsub`, not built yet: `infra/` holds only `modules/bigquery`) must list them when it is written.
- A `decide` or external evidence that completes the chain still writes two outbox rows (`budget.changed` from `approveVersion`, `approval.changed` from `recordRequestChange`). That predates this ADR and is left as it is; the worker ignores the `approval.changed` for those actions.
- A new approval action that changes envelope status must be added to `PENDING_ACTIONS`.
