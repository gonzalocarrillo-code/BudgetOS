import { DomainError, MergeValuesInput, type Role } from "@budget/domain";
import { insertRewriteAudits, rewriteMergedValue, type TenantContext } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { assertCanManage, inWorkspace, parseInput, recordChange } from "../context.js";
import { assertCanEditDimension, requireDimension } from "../dimensions.js";

export async function mergeValues(
  prisma: PrismaClient,
  ctx: TenantContext,
  roles: Role[],
  dimensionId: string,
  raw: unknown,
): Promise<{ envelopeIds: string[] }> {
  assertCanManage(roles);
  const input = parseInput(MergeValuesInput, raw);
  if (input.fromCode === input.intoCode) {
    throw new DomainError("VALIDATION", "Cannot merge a value into itself");
  }
  return inWorkspace(prisma, ctx, async (tx, workspace) => {
    const dimension = await requireDimension(tx, dimensionId, workspace.orgId);
    assertCanEditDimension(dimension, ctx);
    const from = await tx.dimensionValue.findFirst({
      where: { dimensionId: dimension.id, code: input.fromCode },
    });
    const into = await tx.dimensionValue.findFirst({
      where: { dimensionId: dimension.id, code: input.intoCode, isActive: true, mergedIntoId: null },
    });
    if (from === null || into === null) {
      throw new DomainError("NOT_FOUND", "Dimension value not found");
    }
    const envelopeIds = await rewriteMergedValue(tx, {
      dimensionKey: dimension.key,
      fromValueId: from.id,
      intoValueId: into.id,
      intoCode: into.code,
    });
    await tx.dimensionValue.update({
      where: { id: from.id },
      data: { mergedIntoId: into.id, isActive: false, retiredAt: new Date() },
    });
    await tx.dimensionValue.update({
      where: { id: into.id },
      data: { aliases: { push: from.code } },
    });
    await insertRewriteAudits(tx, {
      envelopeIds,
      actorId: ctx.userId,
      actorType: ctx.actorType,
      fromValueId: from.id,
      intoValueId: into.id,
      requestId: ctx.requestId,
    });
    await recordChange(tx, ctx, {
      workspaceId: workspace.id,
      orgId: workspace.orgId,
      action: "registry.value.merged",
      entityType: "dimension",
      entityId: dimension.id,
      kind: "value.merged",
      after: { dimensionId: dimension.id, fromCode: from.code, intoCode: into.code, envelopeIds },
    });
    return { envelopeIds };
  });
}
