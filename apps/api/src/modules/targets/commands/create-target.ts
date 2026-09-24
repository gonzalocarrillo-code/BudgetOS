import { CreateTargetDraftInput, CreateTargetInput, DomainError, newId } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { Prisma, PrismaClient, Target } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { activeMetric, lockTargetForWrite, recordTargetChange, targetCurrency, targetHead, versionView, writeTargetDraft } from "./target-writer.js";

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function targetView(t: Target) {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    scopeType: t.scopeType,
    envelopeId: t.envelopeId,
    scopeFilter: t.scopeFilter,
    metricKey: t.metricKey,
    startDate: isoDate(t.startDate),
    endDate: isoDate(t.endDate),
    ownerId: t.ownerId,
    status: t.status,
    currentVersionId: t.currentVersionId,
    draftVersionId: t.draftVersionId,
  };
}

/**
 * POST /workspaces/:ws/targets (spec §10). Creates the target and its first DRAFT version; submit
 * makes it current. One active envelope target per (envelope, metric): change it with a new draft.
 */
export async function createTarget(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateTargetInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const metric = await activeMetric(tx, auth.user.orgId, input.metricKey);
    let envelopeId: string | null = null;
    let startDate = input.startDate;
    let endDate = input.endDate;
    if (input.scope.type === "envelope") {
      const env = await tx.envelope.findUnique({ where: { id: input.scope.envelopeId } });
      if (env === null || env.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Envelope not found");
      if (env.status === "ARCHIVED") throw new DomainError("CONFLICT", "Envelope is archived");
      assertInScope(auth, "target.edit_draft", await envelopeScopeTarget(tx, env.id));
      const clash = await tx.target.findFirst({ where: { envelopeId: env.id, metricKey: input.metricKey, scopeType: "envelope", status: "active" }, select: { id: true } });
      if (clash) throw new DomainError("CONFLICT", "This envelope already has a target for the metric; add a draft to it", { targetId: clash.id });
      envelopeId = env.id;
      startDate ??= isoDate(env.startDate);
      endDate ??= isoDate(env.endDate);
    } else {
      assertInScope(auth, "target.edit_draft", { dims: {}, ancestors: {} });
    }
    if (startDate === undefined || endDate === undefined) throw new DomainError("VALIDATION", "Target dates are required");
    if (startDate > endDate) throw new DomainError("VALIDATION", "startDate after endDate");

    const target = await tx.target.create({
      data: {
        id: newId(),
        workspaceId,
        scopeType: input.scope.type,
        envelopeId,
        ...(input.scope.type === "filter" ? { scopeFilter: input.scope.filter as Prisma.InputJsonObject } : {}),
        metricKey: input.metricKey,
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: new Date(`${endDate}T00:00:00Z`),
        ownerId: input.ownerId ?? null,
      },
    });
    const currency = await targetCurrency(tx, workspaceId, metric.format);
    const version = await writeTargetDraft(tx, auth, target, { ...input, currency });
    await recordTargetChange(tx, auth.ctx, {
      workspaceId,
      targetId: target.id,
      action: "target.created",
      kind: "created",
      after: { scopeType: target.scopeType, envelopeId, metricKey: target.metricKey, startDate, endDate, versionId: version.id, value: version.value.toString(), comparator: version.comparator },
      reason: input.rationale,
    });
    return { ...targetView({ ...target, draftVersionId: version.id }), draft: versionView(version) };
  });
}

/** PATCH /targets/:id/draft. Targets are never updated in place: a change is a new target_version. */
export async function createTargetDraft(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const targetId = parseId(rawId);
  const input = parseInput(CreateTargetDraftInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const t = await lockTargetForWrite(tx, auth, targetId, "target.edit_draft");
    const head = targetHead(t);
    if ((input.basedOnVersionId ?? null) !== head) throw new DomainError("CONFLICT", "Target changed since you loaded it", { currentVersionId: head });
    if (t.draftVersionId) {
      const draft = await tx.targetVersion.findUniqueOrThrow({ where: { id: t.draftVersionId }, select: { status: true } });
      if (draft.status === "PENDING") throw new DomainError("CONFLICT", "A version of this target is awaiting approval", { currentVersionId: t.draftVersionId });
    }
    const metric = await activeMetric(tx, auth.user.orgId, t.metricKey);
    const version = await writeTargetDraft(tx, auth, t, { ...input, currency: await targetCurrency(tx, t.workspaceId, metric.format) });
    await recordTargetChange(tx, auth.ctx, {
      workspaceId: t.workspaceId,
      targetId,
      action: "target.version.created",
      kind: "draft",
      before: { versionId: head },
      after: { versionId: version.id, versionNo: version.versionNo, value: version.value.toString(), comparator: version.comparator },
      reason: input.rationale,
    });
    return versionView(version);
  });
}
