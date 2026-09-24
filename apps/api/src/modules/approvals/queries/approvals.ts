import { DomainError, canInScope, eligibleApprover, type Role } from "@budget/domain";
import { eligibleApproverSql, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTargets } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { PolicySnapshot, requestTargets } from "../engine.js";

const STATUSES = ["PENDING", "APPROVED", "REJECTED", "CHANGES_REQUESTED", "WITHDRAWN", "ESCALATED"] as const;
type Status = (typeof STATUSES)[number];

export interface ListApprovalsQuery {
  status?: string | undefined;
  assignee?: string | undefined;
  limit?: string | undefined;
  cursor?: string | undefined;
}

function parseQuery(q: ListApprovalsQuery) {
  const statuses = (q.status ? q.status.split(",") : ["PENDING", "ESCALATED"]).map((s) => s.trim().toUpperCase());
  if (!statuses.every((s): s is Status => (STATUSES as readonly string[]).includes(s))) throw new DomainError("VALIDATION", "Unknown status", { allowed: STATUSES });
  if (q.assignee !== undefined && q.assignee !== "me") throw new DomainError("VALIDATION", "assignee must be 'me'");
  const limit = q.limit === undefined ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DomainError("VALIDATION", "limit must be 1..200");
  let after: { at: Date; id: string } | null = null;
  if (q.cursor) {
    try {
      const [at, id] = JSON.parse(Buffer.from(q.cursor, "base64url").toString()) as [string, string];
      after = { at: new Date(at), id: parseId(id) };
    } catch {
      throw new DomainError("VALIDATION", "malformed cursor");
    }
  }
  return { statuses: statuses as Status[], mine: q.assignee === "me", limit, after };
}

/**
 * GET /approvals (the Inbox). `assignee=me` keeps requests whose current step the caller may decide:
 * SQL eligible_approver() plus the app-side scope and self-approval check. Newest first, keyset cursor.
 */
export async function listApprovals(prisma: PrismaClient, auth: AuthContext, query: ListApprovalsQuery) {
  const q = parseQuery(query);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const out: Array<Record<string, unknown>> = [];
    let after = q.after;
    // Eligibility filtering happens per row, so read in batches until a page is full.
    for (let round = 0; round < 20 && out.length < q.limit; round += 1) {
      const batch = await tx.approvalRequest.findMany({
        where: {
          status: { in: q.statuses },
          ...(after ? { OR: [{ requestedAt: { lt: after.at } }, { requestedAt: after.at, id: { lt: after.id } }] } : {}),
        },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: q.limit * 2,
      });
      if (batch.length === 0) break;
      for (const r of batch) {
        after = { at: r.requestedAt, id: r.id };
        if (r.entityType !== "envelope_version" && r.entityType !== "bulk_change") continue;
        const targets = await requestTargets(tx, r).catch(() => null);
        if (targets === null || targets.versions.length === 0) continue;
        const scopes = [...(await envelopeScopeTargets(tx, [...new Set(targets.versions.map((v) => v.envelopeId))])).values()];
        if (q.mine) {
          const snapshot = PolicySnapshot.safeParse(r.policySnapshot);
          const step = snapshot.success ? snapshot.data.chain[r.currentStep] : undefined;
          if (step === undefined || !snapshot.success) continue;
          const ok =
            (await eligibleApproverSql(tx, r.id, auth.user.id)) &&
            scopes.every((target) =>
              eligibleApprover({ assignments: auth.assignments, stepRole: step.role as Role, target, userId: auth.user.id, authorId: targets.authorId, blockSelfApproval: snapshot.data.blockSelfApproval }),
            );
          if (!ok) continue;
        } else if (!auth.isOrgAdmin && !scopes.every((target) => canInScope(auth.assignments, "envelope.read", target))) {
          continue;
        }
        const single = r.entityType === "envelope_version" ? await tx.envelopeVersion.findUnique({ where: { id: r.entityId }, select: { versionNo: true, amount: true } }) : null;
        out.push({
          id: r.id,
          entityType: r.entityType,
          status: r.status,
          summary: r.summary,
          envelopeId: r.entityType === "envelope_version" ? (targets.versions[0]?.envelopeId ?? null) : null,
          versionId: r.entityType === "envelope_version" ? r.entityId : null,
          versionNo: single?.versionNo ?? null,
          amount: single?.amount.toFixed(2) ?? null,
          rows: targets.versions.length,
          currentStep: r.currentStep,
          policyId: r.policyId,
          policyVersion: r.policyVersion,
          requestedBy: r.requestedBy,
          requestedAt: r.requestedAt.toISOString(),
          dueAt: r.dueAt?.toISOString() ?? null,
        });
        if (out.length === q.limit) break;
      }
      if (batch.length < q.limit * 2) break; // no more rows
    }
    const last = out[out.length - 1];
    const nextCursor = out.length === q.limit && last ? Buffer.from(JSON.stringify([last["requestedAt"], last["id"]])).toString("base64url") : null;
    return { rows: out, nextCursor };
  });
}

/** GET /approvals/:id: the request, its frozen policy, every decision, and the diff it asks for. */
export async function getApproval(prisma: PrismaClient, auth: AuthContext, rawId: string) {
  const id = parseId(rawId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const r = await tx.approvalRequest.findUnique({ where: { id }, include: { decisions: { orderBy: { decidedAt: "asc" } } } });
    if (r === null) throw new DomainError("NOT_FOUND", "Request not found");
    const targets = await requestTargets(tx, r);
    const envelopeIds = [...new Set(targets.versions.map((v) => v.envelopeId))];
    for (const t of (await envelopeScopeTargets(tx, envelopeIds)).values()) assertInScope(auth, "envelope.read", t);
    const versions = await tx.envelopeVersion.findMany({ where: { id: { in: targets.versions.map((v) => v.id) } }, include: { envelope: true } });
    const currentIds = versions.map((v) => v.envelope.currentVersionId).filter((x): x is string => x !== null);
    const currents = new Map((await tx.envelopeVersion.findMany({ where: { id: { in: currentIds } }, select: { id: true, amountReporting: true } })).map((c) => [c.id, c]));
    const rows = versions.map((v) => ({
      envelopeId: v.envelopeId,
      envelopeName: v.envelope.name,
      versionId: v.id,
      versionNo: v.versionNo,
      status: v.status,
      amount: v.amount.toFixed(2),
      amountReporting: v.amountReporting.toFixed(2),
      approvedAmountReporting: v.envelope.currentVersionId ? (currents.get(v.envelope.currentVersionId)?.amountReporting.toFixed(2) ?? null) : null,
      rationale: v.rationale,
    }));
    const first = versions[0];
    return {
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      status: r.status,
      summary: r.summary,
      currentStep: r.currentStep,
      policyId: r.policyId,
      policyVersion: r.policyVersion,
      policySnapshot: r.policySnapshot,
      requestedBy: r.requestedBy,
      requestedAt: r.requestedAt.toISOString(),
      dueAt: r.dueAt?.toISOString() ?? null,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      envelope: r.entityType === "envelope_version" && first ? { id: first.envelope.id, name: first.envelope.name, currency: first.envelope.currency, dimensionValues: first.envelope.dimensionValues } : null,
      diff: r.entityType === "envelope_version" && rows[0] ? { ...rows[0] } : null,
      rows,
      decisions: r.decisions.map((d) => ({
        id: d.id,
        stepIndex: d.stepIndex,
        decidedBy: d.decidedBy,
        decision: d.decision,
        comment: d.comment,
        evidence: d.evidence,
        channel: d.channel,
        decidedAt: d.decidedAt.toISOString(),
      })),
    };
  });
}

/** GET /workspaces/:ws/policies. */
export function listPolicies(prisma: PrismaClient, auth: AuthContext) {
  return withTenant(prisma, auth.ctx, (tx) => tx.approvalPolicy.findMany({ where: { workspaceId: auth.ctx.workspaceId ?? "" }, orderBy: [{ priority: "asc" }, { name: "asc" }] }));
}
