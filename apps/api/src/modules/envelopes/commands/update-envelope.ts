import { DomainError, UpdateEnvelopeInput } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { headVersionId, lockForWrite, recordEnvelopeChange } from "./version-writer.js";

/** PATCH /envelopes/:id: metadata with optimistic concurrency on rowVersion. Amounts never change here. */
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
    const before = await tx.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { name: true, ownerId: true, startDate: true, endDate: true, periodId: true } });
    const updated = await tx.envelope.update({
      where: { id: envelopeId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        ...(input.periodId !== undefined ? { periodId: input.periodId } : {}),
        ...(input.startDate !== undefined ? { startDate: new Date(`${input.startDate}T00:00:00Z`) } : {}),
        ...(input.endDate !== undefined ? { endDate: new Date(`${input.endDate}T00:00:00Z`) } : {}),
        rowVersion: { increment: 1 },
      },
    });
    const { rowVersion: _rv, ...changes } = input;
    void _rv;
    await recordEnvelopeChange(tx, auth, {
      workspaceId: env.workspaceId,
      envelopeId,
      action: "envelope.updated",
      kind: "metadata",
      before,
      after: { ...changes, rowVersion: updated.rowVersion },
    });
    return updated;
  });
}
