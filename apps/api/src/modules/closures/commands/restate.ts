import { DomainError, RestateInput } from "@budget/domain";
import { audit, bumpDataVersion, outbox, unlockClosureEnvelopes, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { closureView } from "../views.js";

/**
 * POST /closures/:id/restate (spec §15): admin + reason. The closure becomes `restated` and its
 * envelopes get their prior status back (unless another closed closure still covers them). The
 * closure's BigQuery table stays as it is; the next close of the period writes `_r<N>`.
 */
export async function restateClosure(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const id = parseId(rawId);
  const input = parseInput(RestateInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM period_closure WHERE id = ${id}::uuid FOR UPDATE`;
    const current = locked.length ? await tx.periodClosure.findUnique({ where: { id } }) : null;
    if (current === null) throw new DomainError("NOT_FOUND", "Closure not found");
    if (current.status !== "closed") throw new DomainError("CONFLICT", "Closure is already restated");
    const saved = await tx.periodClosure.update({ where: { id }, data: { status: "restated" } });
    const unlocked = await unlockClosureEnvelopes(tx, id);
    const period = await tx.fiscalPeriod.findUniqueOrThrow({ where: { id: current.periodId } });
    await audit(tx, { workspaceId: current.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "closure.restated", entityType: "period_closure", entityId: id, before: { status: "closed" }, after: { status: "restated", unlockedEnvelopes: unlocked.length }, reason: input.reason, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId: current.workspaceId, topic: "period.restated", payload: { closureId: id, periodId: period.id, periodKey: period.key, unlockedEnvelopes: unlocked.length, reason: input.reason } });
    await bumpDataVersion(tx, current.workspaceId);
    const lockedCount = await tx.closureEnvelope.count({ where: { closureId: id } });
    return { ...closureView(saved, period, lockedCount), unlockedEnvelopes: unlocked.length };
  });
}
