import { DomainError, newId } from "@budget/domain";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Tx } from "./sql.js";
import { withTenant, type TenantContext } from "./tenant.js";

/**
 * `Idempotency-Key` (W3-2, audit I-6, spec §17, ADR-0081). A request carrying a key claims one
 * `idempotency_key` row — committed before the handler runs — keyed by its scope (workspace, org or
 * Slack team), the acting person and the key. The handler then runs exactly as it does without a
 * key, in its own transaction(s); on success the row stores the status and JSON body, on failure
 * the row is deleted so a retry runs. A later request with the same key replays the stored
 * response; one that arrives while the first is still running waits for it. Rows live
 * {@link IDEMPOTENCY_TTL_HOURS} hours.
 *
 * The one gap (ADR-0081): a crash after the handler committed but before the response was stored
 * leaves the row in flight; once {@link IN_FLIGHT_LEASE_SECONDS} pass, a retry runs the handler
 * again, and only the command's own natural idempotency (`basedOnVersionId`, `rowVersion`, unique
 * constraints) protects it.
 */

export const IDEMPOTENCY_TTL_HOURS = 24;
/** A stored body larger than this is not kept: a replay answers 409 instead. */
export const MAX_REPLAY_BYTES = 64 * 1024;
/** An in-flight claim older than this is abandoned (its request crashed) and may be taken over; longer than any handler's transaction timeout. */
export const IN_FLIGHT_LEASE_SECONDS = 600;

export type IdempotencyScope =
  | { kind: "workspace"; workspaceId: string; actorId: string }
  | { kind: "org"; orgId: string; actorId: string }
  | { kind: "slack"; teamId: string };

export interface IdempotencyRequest {
  scope: IdempotencyScope;
  key: string;
  /** `METHOD /path` of the request, kept for operators. */
  route: string;
  /** A hash of route + body: the same key on a different request is refused. */
  fingerprint: string;
}

/** What a handler answered. `body` undefined is an empty response. */
export interface IdempotentResponse {
  status: number;
  body: unknown;
}

export type IdempotencyClaim =
  | { kind: "claimed" }
  | { kind: "replay"; response: IdempotentResponse }
  | { kind: "in_flight" }
  | { kind: "mismatch" }
  | { kind: "too_large" };

function scopeWhere(scope: IdempotencyScope): Prisma.Sql {
  switch (scope.kind) {
    case "workspace":
      return Prisma.sql`workspace_id = ${scope.workspaceId}::uuid AND actor_id = ${scope.actorId}::uuid`;
    case "org":
      return Prisma.sql`workspace_id IS NULL AND org_id = ${scope.orgId}::uuid AND actor_id = ${scope.actorId}::uuid`;
    case "slack":
      return Prisma.sql`workspace_id IS NULL AND org_id IS NULL AND slack_team_id = ${scope.teamId}`;
  }
}

function scopeColumns(scope: IdempotencyScope): { workspaceId: string | null; orgId: string | null; teamId: string | null; actorId: string | null } {
  switch (scope.kind) {
    case "workspace":
      return { workspaceId: scope.workspaceId, orgId: null, teamId: null, actorId: scope.actorId };
    case "org":
      return { workspaceId: null, orgId: scope.orgId, teamId: null, actorId: scope.actorId };
    case "slack":
      return { workspaceId: null, orgId: null, teamId: scope.teamId, actorId: null };
  }
}

/**
 * Claims `req.key` in the session's tenant transaction. `INSERT … ON CONFLICT DO NOTHING RETURNING`
 * is the lock: the insert that returns a row owns the key. This key's own expired row (older than
 * the TTL, or an abandoned in-flight claim past the lease) is removed first, so it never replays.
 */
export async function claimIdempotencyKey(tx: Tx, req: IdempotencyRequest): Promise<IdempotencyClaim> {
  const where = scopeWhere(req.scope);
  await tx.$executeRaw`
    DELETE FROM idempotency_key
    WHERE ${where} AND key = ${req.key}
      AND (created_at < now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS}::int)
           OR (completed_at IS NULL AND created_at < now() - make_interval(secs => ${IN_FLIGHT_LEASE_SECONDS}::double precision)))`;
  const c = scopeColumns(req.scope);
  const inserted = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO idempotency_key (id, workspace_id, org_id, slack_team_id, actor_id, key, route, fingerprint)
    VALUES (${newId()}::uuid, ${c.workspaceId}::uuid, ${c.orgId}::uuid, ${c.teamId}, ${c.actorId}::uuid, ${req.key}, ${req.route}, ${req.fingerprint})
    ON CONFLICT DO NOTHING
    RETURNING id::text`;
  if (inserted.length > 0) return { kind: "claimed" };
  const rows = await tx.$queryRaw<Array<{ fingerprint: string; status: number | null; response: { body?: unknown } | null; completed: boolean }>>`
    SELECT fingerprint, status, response, completed_at IS NOT NULL AS completed
    FROM idempotency_key WHERE ${where} AND key = ${req.key}`;
  const row = rows[0];
  // Released between our insert and this read: the caller claims again.
  if (row === undefined) return { kind: "in_flight" };
  if (row.fingerprint !== req.fingerprint) return { kind: "mismatch" };
  if (!row.completed) return { kind: "in_flight" };
  if (row.response === null || row.status === null) return { kind: "too_large" };
  return { kind: "replay", response: { status: row.status, body: row.response.body } };
}

/** Stores the handler's answer on the claimed row; a body over {@link MAX_REPLAY_BYTES} is stored as NULL (replays answer 409). */
export async function completeIdempotencyKey(tx: Tx, req: IdempotencyRequest, response: IdempotentResponse): Promise<void> {
  const json = JSON.stringify(response.body === undefined ? {} : { body: response.body });
  const stored = Buffer.byteLength(json, "utf8") > MAX_REPLAY_BYTES ? null : json;
  await tx.$executeRaw`
    UPDATE idempotency_key SET status = ${response.status}, response = ${stored}::json, completed_at = now()
    WHERE ${scopeWhere(req.scope)} AND key = ${req.key} AND completed_at IS NULL`;
}

/** Deletes an in-flight claim (its handler failed), so the next request with the key runs. */
export async function releaseIdempotencyKey(tx: Tx, req: IdempotencyRequest): Promise<void> {
  await tx.$executeRaw`DELETE FROM idempotency_key WHERE ${scopeWhere(req.scope)} AND key = ${req.key} AND completed_at IS NULL`;
}

/** Deletes every row this session can see that is older than the TTL (the worker's daily sweep, org-wide session). */
export async function sweepIdempotencyKeys(tx: Tx, olderThanHours: number = IDEMPOTENCY_TTL_HOURS): Promise<number> {
  return tx.$executeRaw`DELETE FROM idempotency_key WHERE created_at < now() - make_interval(hours => ${olderThanHours}::int)`;
}

/**
 * Runs `fn` in the key's tenant session. A Slack scope additionally sets `app.slack_team_id`, the
 * only setting under which its rows are visible; its team's expired rows are swept here, since the
 * worker's org-wide sweep cannot see them.
 */
async function inScope<T>(prisma: PrismaClient, ctx: TenantContext, scope: IdempotencyScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(prisma, ctx, async (tx) => {
    if (scope.kind === "slack") {
      await tx.$executeRaw`SELECT set_config('app.slack_team_id', ${scope.teamId}, true)`;
    }
    return fn(tx);
  });
}

export interface WithIdempotencyOptions {
  /** How long a duplicate waits for an in-flight original before giving up (default 10 s). */
  waitMs?: number;
  pollMs?: number;
  /** What a duplicate answers when the original is still running after `waitMs` (default: 409 CONFLICT). */
  onStillInFlight?: () => IdempotentResponse;
  /** Errors that must not replace the handler's own outcome (storing or releasing the key). */
  onBookkeepingError?: (error: unknown, step: "complete" | "release") => void;
}

/** The handler's answer, and whether it can be stored for replay (a non-JSON body cannot: the key is released instead). */
export interface HandlerResult extends IdempotentResponse {
  replayable: boolean;
}

/**
 * Claim → run → store (or release on failure), or replay. `fn` runs outside the claim's
 * transaction, exactly as it would without a key; see the module comment for the one gap.
 */
export async function withIdempotency(
  prisma: PrismaClient,
  ctx: TenantContext,
  req: IdempotencyRequest,
  fn: () => Promise<HandlerResult>,
  opts: WithIdempotencyOptions = {},
): Promise<IdempotentResponse & { replayed: boolean }> {
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  for (;;) {
    const claim = await inScope(prisma, ctx, req.scope, async (tx) => {
      if (req.scope.kind === "slack") {
        await tx.$executeRaw`DELETE FROM idempotency_key WHERE slack_team_id = ${req.scope.teamId} AND created_at < now() - make_interval(hours => ${IDEMPOTENCY_TTL_HOURS}::int)`;
      }
      return claimIdempotencyKey(tx, req);
    });
    if (claim.kind === "claimed") break;
    if (claim.kind === "replay") return { ...claim.response, replayed: true };
    if (claim.kind === "mismatch") throw new DomainError("VALIDATION", "This Idempotency-Key was already used for a different request; use a new key", { idempotencyKey: req.key });
    if (claim.kind === "too_large") throw new DomainError("CONFLICT", "The original response is too large to replay; retry without the Idempotency-Key", { idempotencyKey: req.key });
    if (Date.now() >= deadline) {
      if (opts.onStillInFlight) return { ...opts.onStillInFlight(), replayed: true };
      throw new DomainError("CONFLICT", "A request with this Idempotency-Key is still in progress; retry shortly", { idempotencyKey: req.key });
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 50));
  }

  let result: HandlerResult;
  try {
    result = await fn();
  } catch (error) {
    await inScope(prisma, ctx, req.scope, (tx) => releaseIdempotencyKey(tx, req)).catch((releaseError: unknown) => opts.onBookkeepingError?.(releaseError, "release"));
    throw error;
  }
  const store = result.replayable
    ? inScope(prisma, ctx, req.scope, (tx) => completeIdempotencyKey(tx, req, result))
    : inScope(prisma, ctx, req.scope, (tx) => releaseIdempotencyKey(tx, req));
  // The write already committed: a failure here must not turn its success into an error response.
  await store.catch((error: unknown) => opts.onBookkeepingError?.(error, result.replayable ? "complete" : "release"));
  return { status: result.status, body: result.body, replayed: false };
}
