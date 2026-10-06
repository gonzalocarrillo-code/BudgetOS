import type { Tx } from "./sql.js";

/** An outbox row as the publisher reads it. `id` is bigserial, carried as a decimal string. */
export interface OutboxRow {
  id: string;
  workspaceId: string | null;
  orgId: string | null;
  topic: string;
  payload: unknown;
  createdAt: Date;
}

/**
 * Locks up to `limit` unpublished rows in id order (spec §19). SKIP LOCKED lets several publishers
 * run side by side without taking the same row. Runs as budget_publisher (ADR-010).
 */
export async function claimOutbox(tx: Tx, limit: number): Promise<OutboxRow[]> {
  return tx.$queryRaw<OutboxRow[]>`
    SELECT o.id::text AS id, o.workspace_id::text AS "workspaceId", w.org_id::text AS "orgId", o.topic, o.payload, o.created_at AS "createdAt"
    FROM outbox o LEFT JOIN workspace w ON w.id = o.workspace_id
    WHERE o.published_at IS NULL ORDER BY o.id LIMIT ${limit} FOR UPDATE OF o SKIP LOCKED`;
}

export async function markOutboxPublished(tx: Tx, ids: string[]): Promise<number> {
  return tx.$executeRaw`UPDATE outbox SET published_at = now() WHERE id = ANY(${ids}::bigint[]) AND published_at IS NULL`;
}

/**
 * Records that `consumer` handled outbox row `outboxId`; false when it already had (spec §19
 * processed_event). Call inside withTenant() for the event's workspace: the RLS policy only admits
 * a row whose outbox event that tenant can see, so a message with a forged workspace fails here.
 */
export async function markProcessed(tx: Tx, consumer: string, outboxId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ ok: number }>>`
    INSERT INTO processed_event (consumer, outbox_id) VALUES (${consumer}, ${outboxId}::bigint)
    ON CONFLICT (consumer, outbox_id) DO NOTHING RETURNING 1 AS ok`;
  return rows.length === 1;
}

/**
 * Seeds only: marks a workspace's outbox rows published, as delivered. The golden seed calls it
 * after its own full search re-index and roll-up rebuild, which already applied every row up to
 * then, so a local runner does not replay thousands of superseded events (ADR-038).
 */
export async function markOutboxDelivered(db: { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> }, workspaceId: string): Promise<number> {
  return db.$executeRawUnsafe(`UPDATE outbox SET published_at = now() WHERE workspace_id = $1::uuid AND published_at IS NULL`, workspaceId);
}

/** A Prisma client or transaction narrow enough to run a parameterised raw SELECT. */
export interface RawReader {
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
}
/** A Prisma client or transaction narrow enough to run a parameterised raw statement. */
export interface RawWriter extends RawReader {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}

/** The local runner's own workspaces (ADR-065 Decision D-3): every workspace of LOCAL_ORG_FROM's
 * org when set, else every workspace whose slug starts with LOCAL_WORKSPACE_PREFIX. Never another
 * test's or deployment's rows. */
export interface LocalScope {
  prefix: string;
  orgFrom: string | null;
}

/** An outbox row as the local runner claims it (I-1, I-7): the publisher attributes plus its retry state. */
export interface LocalOutboxRow {
  id: string;
  workspaceId: string;
  orgId: string;
  topic: string;
  payload: unknown;
  attempts: number;
}

/**
 * Claims up to `limit` rows for the local runner (ADR-065 Decision D-3): in its own workspaces, on
 * one of `topics`, not yet published, not dead-lettered (`failed_at`) and past their backoff
 * (`next_attempt_at`). Newest workspace first, so a workspace a crashed run left behind never
 * starves a live one.
 */
export async function claimLocalOutbox(db: RawReader, scope: LocalScope, topics: string[], limit: number): Promise<LocalOutboxRow[]> {
  return db.$queryRawUnsafe<LocalOutboxRow[]>(
    `SELECT o.id::text AS id, o.workspace_id::text AS "workspaceId", w.org_id::text AS "orgId", o.topic, o.payload, o.attempts
       FROM outbox o JOIN workspace w ON w.id = o.workspace_id
      WHERE o.topic = ANY($2::text[]) AND o.published_at IS NULL AND o.failed_at IS NULL
        AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
        AND ($3::text IS NULL AND w.slug LIKE $1 OR w.org_id = (SELECT org_id FROM workspace WHERE slug = $3::text))
        -- ADR-052: an archived or deleted workspace is frozen; its events wait, unapplied.
        AND w.status = 'ACTIVE' AND w.deleted_at IS NULL
      ORDER BY w.created_at DESC, o.id LIMIT $4`,
    `${scope.prefix}%`,
    topics,
    scope.orgFrom,
    limit,
  );
}

/** Marks a row published and clears any pending backoff (it may have failed earlier attempts before succeeding). */
export async function markLocalPublished(db: RawWriter, id: string): Promise<void> {
  await db.$executeRawUnsafe(`UPDATE outbox SET published_at = now(), next_attempt_at = NULL WHERE id = $1::bigint`, id);
}

/**
 * Records a failed pass over a row (I-1, I-7): `attempts` increments, `last_error` is kept
 * (truncated — payloads and stack traces can be large), `next_attempt_at` backs off exponentially
 * (30s * 2^attempts, capped at attempts=6, so ~32 minutes), and `failed_at` is set once `attempts`
 * reaches `maxAttempts`, dead-lettering the row (docs/runbooks/worker.md lists and replays these).
 */
export async function markLocalFailure(db: RawWriter, id: string, error: string, opts: { maxAttempts: number }): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE outbox
        SET attempts = attempts + 1,
            last_error = $2,
            next_attempt_at = now() + (interval '30 seconds' * power(2, least(attempts, 6))),
            failed_at = CASE WHEN attempts + 1 >= $3 THEN now() ELSE failed_at END
      WHERE id = $1::bigint`,
    id,
    error.slice(0, 2000),
    opts.maxAttempts,
  );
}
