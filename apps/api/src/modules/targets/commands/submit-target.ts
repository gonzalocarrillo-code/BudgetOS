import { DomainError, SubmitVersionInput, newId } from "@budget/domain";
import { withTenant, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { addHours, recordRequestChange, type PolicySnapshot } from "../../approvals/engine.js";
import { matchPolicy, type DiffFacts } from "../../approvals/policy-matcher.js";
import { approveTargetVersion } from "./approve-target-version.js";
import { lockTargetForWrite } from "./target-writer.js";

const DAY_MS = 86_400_000;

/** Policy facts for a target version (spec §10: entityType target_version, metricKey, deltaPct). */
async function targetFacts(tx: Tx, t: { envelopeId: string | null; metricKey: string; endDate: string; currentVersionId: string | null }, value: Decimal, today = new Date()) {
  const current = t.currentVersionId ? await tx.targetVersion.findUnique({ where: { id: t.currentVersionId }, select: { value: true } }) : null;
  const before = current ? new Decimal(current.value.toString()) : null;
  const delta = value.minus(before ?? 0);
  const env = t.envelopeId ? await tx.envelope.findUnique({ where: { id: t.envelopeId }, select: { name: true, parentId: true, dimensionValues: true } }) : null;
  let level = 0;
  for (let p = env?.parentId ?? null; p !== null && level < 64; level += 1) {
    const up: { parentId: string | null } | null = await tx.envelope.findUnique({ where: { id: p }, select: { parentId: true } });
    p = up?.parentId ?? null;
  }
  const end = new Date(`${t.endDate}T00:00:00Z`).getTime();
  const facts: DiffFacts = {
    entityType: "target_version",
    amountAbs: value,
    deltaAbs: delta,
    deltaPct: before === null || before.isZero() ? new Decimal(1) : delta.div(before),
    isOverAllocation: false,
    level,
    dimensionValues: (env?.dimensionValues ?? {}) as Record<string, string>,
    daysRemaining: Math.max(0, Math.ceil((end - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / DAY_MS)),
    metricKey: t.metricKey,
  };
  return { facts, before, name: env?.name ?? "filter scope" };
}

/**
 * POST /targets/:id/submit (spec §10). Same flow as an envelope version: first matching policy by
 * priority, frozen on the request; an empty chain approves at once.
 */
export async function submitTarget(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const targetId = parseId(rawId);
  const input = parseInput(SubmitVersionInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const t = await lockTargetForWrite(tx, auth, targetId, "target.submit");
    if (t.draftVersionId !== input.versionId) {
      throw new DomainError("CONFLICT", "Only the open draft can be submitted", { currentVersionId: t.draftVersionId ?? t.currentVersionId });
    }
    const v = await tx.targetVersion.findUniqueOrThrow({ where: { id: input.versionId } });
    if (v.status !== "DRAFT") throw new DomainError("CONFLICT", `Version is ${v.status}`, { currentVersionId: v.id });

    const versionIds = (await tx.targetVersion.findMany({ where: { targetId }, select: { id: true } })).map((x) => x.id);
    const open = await tx.approvalRequest.findMany({
      where: { entityType: "target_version", entityId: { in: versionIds }, status: { in: ["PENDING", "ESCALATED", "CHANGES_REQUESTED"] } },
      select: { id: true, status: true },
    });
    if (open.some((r) => r.status !== "CHANGES_REQUESTED")) throw new DomainError("CONFLICT", "An approval request is already open for this target");
    const blocking = await tx.thread.count({ where: { anchorType: "target", anchorId: targetId, status: "open", isBlocking: true } });
    if (blocking > 0) throw new DomainError("CONFLICT", "Resolve blocking threads before submitting", { blockingThreads: blocking });
    const superseded = open.map((r) => r.id);
    if (superseded.length) await tx.approvalRequest.updateMany({ where: { id: { in: superseded } }, data: { status: "WITHDRAWN", resolvedAt: new Date() } });

    const value = new Decimal(v.value.toString());
    const { facts, before, name } = await targetFacts(tx, t, value);
    const policy = await matchPolicy(tx, t.workspaceId, facts);
    if (policy === null) throw new DomainError("POLICY_NOT_FOUND", "No approval policy matched");
    const policyRef = { id: policy.id, name: policy.name, version: policy.version };
    if (policy.chain.length === 0) {
      await approveTargetVersion(tx, auth.ctx, v.id, null, `auto-approved by policy ${policy.name} v${policy.version}`);
      return { autoApproved: true as const, requestId: null, versionId: v.id, policy: policyRef };
    }

    const snapshot: PolicySnapshot = {
      conditions: policy.conditionsParsed,
      chain: policy.chain,
      blockSelfApproval: policy.blockSelfApproval,
      allowExternalEvidence: policy.allowExternalEvidence,
      policyName: policy.name,
    };
    const pct = before === null ? "new" : `${facts.deltaPct.mul(100).toDecimalPlaces(1).toFixed(1)}%`;
    const request = await tx.approvalRequest.create({
      data: {
        id: newId(),
        workspaceId: t.workspaceId,
        entityType: "target_version",
        entityId: v.id,
        policyId: policy.id,
        policyVersion: policy.version,
        policySnapshot: snapshot as unknown as Prisma.InputJsonObject,
        currentStep: 0,
        status: "PENDING",
        summary: `${t.metricKey} target on ${name}: ${before?.toString() ?? "none"} → ${value.toString()} (${pct}).${v.rationale ? ` Rationale: ${v.rationale.slice(0, 280)}` : ""}`,
        requestedBy: auth.user.id,
        dueAt: addHours(new Date(), policy.chain[0]?.timeoutHours ?? 48),
      },
    });
    await tx.targetVersion.update({ where: { id: v.id }, data: { status: "PENDING", approvalRequestId: request.id } });
    await recordRequestChange(tx, auth.ctx, request, "approval.requested", {
      targetVersionId: v.id,
      targetId,
      policy: policy.name,
      policyVersion: policy.version,
      status: "PENDING",
      step: 0,
      supersededRequests: superseded,
    });
    return { autoApproved: false as const, requestId: request.id, versionId: v.id, policy: policyRef };
  });
}
