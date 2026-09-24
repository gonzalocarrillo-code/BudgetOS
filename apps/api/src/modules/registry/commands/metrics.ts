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
  };
}

async function insertMetric(tx: Tx, ctx: TenantContext, workspace: WorkspaceRef, input: CreateMetricInput) {
  const clash = await tx.metricDefinition.findUnique({ where: { orgId_key: { orgId: workspace.orgId, key: input.key } }, select: { id: true } });
  if (clash) throw new DomainError("CONFLICT", `Metric ${input.key} already exists`, { metricId: clash.id });
  const row = await tx.metricDefinition.create({
    data: {
      id: newId(),
      orgId: workspace.orgId,
      key: input.key,
      label: input.label,
      numerator: input.numerator,
      denominator: input.denominator,
      multiplier: input.multiplier,
      direction: input.direction,
      format: input.format,
      unit: input.unit ?? null,
    },
  });
  await recordChange(tx, ctx, { workspaceId: workspace.id, orgId: workspace.orgId, action: "metric.created", entityType: "metric_definition", entityId: row.id, kind: "metric", after: metricView(row) });
  return row;
}

/**
 * POST /workspaces/:ws/metrics (plan §4.8): an admin defines a numerator / denominator over facts,
 * no deploy. Metrics are org-level; RLS lets only the org admin write them.
 */
export async function createMetric(prisma: PrismaClient, ctx: TenantContext, roles: Role[], raw: unknown) {
  assertCanManage(roles);
  const input = parseInput(CreateMetricInput, raw);
  if (!ctx.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only an org admin can add metrics");
  return inWorkspace(prisma, ctx, async (tx, workspace) => metricView(await insertMetric(tx, ctx, workspace, input)));
}

/** Seeds plan §4.8's default metrics into the org; skips keys that exist. */
export async function seedDefaultMetrics(prisma: PrismaClient, ctx: TenantContext): Promise<number> {
  if (!ctx.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only an org admin can seed metrics");
  return inWorkspace(prisma, ctx, async (tx, workspace) => {
    let created = 0;
    for (const m of DEFAULT_METRICS) {
      if (await tx.metricDefinition.findUnique({ where: { orgId_key: { orgId: workspace.orgId, key: m.key } }, select: { id: true } })) continue;
      await insertMetric(tx, ctx, workspace, parseInput(CreateMetricInput, m));
      created += 1;
    }
    return created;
  });
}

/** GET /workspaces/:ws/metrics: the org's library, active first, by key. */
export function listMetrics(prisma: PrismaClient, ctx: TenantContext) {
  return inWorkspace(prisma, ctx, async (tx, workspace) => {
    const rows = await tx.metricDefinition.findMany({ where: { orgId: workspace.orgId }, orderBy: [{ isActive: "desc" }, { key: "asc" }] });
    return rows.map(metricView);
  });
}
