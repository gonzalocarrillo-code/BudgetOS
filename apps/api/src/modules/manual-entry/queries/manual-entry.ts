import { DomainError, ListManualEntriesQuery, ManualEntryTotals, type ManualEntryRowInput } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { ManualEntryBatch, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { validateBatch } from "../validate.js";

/** Manual result entry, read side (spec §26): the batches and one batch with its issues, decision and lineage. */

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function batchView(b: ManualEntryBatch) {
  const totals = ManualEntryTotals.safeParse(b.totals);
  return {
    id: b.id,
    workspaceId: b.workspaceId,
    channel: b.channel,
    periodStart: iso(b.periodStart),
    periodEnd: iso(b.periodEnd),
    status: b.status,
    rows: b.rows as ManualEntryRowInput[],
    totals: totals.success ? totals.data : { amount: null, byCurrency: {}, rows: 0 },
    approvalRequestId: b.approvalRequestId,
    createdBy: b.createdBy,
    createdAt: b.createdAt.toISOString(),
    submittedAt: b.submittedAt?.toISOString() ?? null,
  };
}

/** GET /workspaces/:ws/manual-entries?status=&channel= — newest first, without their rows. */
export async function listManualEntries(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const q = parseInput(ListManualEntriesQuery, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const statuses = q.status ? (q.status.split(",") as ManualEntryBatch["status"][]) : null;
  return withTenant(prisma, auth.ctx, async (tx) => {
    const rows = await tx.manualEntryBatch.findMany({ where: { workspaceId, ...(statuses ? { status: { in: statuses } } : {}), ...(q.channel ? { channel: q.channel } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200 });
    return rows.map((b) => ({ ...batchView(b), rows: undefined, rowCount: Array.isArray(b.rows) ? b.rows.length : 0 }));
  });
}

/**
 * GET /manual-entries/:id — the batch, its rows' issues and warnings (validated now), the latest
 * approval decision (a rejection's comment is why it is back in DRAFT) and, once approved, the
 * lineage of the facts it wrote.
 */
export async function getManualEntry(prisma: PrismaClient, auth: AuthContext, rawId: string) {
  const id = parseId(rawId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const b = await tx.manualEntryBatch.findUnique({ where: { id } });
    if (b === null) throw new DomainError("NOT_FOUND", "Manual entry batch not found");
    const v = await validateBatch(tx, { orgId: auth.user.orgId, workspaceId: b.workspaceId }, { channel: b.channel, periodStart: iso(b.periodStart), periodEnd: iso(b.periodEnd) }, b.rows as ManualEntryRowInput[]);
    const requests = await tx.approvalRequest.findMany({ where: { entityType: "manual_entry", entityId: b.id }, orderBy: { requestedAt: "desc" }, include: { decisions: { orderBy: { decidedAt: "desc" }, take: 1 } } });
    const last = requests[0];
    const decision = last?.decisions[0];
    const lineage = await tx.manualEntryFact.findMany({ where: { batchId: b.id }, orderBy: [{ rowNo: "asc" }, { factTable: "desc" }, { metric: "asc" }] });
    return {
      ...batchView(b),
      issues: b.status === "DRAFT" ? v.issues : [],
      warnings: v.warnings,
      lastRequest: last ? { id: last.id, status: last.status, requestedAt: last.requestedAt.toISOString(), resolvedAt: last.resolvedAt?.toISOString() ?? null, decision: decision ? { decision: decision.decision, comment: decision.comment, decidedBy: decision.decidedBy, decidedAt: decision.decidedAt.toISOString() } : null } : null,
      lineage: lineage.map((l) => ({ rowNo: l.rowNo, factTable: l.factTable, metric: l.metric, periodDate: iso(l.periodDate), enteredBy: l.enteredBy, approvedBy: l.approvedBy })),
    };
  });
}
