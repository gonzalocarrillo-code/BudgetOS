import { CreateBaselineInput, DomainError, UpdateBaselineInput, can, newId, type BaselineScope, type BaselineView } from "@budget/domain";
import { audit, captureBaselineRows, outbox, withTenant, type Tx } from "@budget/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { scopeIds, view } from "../queries/baselines.js";

/** Snapshot writes (Phase E, ADR-053): save one by hand, rename or archive it. Reads are in ../queries. */
const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Who may save or change a snapshot: finance and admins (`closure.close`) for the workspace or a
 * filter; for one budget's subtree, anyone who may edit that budget.
 */
async function assertMayManage(tx: Tx, auth: AuthContext, scope: BaselineScope): Promise<void> {
  if (auth.isOrgAdmin || can(auth.roles, "closure.close")) return;
  if ("envelopeId" in scope) {
    assertInScope(auth, "envelope.edit_draft", await envelopeScopeTarget(tx, scope.envelopeId));
    return;
  }
  throw new DomainError("FORBIDDEN", "Only finance and admins save snapshots of the whole workspace; save one of a budget from its drawer");
}

/** POST /workspaces/:ws/baselines — one audit_event and one outbox row. */
export async function saveBaseline(prisma: PrismaClient, auth: AuthContext, raw: unknown, now: Date = new Date()): Promise<BaselineView> {
  const input = parseInput(CreateBaselineInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      await assertMayManage(tx, auth, input.scope);
      const ids = await scopeIds(tx, workspaceId, input.scope);
      const id = newId();
      // The header first (rows reference it), then the rows, then the counts they produced.
      await tx.budgetBaseline.create({ data: { id, workspaceId, name: input.name, kind: input.kind, scope: json(input.scope), periodKey: input.periodKey ?? null, asOf: now, note: input.note ?? null, takenBy: auth.user.id, rowCount: 0, totalReporting: 0 } });
      const { rows, total } = await captureBaselineRows(tx, { baselineId: id, workspaceId, asOf: now, envelopeIds: ids });
      const saved = await tx.budgetBaseline.update({ where: { id }, data: { rowCount: rows, totalReporting: total } });
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "baseline.saved", entityType: "budget_baseline", entityId: id, after: { name: input.name, kind: input.kind, scope: input.scope, rows, total }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "baseline.saved", payload: { baselineId: id, name: input.name, kind: input.kind, rows } });
      return view(tx, saved);
    },
    { timeoutMs: 120_000 },
  );
}

/** PATCH /baselines/:id — rename, note, kind, archive; the rows never change. */
export async function updateBaseline(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown): Promise<BaselineView> {
  const id = parseId(rawId);
  const input = parseInput(UpdateBaselineInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const before = await tx.budgetBaseline.findFirst({ where: { id, workspaceId } });
    if (before === null) throw new DomainError("NOT_FOUND", "Snapshot not found");
    await assertMayManage(tx, auth, (before.scope ?? {}) as BaselineScope);
    const saved = await tx.budgetBaseline.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
      },
    });
    const action = input.archived === true ? "baseline.archived" : input.archived === false ? "baseline.restored" : "baseline.updated";
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "budget_baseline", entityId: id, before: { name: before.name, kind: before.kind, note: before.note, archivedAt: before.archivedAt }, after: input, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "baseline.changed", payload: { baselineId: id, action } });
    return view(tx, saved);
  });
}
