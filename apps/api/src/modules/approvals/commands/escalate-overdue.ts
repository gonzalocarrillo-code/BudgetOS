import { randomUUID } from "node:crypto";
import { lockApprovalRequest, withTenant, type TenantContext } from "@budget/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { addHours, recordRequestChange, snapshotOf } from "../engine.js";

const ESCALATION_TIMEOUT_HOURS = 72;

/**
 * escalateOverdue() (spec §9.3), run by the pacing job every 15 min for the orgs it serves. A PENDING request whose due
 * date passed and whose current step names `escalateTo` gets a synthetic step for that role right
 * after the current one; the request moves to it with status ESCALATED. The chain in the snapshot
 * records `escalatedFrom`; a synthetic step never escalates again.
 */
export async function escalateOverdue(prisma: PrismaClient, orgIds: readonly string[], now: Date = new Date()): Promise<{ escalated: string[] }> {
  const requestId = `escalate-${randomUUID()}`;
  // The org-admin bypass is scoped to app.org_id and `organization` itself has RLS (migrations
  // 20260924000000, 20260924030000), so the job cannot discover orgs: the scheduler passes them
  // (the pacing job, T-018, runs per org).
  const orgs = orgIds.map((id) => ({ id }));
  const due: Array<{ id: string; workspaceId: string; orgId: string }> = [];
  for (const org of orgs) {
    const scan: TenantContext = { workspaceId: null, orgId: org.id, userId: null, isOrgAdmin: true, actorType: "system", requestId };
    const rows = await withTenant(prisma, scan, (tx) =>
      tx.approvalRequest.findMany({ where: { status: "PENDING", dueAt: { lt: now } }, select: { id: true, workspaceId: true }, orderBy: { dueAt: "asc" }, take: 500 }),
    );
    due.push(...rows.map((r) => ({ ...r, orgId: org.id })));
  }
  const escalated: string[] = [];
  for (const d of due) {
    const ctx: TenantContext = { workspaceId: d.workspaceId, orgId: d.orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId };
    const done = await withTenant(prisma, ctx, async (tx) => {
      const r = await lockApprovalRequest(tx, d.id);
      if (r === null || r.status !== "PENDING") return false;
      const current = await tx.approvalRequest.findUniqueOrThrow({ where: { id: r.id }, select: { dueAt: true } });
      if (current.dueAt === null || current.dueAt >= now) return false;
      const snapshot = snapshotOf(r);
      const step = snapshot.chain[r.currentStep];
      if (step?.escalateTo === undefined) return false;
      const synthetic = { role: step.escalateTo, minApprovals: 1, timeoutHours: ESCALATION_TIMEOUT_HOURS, escalatedFrom: r.currentStep };
      const chain = [...snapshot.chain.slice(0, r.currentStep + 1), synthetic, ...snapshot.chain.slice(r.currentStep + 1)];
      await tx.approvalRequest.update({
        where: { id: r.id },
        data: {
          policySnapshot: { ...snapshot, chain } as unknown as Prisma.InputJsonObject,
          currentStep: r.currentStep + 1,
          status: "ESCALATED",
          dueAt: addHours(now, ESCALATION_TIMEOUT_HOURS),
        },
      });
      await recordRequestChange(tx, ctx, r, "approval.escalated", { fromStep: r.currentStep, toRole: step.escalateTo, status: "ESCALATED" });
      return true;
    });
    if (done) escalated.push(d.id);
  }
  return { escalated };
}
