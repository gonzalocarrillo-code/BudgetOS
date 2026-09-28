import { DomainError, UpdateEnvelopeInput } from "@budget/domain";
import { recomputeNames, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import { assertInScope, scopeTargetForValues } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { validateTuple } from "../../registry/commands/validate-tuple.js";
import { headVersionId, lockForWrite, recordEnvelopeChange } from "./version-writer.js";

/**
 * PATCH /envelopes/:id: metadata with optimistic concurrency on rowVersion. Amounts never change
 * here. New granularities (product feedback 2026-09-28) follow the registry and the caller's
 * scope, as on create; the budget moves in every hierarchy, so the roll-ups rebuild.
 */
export async function updateEnvelope(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const envelopeId = parseId(rawId);
  const input = parseInput(UpdateEnvelopeInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const env = await lockForWrite(tx, auth, envelopeId, "envelope.edit_draft");
    if (input.rowVersion !== env.rowVersion) {
      throw new DomainError("CONFLICT", "Envelope changed since you loaded it", {
        currentRowVersion: env.rowVersion,
        currentVersionId: headVersionId(env),
      });
    }
    const startDate = input.startDate ?? env.startDate;
    const endDate = input.endDate ?? env.endDate;
    if (startDate > endDate) throw new DomainError("VALIDATION", "startDate must not be after endDate");
    if (input.ownerId) {
      const owner = await tx.user.findFirst({ where: { id: input.ownerId, orgId: auth.user.orgId }, select: { id: true } });
      if (owner === null) throw new DomainError("NOT_FOUND", "Owner not found");
    }
    const before = await tx.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { name: true, ownerId: true, startDate: true, endDate: true, periodId: true, dimensionValues: true } });
    if (input.dimensionValues !== undefined) {
      const { valueIds } = await validateTuple(tx, env.workspaceId, input.dimensionValues);
      const values = await tx.dimensionValue.findMany({ where: { id: { in: Object.values(valueIds) } }, select: { id: true, dimensionId: true } });
      const pairs = values.map((v) => ({ dimensionId: v.dimensionId, valueId: v.id }));
      assertInScope(auth, "envelope.edit_draft", await scopeTargetForValues(tx, pairs));
      await tx.envelopeDimension.deleteMany({ where: { envelopeId } });
      if (pairs.length) await tx.envelopeDimension.createMany({ data: pairs.map((p) => ({ envelopeId, ...p })) });
    }
    const updated = await tx.envelope.update({
      where: { id: envelopeId },
      data: {
        // A rename is the budget's name from now on, whatever the display naming template says.
        ...(input.name !== undefined ? { name: input.name, nameCustom: true, displayName: null } : {}),
        ...(input.useTemplateName ? { nameCustom: false } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        ...(input.periodId !== undefined ? { periodId: input.periodId } : {}),
        ...(input.startDate !== undefined ? { startDate: new Date(`${input.startDate}T00:00:00Z`) } : {}),
        ...(input.endDate !== undefined ? { endDate: new Date(`${input.endDate}T00:00:00Z`) } : {}),
        ...(input.dimensionValues !== undefined ? { dimensionValues: input.dimensionValues } : {}),
        rowVersion: { increment: 1 },
      },
    });
    if (input.useTemplateName || input.dimensionValues !== undefined) await recomputeNames(tx, env.workspaceId, [envelopeId]);
    const { rowVersion: _rv, ...changes } = input;
    void _rv;
    await recordEnvelopeChange(tx, auth, {
      workspaceId: env.workspaceId,
      envelopeId,
      action: "envelope.updated",
      kind: input.dimensionValues !== undefined ? "granularities" : "metadata",
      before,
      after: { ...changes, rowVersion: updated.rowVersion },
    });
    return updated;
  });
}
