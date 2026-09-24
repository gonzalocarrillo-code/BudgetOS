import { CreateRuleInput, DomainError, UpdateAlertInput, UpdateRuleInput, newId } from "@budget/domain";
import { DEFAULT_RULES, audit, outbox, withTenant, type TenantContext, type Tx } from "@budget/db";
import type { Alert, PacingRule, Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../common/scope.guard.js";
import type { AuthContext } from "../../common/tenant.js";

/** Pacing rules and the alert lifecycle API (spec §11). One audit_event + one outbox row per write. */

const json = (v: unknown) => v as Prisma.InputJsonValue;

export function ruleView(r: PacingRule) {
  return {
    id: r.id,
    name: r.name,
    scope: r.scope,
    metric: r.metric,
    metricArgs: r.metricArgs,
    comparator: r.comparator,
    threshold: r.threshold.toString(),
    consecutiveDays: r.consecutiveDays,
    severity: r.severity,
    delivery: r.delivery,
    isActive: r.isActive,
  };
}

export function alertView(a: Alert) {
  return {
    id: a.id,
    ruleId: a.ruleId,
    envelopeId: a.envelopeId,
    severity: a.severity,
    status: a.status,
    metricValue: a.metricValue.toString(),
    threshold: a.threshold.toString(),
    context: a.context,
    ownerId: a.ownerId,
    openedAt: a.openedAt.toISOString(),
    snoozedUntil: a.snoozedUntil?.toISOString() ?? null,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
  };
}

async function recordRule(tx: Tx, ctx: TenantContext, workspaceId: string, ruleId: string, action: string, before: unknown, after: Record<string, unknown>) {
  await audit(tx, { workspaceId, actorId: ctx.userId, actorType: ctx.actorType, action, entityType: "pacing_rule", entityId: ruleId, before: before ?? null, after, requestId: ctx.requestId });
  await outbox(tx, { workspaceId, topic: "rule.changed", payload: { ruleId, action } });
}

/**
 * A rule's scope is a dimension filter over the workspace, so only a workspace-wide role may write
 * one (the same rule as filter-scoped targets, ADR-009): containment of one filter in another is
 * not decided by the scope model.
 */
function assertWorkspaceWide(auth: AuthContext): void {
  assertInScope(auth, "rule.manage", { dims: {}, ancestors: {} });
}

async function insertRule(tx: Tx, ctx: TenantContext, workspaceId: string, input: CreateRuleInput) {
  const clash = await tx.pacingRule.findFirst({ where: { workspaceId, name: input.name }, select: { id: true } });
  if (clash) throw new DomainError("CONFLICT", "A rule with this name exists", { ruleId: clash.id });
  const row = await tx.pacingRule.create({
    data: {
      id: newId(),
      workspaceId,
      name: input.name,
      scope: json(input.scope ?? {}),
      metric: input.metric,
      metricArgs: json(input.metricArgs),
      comparator: input.comparator,
      threshold: input.threshold,
      consecutiveDays: input.consecutiveDays,
      severity: input.severity,
      delivery: json(input.delivery),
    },
  });
  await recordRule(tx, ctx, workspaceId, row.id, "rule.created", null, ruleView(row));
  return row;
}

/** POST /workspaces/:ws/rules. */
export async function createRule(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateRuleInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  assertWorkspaceWide(auth);
  return withTenant(prisma, auth.ctx, async (tx) => ruleView(await insertRule(tx, auth.ctx, workspaceId, input)));
}

/** PATCH /rules/:id. Rule state and open alerts stay; the next evaluation applies the new rule. */
export async function updateRule(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const id = parseId(rawId);
  const input = parseInput(UpdateRuleInput, raw);
  assertWorkspaceWide(auth);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const current = await tx.pacingRule.findUnique({ where: { id } });
    if (current === null) throw new DomainError("NOT_FOUND", "Rule not found");
    const metric = input.metric ?? current.metric;
    const metricArgs = (input.metricArgs ?? current.metricArgs) as { metricKey?: string };
    if (metric === "kpi_vs_target_pct" && !metricArgs.metricKey) throw new DomainError("VALIDATION", "kpi_vs_target_pct needs metricArgs.metricKey");
    const row = await tx.pacingRule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.scope !== undefined ? { scope: json(input.scope) } : {}),
        ...(input.metric !== undefined ? { metric: input.metric } : {}),
        ...(input.metricArgs !== undefined ? { metricArgs: json(input.metricArgs) } : {}),
        ...(input.comparator !== undefined ? { comparator: input.comparator } : {}),
        ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
        ...(input.consecutiveDays !== undefined ? { consecutiveDays: input.consecutiveDays } : {}),
        ...(input.severity !== undefined ? { severity: input.severity } : {}),
        ...(input.delivery !== undefined ? { delivery: json(input.delivery) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await recordRule(tx, auth.ctx, row.workspaceId, id, "rule.updated", ruleView(current), ruleView(row));
    return ruleView(row);
  });
}

/** GET /workspaces/:ws/rules. */
export function listRules(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => (await tx.pacingRule.findMany({ where: { workspaceId }, orderBy: { name: "asc" } })).map(ruleView));
}

/** Plan §8.4's default rules for a workspace; skips names that exist. */
export async function seedDefaultRules(prisma: PrismaClient, ctx: TenantContext): Promise<number> {
  const workspaceId = requireWorkspace(ctx.workspaceId);
  return withTenant(prisma, ctx, async (tx) => {
    let created = 0;
    for (const r of DEFAULT_RULES) {
      if (await tx.pacingRule.findFirst({ where: { workspaceId, name: r.name }, select: { id: true } })) continue;
      await insertRule(tx, ctx, workspaceId, parseInput(CreateRuleInput, { ...r, delivery: { inApp: true } }));
      created += 1;
    }
    return created;
  });
}

/**
 * PATCH /alerts/:id (spec §11). Acknowledge, snooze (a snoozed alert reopens once snoozedUntil has
 * passed and the rule still breaches) or resolve; reassign the owner. Resolved alerts are final.
 */
export async function updateAlert(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const id = parseId(rawId);
  const input = parseInput(UpdateAlertInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const current = await tx.alert.findUnique({ where: { id } });
    if (current === null) throw new DomainError("NOT_FOUND", "Alert not found");
    assertInScope(auth, "envelope.edit_draft", await envelopeScopeTarget(tx, current.envelopeId));
    if (current.status === "RESOLVED") throw new DomainError("CONFLICT", "Alert is resolved", { status: current.status });
    if (input.snoozedUntil !== undefined && new Date(input.snoozedUntil) <= new Date()) throw new DomainError("VALIDATION", "snoozedUntil must be in the future");
    if (input.ownerId) {
      const user = await tx.user.findUnique({ where: { id: input.ownerId }, select: { orgId: true } });
      if (user === null || user.orgId !== auth.user.orgId) throw new DomainError("VALIDATION", "Owner is not a user of this organization");
    }
    const row = await tx.alert.update({
      where: { id },
      data: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.status === "SNOOZED" ? { snoozedUntil: new Date(input.snoozedUntil as string) } : input.status !== undefined ? { snoozedUntil: null } : {}),
        ...(input.status === "RESOLVED" ? { resolvedAt: new Date() } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      },
    });
    const action = input.status ? `alert.${input.status.toLowerCase()}` : "alert.reassigned";
    await audit(tx, { workspaceId: row.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "alert", entityId: id, before: alertView(current), after: { status: row.status, snoozedUntil: row.snoozedUntil?.toISOString() ?? null, ownerId: row.ownerId }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId: row.workspaceId, topic: "alert.changed", payload: { alertId: id, status: row.status, ownerId: row.ownerId } });
    return alertView(row);
  });
}
