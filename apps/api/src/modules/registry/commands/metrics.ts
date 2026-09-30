import { CreateMetricInput, DomainError, newId, type Role } from "@budget/domain";
import { DEFAULT_METRICS, type TenantContext, type Tx } from "@budget/db";
import type { MetricDefinition, PrismaClient } from "@prisma/client";
import { assertCanManage, inWorkspace, parseInput, recordChange, type WorkspaceRef } from "../context.js";

export function metricView(m: MetricDefinition) {
  return {
    id: m.id,
    key: m.key,
    label: m.label,
    numerator: m.numerator,
    denominator: m.denominator,
    multiplier: m.multiplier.toString(),
    direction: m.direction,
    format: m.format,
    unit: m.unit,
    isActive: m.isActive,
    /** ORG-007: the shared library (superadmins) or this workspace's own. */
    scope: m.workspaceId === null ? ("shared" as const) : ("workspace" as const),
  };
}

async function insertMetric(tx: Tx, ctx: TenantContext, workspace: WorkspaceRef, input: CreateMetricInput, shared: boolean) {
  const clash = await tx.metricDefinition.findUnique({ where: { orgId_key: { orgId: workspace.orgId, key: input.key } }, select: { id: true } });
  // Keys are unique per org; another workspace's metric is invisible here, and the insert says so.
  if (clash) throw new DomainError("CONFLICT", `Metric ${input.key} already exists`, { metricId: clash.id });
  const row = await tx.metricDefinition.create({
    data: {
      id: newId(),
      orgId: workspace.orgId,
      workspaceId: shared ? null : workspace.id,
      key: input.key,
      label: input.label,
      numerator: input.numerator,
      denominator: input.denominator,
      multiplier: input.multiplier,
      direction: input.direction,
      format: input.format,
      unit: input.unit ?? null,
    },
  }).catch((e: unknown) => {
    if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", `The key ${input.key} is taken in this organization; pick another`);
    throw e;
  });
  await recordChange(tx, ctx, { workspaceId: workspace.id, orgId: workspace.orgId, action: "metric.created", entityType: "metric_definition", entityId: row.id, kind: "metric", after: metricView(row) });
  return row;
}

/**
 * POST /workspaces/:ws/metrics (plan §4.8): an admin defines a numerator / denominator over facts,
 * no deploy. A superadmin adds to the shared library; a workspace admin adds the workspace's own
 * metric, which no other workspace sees (ORG-007, RLS).
 */
export async function createMetric(prisma: PrismaClient, ctx: TenantContext, roles: Role[], raw: unknown) {
  assertCanManage(roles);
  const input = parseInput(CreateMetricInput, raw);
  return inWorkspace(prisma, ctx, async (tx, workspace) => metricView(await insertMetric(tx, ctx, workspace, input, ctx.isOrgAdmin)));
}

/** Seeds plan §4.8's default metrics into the org; skips keys that exist. */
export async function seedDefaultMetrics(prisma: PrismaClient, ctx: TenantContext): Promise<number> {
  if (!ctx.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only an org admin can seed metrics");
  return inWorkspace(prisma, ctx, async (tx, workspace) => ensureDefaultMetrics(tx, ctx, workspace));
}

/**
 * The default metrics in the org's library, inside the caller's transaction: a new workspace's
 * pacing rules name CPA and ROAS, so its org must have them (R11-001). Existing keys are kept.
 */
export async function ensureDefaultMetrics(tx: Tx, ctx: TenantContext, workspace: WorkspaceRef): Promise<number> {
  let created = 0;
  for (const m of DEFAULT_METRICS) {
    if (await tx.metricDefinition.findUnique({ where: { orgId_key: { orgId: workspace.orgId, key: m.key } }, select: { id: true } })) continue;
    await insertMetric(tx, ctx, workspace, parseInput(CreateMetricInput, m), true);
    created += 1;
  }
  return created;
}

/** GET /workspaces/:ws/metrics: the org's library, active first, by key. */
export function listMetrics(prisma: PrismaClient, ctx: TenantContext) {
  return inWorkspace(prisma, ctx, async (tx, workspace) => {
    const rows = await tx.metricDefinition.findMany({ where: { orgId: workspace.orgId }, orderBy: [{ isActive: "desc" }, { key: "asc" }] });
    return rows.map(metricView);
  });
}
