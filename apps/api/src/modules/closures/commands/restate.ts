import { DomainError, RestateInput } from "@budget/domain";
import { audit, lockClosure, outbox, unlockClosureEnvelopes, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { closureView } from "../views.js";

/**
 * POST /closures/:id/restate (spec §15): admin + reason. The closure becomes `restated` and its
 * envelopes get their prior status back (unless another closing or closed closure still covers
 * them). The closure's BigQuery table stays as it is; the next close of the period writes a new one.
 * Only a `closed` closure is restated: a `closing` one is in progress (W3-1), a `failed` one holds nothing.
 */
export async function restateClosure(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const id = parseId(rawId);
  const input = parseInput(RestateInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const current = (await lockClosure(tx, id)) ? await tx.periodClosure.findUnique({ where: { id } }) : null;
    if (current === null) throw new DomainError("NOT_FOUND", "Closure not found");
    if (current.status === "closing") throw new DomainError("CONFLICT", "This closure is in progress (its rows are being written); restate it once it is closed, or abandon it when stale", { status: current.status });
    if (current.status === "failed") throw new DomainError("CONFLICT", "This close failed and locks nothing; there is nothing to restate", { status: current.status });
    if (current.status !== "closed") throw new DomainError("CONFLICT", "Closure is already restated");
    const saved = await tx.periodClosure.update({ where: { id }, data: { status: "restated" } });
    const unlocked = await unlockClosureEnvelopes(tx, id);
    const period = await tx.fiscalPeriod.findUniqueOrThrow({ where: { id: current.periodId } });
    await audit(tx, { workspaceId: current.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "closure.restated", entityType: "period_closure", entityId: id, before: { status: "closed" }, after: { status: "restated", unlockedEnvelopes: unlocked.length }, reason: input.reason, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId: current.workspaceId, topic: "period.restated", payload: { closureId: id, periodId: period.id, periodKey: period.key, unlockedEnvelopes: unlocked.length, reason: input.reason } });
    const lockedCount = await tx.closureEnvelope.count({ where: { closureId: id } });
    return { ...closureView(saved, period, lockedCount), unlockedEnvelopes: unlocked.length };
  });
}
