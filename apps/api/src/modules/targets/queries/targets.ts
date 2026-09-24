import { DomainError, ListTargetsQuery, canInScope, matchesScope } from "@budget/domain";
import { effectiveTargets, withTenant } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget, envelopeScopeTargets } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { targetView } from "../commands/create-target.js";
import { versionView } from "../commands/target-writer.js";
import { currentFilterTargets } from "./planner-options.js";

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** GET /workspaces/:ws/targets?metric&envelopeId&scopeType. Envelope targets outside the caller's scope are left out. */
export async function listTargets(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const q = parseInput(ListTargetsQuery, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const rows = await tx.target.findMany({
      where: {
        workspaceId,
        status: "active",
        ...(q.metric ? { metricKey: q.metric } : {}),
        ...(q.envelopeId ? { envelopeId: q.envelopeId } : {}),
        ...(q.scopeType ? { scopeType: q.scopeType } : {}),
      },
      orderBy: { id: "asc" },
      take: 1000,
    });
    const scopes = await envelopeScopeTargets(tx, [...new Set(rows.map((r) => r.envelopeId).filter((x): x is string => x !== null))]);
    const visible = rows.filter((r) => auth.isOrgAdmin || r.envelopeId === null || canInScope(auth.assignments, "target.read", scopes.get(r.envelopeId) ?? { dims: {} }));
    const versionIds = visible.flatMap((r) => [r.currentVersionId, r.draftVersionId]).filter((x): x is string => x !== null);
    const versions = new Map((await tx.targetVersion.findMany({ where: { id: { in: versionIds } } })).map((v) => [v.id, versionView(v)]));
    return visible.map((r) => ({
      ...targetView(r),
      current: r.currentVersionId ? (versions.get(r.currentVersionId) ?? null) : null,
      draft: r.draftVersionId ? (versions.get(r.draftVersionId) ?? null) : null,
    }));
  });
}

/** GET /targets/:id/versions: every version, newest first (none is ever deleted). */
export async function targetVersions(prisma: PrismaClient, auth: AuthContext, rawId: string) {
  const id = parseId(rawId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const t = await tx.target.findUnique({ where: { id }, include: { versions: { orderBy: { versionNo: "desc" } } } });
    if (t === null) throw new DomainError("NOT_FOUND", "Target not found");
    if (t.envelopeId) assertInScope(auth, "target.read", await envelopeScopeTarget(tx, t.envelopeId));
    return { ...targetView(t), versions: t.versions.map(versionView) };
  });
}

/**
 * GET /envelopes/:id/targets: the target that applies to the envelope for each metric (spec §10) —
 * its own, else the nearest ancestor's (`inheritedFrom`), else the most specific matching filter
 * target — plus the implied volume for cost-per metrics: budget / target (plan §4.8), never stored.
 */
export async function envelopeTargets(prisma: PrismaClient, auth: AuthContext, rawEnvelopeId: string) {
  const envelopeId = parseId(rawEnvelopeId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const env = await tx.envelope.findUnique({ where: { id: envelopeId } });
    if (env === null) throw new DomainError("NOT_FOUND", "Envelope not found");
    const scope = await envelopeScopeTarget(tx, envelopeId);
    assertInScope(auth, "target.read", scope);
    const metrics = await tx.metricDefinition.findMany({ where: { orgId: auth.user.orgId, isActive: true }, orderBy: { key: "asc" } });
    const keys = metrics.map((m) => m.key);
    const own = new Map((await effectiveTargets(tx, envelopeId, keys)).map((r) => [r.metricKey, r]));
    const filters = await currentFilterTargets(tx, env.workspaceId, keys, { start: isoDate(env.startDate), end: isoDate(env.endDate) });
    const budgetRow = env.currentVersionId ? await tx.envelopeVersion.findUnique({ where: { id: env.currentVersionId }, select: { amountReporting: true } }) : null;
    const budget = budgetRow ? new Decimal(budgetRow.amountReporting.toString()) : null;

    const out = [];
    for (const m of metrics) {
      const e = own.get(m.key);
      const f = e ? undefined : filters.find((t) => t.metricKey === m.key && matchesScope(t.scope, scope));
      if (e === undefined && f === undefined) continue;
      const value = new Decimal(e?.value ?? f?.value ?? "0");
      const costPer = m.numerator === "spend" && m.denominator?.startsWith("kpi:") === true;
      const implied = costPer && budget !== null && !value.isZero() ? budget.mul(m.multiplier.toString()).div(value).toDecimalPlaces(2).toFixed(2) : null;
      out.push({
        metricKey: m.key,
        targetId: e?.targetId ?? f?.targetId ?? null,
        value: value.toString(),
        comparator: e?.comparator ?? f?.comparator ?? null,
        source: e ? (e.inheritedFrom ? "inherited" : "own") : "filter",
        inheritedFrom: e?.inheritedFrom ?? null,
        impliedVolume: implied === null ? null : { metric: m.denominator?.slice(4) ?? null, value: implied },
      });
    }
    return { envelopeId, budget: budget?.toFixed(2) ?? null, targets: out };
  });
}
