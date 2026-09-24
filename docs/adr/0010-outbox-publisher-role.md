# ADR-010: Outbox publisher role and exactly-once consumers

## Status

Accepted.

## Context

Spec §19's publisher reads `outbox WHERE published_at IS NULL` for every workspace and marks the rows published. Three constraints stand in the way:

- `budget_app` can't do this. RLS limits it to one workspace, or to one org's workspaces when the org-admin bypass is on (ADR-005 addendum).
- `organization` and `workspace` have RLS, so a job can't discover orgs on its own.
- Application code never uses the owner role. In any case, RLS is forced on `outbox`, so a `SECURITY DEFINER` function owned by the table owner would be filtered too.

Subscribers need the org as well as the workspace to open `withTenant()`, because `workspace` reads are org-scoped. The outbox row only carries the workspace.

## Decision

- **`budget_publisher` role** (migration `20260924070000_outbox_publisher_role`): `LOGIN NOBYPASSRLS`, with no default table privileges. It gets only these grants:
  - `SELECT` and `UPDATE (published_at)` on `outbox`, with policy `publisher_all ... TO budget_publisher USING (true)`;
  - `SELECT (id, org_id)` on `workspace`, with policy `publisher_read ... FOR SELECT TO budget_publisher USING (true)`.

  Every other table stays closed to it. Payload, delete and other columns are refused, and a test asserts this. The publisher connects with `PUBLISHER_DATABASE_URL`. In deployed environments that is its own secret and its own service account, like `budget_mcp` in spec §16.
- **Publisher** (`apps/workers/src/outbox-publisher.ts`):
  - One transaction per pass: claim up to 500 rows with `FOR UPDATE OF o SKIP LOCKED` in id order, publish each to `budget-os.<topic>`, then mark the batch published.
  - Each message carries:
    - ordering key: `workspace_id`;
    - data: the outbox payload as JSON;
    - attributes: `outboxId`, `workspaceId`, `orgId`, `topic`.
  - A failed publish rolls back the whole pass. Rows already sent in that pass are sent again next time, so delivery is at least once. The failed ordering key is resumed.
  - Passes loop every 500 ms, or at once while batches are full. The service answers `/healthz`.
- **Consumers** (`apps/workers/src/consumer.ts`):
  - `decodePush` validates the Pub/Sub push body against `PubSubPush` in `@budget/domain`.
  - `handleOnce(prisma, consumer, event, handler)` opens `withTenant()` for the event's workspace and org and inserts `processed_event(consumer, outbox_id) ON CONFLICT DO NOTHING`. It runs the handler in the same transaction only if the insert took.
  - A duplicate delivery, sequential or concurrent, does nothing.
  - A handler that throws rolls back its dedupe row, so the redelivery applies it.
  - The `processed_event` policy (`EXISTS outbox`) rejects a message whose attributes name another workspace.
- **Pub/Sub client** is `@google-cloud/pubsub` 6.1.0 (Apache-2.0). Topics and push subscriptions come from Terraform (spec §20).

## Consequences

- Effectively exactly once per consumer for database side effects: at-least-once delivery plus a dedupe row in the handler's own transaction.
- Side effects outside the database, such as a Slack post in T-021, are not covered by the rollback. Those handlers must be idempotent on the outbox id themselves.
- Still blocked until phase 20:
  - publishing to a live topic;
  - the Cloud Run services;
  - push authentication (OIDC token verification on subscriber endpoints).

  `PubSubPublisher` is typechecked but not called in tests.
- Rows with a NULL `workspace_id` can't be published and fail the pass. `budget_app` can't write them, because RLS `WITH CHECK` requires a visible workspace.
