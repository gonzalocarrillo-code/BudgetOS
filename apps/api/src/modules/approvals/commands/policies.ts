import { CreatePolicyInput, DomainError, UpdatePolicyInput, newId } from "@budget/domain";
import { DEFAULT_POLICIES, audit, outbox, withTenant, type TenantContext, type Tx } from "@budget/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

const json = (v: unknown) => v as Prisma.InputJsonValue;

async function recordPolicyChange(tx: Tx, ctx: TenantContext, workspaceId: string, policyId: string, action: string, before: unknown, after: Record<string, unknown>) {
  await audit(tx, { workspaceId, actorId: ctx.userId, actorType: ctx.actorType, action, entityType: "approval_policy", entityId: policyId, before: before ?? null, after, requestId: ctx.requestId });
  await outbox(tx, { workspaceId, topic: "policy.changed", payload: { policyId, action, version: after["version"] } });
}

async function insertPolicy(tx: Tx, ctx: TenantContext, workspaceId: string, input: CreatePolicyInput) {
  const clash = await tx.approvalPolicy.findFirst({ where: { workspaceId, name: input.name }, select: { id: true } });
  if (clash) throw new DomainError("CONFLICT", "A policy with this name exists", { policyId: clash.id });
  const row = await tx.approvalPolicy.create({
    data: {
      id: newId(),
      workspaceId,
      name: input.name,
      priority: input.priority,
      conditions: json(input.conditions),
      chain: json(input.chain),
      allowExternalEvidence: input.allowExternalEvidence,
      blockSelfApproval: input.blockSelfApproval,
    },
  });
  await recordPolicyChange(tx, ctx, workspaceId, row.id, "policy.created", null, { ...input, version: row.version });
  return row;
}

/** POST /workspaces/:ws/policies. */
export async function createPolicy(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreatePolicyInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, (tx) => insertPolicy(tx, auth.ctx, workspaceId, input));
}

/**
 * PATCH /policies/:id. Policies are configuration rows: a change bumps `version` (optimistic check
 * on the version the caller saw) and is audited with before/after. Requests already open keep the
 * snapshot and version they were created with (plan §8.1).
 */
export async function updatePolicy(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const id = parseId(rawId);
  const input = parseInput(UpdatePolicyInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const current = await tx.approvalPolicy.findUnique({ where: { id } });
    if (current === null || current.workspaceId !== auth.ctx.workspaceId) throw new DomainError("NOT_FOUND", "Policy not found");
    if (current.version !== input.version) throw new DomainError("CONFLICT", "Policy changed since you loaded it", { currentVersion: current.version });
    const { version: _v, ...changes } = input;
    void _v;
    const row = await tx.approvalPolicy.update({
      where: { id },
      data: {
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.priority !== undefined ? { priority: changes.priority } : {}),
        ...(changes.conditions !== undefined ? { conditions: json(changes.conditions) } : {}),
        ...(changes.chain !== undefined ? { chain: json(changes.chain) } : {}),
        ...(changes.allowExternalEvidence !== undefined ? { allowExternalEvidence: changes.allowExternalEvidence } : {}),
        ...(changes.blockSelfApproval !== undefined ? { blockSelfApproval: changes.blockSelfApproval } : {}),
        ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
        version: { increment: 1 },
      },
    });
    await recordPolicyChange(tx, auth.ctx, current.workspaceId, id, "policy.updated", current, { ...changes, version: row.version });
    return row;
  });
}

/** Seeds plan §8.1's templates plus Default and Auto-approve (spec §9.2) into a workspace; skips names that exist. */
export async function seedDefaultPolicies(prisma: PrismaClient, ctx: TenantContext): Promise<number> {
  const workspaceId = requireWorkspace(ctx.workspaceId);
  return withTenant(prisma, ctx, async (tx) => {
    let created = 0;
    for (const p of DEFAULT_POLICIES) {
      if (await tx.approvalPolicy.findFirst({ where: { workspaceId, name: p.name }, select: { id: true } })) continue;
      await insertPolicy(tx, ctx, workspaceId, parseInput(CreatePolicyInput, p));
      created += 1;
    }
    return created;
  });
}
