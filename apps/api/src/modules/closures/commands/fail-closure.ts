import { audit, bumpDataVersion, outbox, unlockClosureEnvelopes, type Tx } from "@budget/db";
import type { FiscalPeriod, PeriodClosure } from "@prisma/client";
import type { AuthContext } from "../../../common/tenant.js";

/** Longest `error` text kept on the closure row. */
const ERROR_MAX = 2000;

/**
 * W3-1 (ADR-018 addendum): a `closing` closure becomes `failed`, after its sink write failed
 * (`closure.failed`) or when a stale one is abandoned (`closure.abandoned`). Its envelopes get their
 * prior status back unless another closing or closed closure still covers them; outbox
 * `period.closure_failed` so the roll-up and search refresh their status. The caller holds the
 * closure's row lock (`lockClosure`) and has checked that it is still `closing`.
 */
export async function failClosure(tx: Tx, auth: AuthContext, current: PeriodClosure, error: string, action: "closure.failed" | "closure.abandoned"): Promise<{ saved: PeriodClosure; period: FiscalPeriod; unlocked: string[] }> {
  const text = error.slice(0, ERROR_MAX);
  const saved = await tx.periodClosure.update({ where: { id: current.id }, data: { status: "failed", error: text } });
  const unlocked = await unlockClosureEnvelopes(tx, current.id);
  const period = await tx.fiscalPeriod.findUniqueOrThrow({ where: { id: current.periodId } });
  await audit(tx, { workspaceId: current.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "period_closure", entityId: current.id, before: { status: "closing" }, after: { status: "failed", error: text, table: current.bqTable, unlockedEnvelopes: unlocked.length }, requestId: auth.ctx.requestId });
  await outbox(tx, { workspaceId: current.workspaceId, topic: "period.closure_failed", payload: { closureId: current.id, periodId: period.id, periodKey: period.key, table: current.bqTable, unlockedEnvelopes: unlocked.length, error: text } });
  await bumpDataVersion(tx, current.workspaceId);
  return { saved, period, unlocked };
}
