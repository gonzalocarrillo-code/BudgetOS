import { CreateEnvelopeInput, DomainError, newId } from "@budget/domain";
import { withTenant } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { assertInScope, scopeTargetForValues } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { validateTuple } from "../../registry/commands/validate-tuple.js";
import { recordEnvelopeChange, writeDraftVersion } from "./version-writer.js";

/**
 * POST /workspaces/:ws/envelopes. The dimension tuple must satisfy the registry (T-005) and the
 * caller's scope. An amount, when given, opens v1 as a DRAFT; approval is the only way to a budget.
 */
export async function createEnvelope(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateEnvelopeInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const { valueIds } = await validateTuple(tx, workspaceId, input.dimensionValues);
    const values = await tx.dimensionValue.findMany({ where: { id: { in: Object.values(valueIds) } }, select: { id: true, dimensionId: true } });
    const pairs = values.map((v) => ({ dimensionId: v.dimensionId, valueId: v.id }));
    assertInScope(auth, "envelope.create", await scopeTargetForValues(tx, pairs));

    if (input.parentId !== null) {
      const parent = await tx.envelope.findUnique({ where: { id: input.parentId }, select: { id: true, status: true } });
      if (parent === null) throw new DomainError("NOT_FOUND", "Parent envelope not found");
      if (parent.status === "LOCKED") throw new DomainError("LOCKED", "Parent period is closed");
    }
    if (input.ownerId !== null) {
      const owner = await tx.user.findFirst({ where: { id: input.ownerId, orgId: auth.user.orgId }, select: { id: true } });
      if (owner === null) throw new DomainError("NOT_FOUND", "Owner not found");
    }

    const id = newId();
    await tx.envelope.create({
      data: {
        id,
        workspaceId,
        parentId: input.parentId,
        name: input.name,
        dimensionValues: input.dimensionValues,
        periodId: input.periodId,
        startDate: new Date(`${input.startDate}T00:00:00Z`),
        endDate: new Date(`${input.endDate}T00:00:00Z`),
        currency: input.currency,
        ownerId: input.ownerId,
        createdBy: auth.user.id,
        dims: { create: pairs },
      },
    });
    let versionId: string | null = null;
    if (input.amount !== undefined) {
      const env = {
        id,
        workspaceId,
        status: "DRAFT" as const,
        currency: input.currency,
        startDate: input.startDate,
        endDate: input.endDate,
        draftVersionId: null,
        currentVersionId: null,
        rowVersion: 1,
      };
      const version = await writeDraftVersion(tx, auth, env, {
        amount: new Decimal(input.amount),
        phasing: input.phasing,
        rationale: input.rationale,
        attachments: [],
      });
      versionId = version.id;
    }
    await recordEnvelopeChange(tx, auth, {
      workspaceId,
      envelopeId: id,
      action: "envelope.created",
      kind: "created",
      after: { name: input.name, dimensionValues: input.dimensionValues, currency: input.currency, parentId: input.parentId, versionId, amount: input.amount ?? null },
      reason: input.rationale,
    });
    return tx.envelope.findUniqueOrThrow({ where: { id } });
  });
}
