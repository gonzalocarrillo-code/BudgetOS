import { CreateEnvelopeInput, DomainError, newId, type Action } from "@budget/domain";
import { recomputeNames, withTenant, type LockedEnvelopeRow, type Tx } from "@budget/db";
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
export interface EnvelopeRowInput {
  name: string;
  parentId: string | null;
  dimensionValues: Record<string, string>;
  startDate: string;
  endDate: string;
  currency: string;
  ownerId: string | null;
  periodId: string | null;
}

/**
 * Inserts an envelope and its envelope_dimension rows inside the caller's transaction: registry
 * tuple (T-005), caller scope for `action`, parent and owner checks. Used by create, split, merge.
 */
export async function insertEnvelopeRow(tx: Tx, auth: AuthContext, workspaceId: string, input: EnvelopeRowInput, action: Action): Promise<LockedEnvelopeRow> {
  const { valueIds } = await validateTuple(tx, workspaceId, input.dimensionValues);
  const values = await tx.dimensionValue.findMany({ where: { id: { in: Object.values(valueIds) } }, select: { id: true, dimensionId: true } });
  const pairs = values.map((v) => ({ dimensionId: v.dimensionId, valueId: v.id }));
  assertInScope(auth, action, await scopeTargetForValues(tx, pairs));
  if (input.parentId !== null) {
    const parent = await tx.envelope.findUnique({ where: { id: input.parentId }, select: { id: true, status: true } });
    if (parent === null) throw new DomainError("NOT_FOUND", "Parent envelope not found");
    if (parent.status === "LOCKED") throw new DomainError("LOCKED", "Parent period is closed");
    if (parent.status === "ARCHIVED") throw new DomainError("CONFLICT", "Parent envelope is archived");
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
  return { id, workspaceId, status: "DRAFT", currency: input.currency, startDate: input.startDate, endDate: input.endDate, draftVersionId: null, currentVersionId: null, rowVersion: 1 };
}

export async function createEnvelope(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateEnvelopeInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, (tx) => createEnvelopeIn(tx, auth, workspaceId, input));
}

/** The create inside a caller's transaction. */
export async function createEnvelopeIn(tx: Tx, auth: AuthContext, workspaceId: string, input: CreateEnvelopeInput) {
  const env = await insertEnvelopeRow(tx, auth, workspaceId, input, "envelope.create");
  const id = env.id;
  let versionId: string | null = null;
  if (input.amount !== undefined) {
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
  await recomputeNames(tx, workspaceId, [id]); // T-036: display name and match key from the active templates
  return tx.envelope.findUniqueOrThrow({ where: { id } });
}
