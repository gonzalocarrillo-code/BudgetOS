import { DomainError } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { closureView } from "../commands/close-period.js";

/** GET /workspaces/:ws/closures: newest first, restated ones included (they are history). */
export async function listClosures(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const closures = await tx.periodClosure.findMany({ where: { workspaceId }, orderBy: [{ closedAt: "desc" }, { id: "desc" }] });
    const periods = new Map((await tx.fiscalPeriod.findMany({ where: { id: { in: closures.map((c) => c.periodId) } } })).map((p) => [p.id, p]));
    const counts = new Map((await tx.closureEnvelope.groupBy({ by: ["closureId"], where: { closureId: { in: closures.map((c) => c.id) } }, _count: { _all: true } })).map((g) => [g.closureId, g._count._all]));
    return closures.flatMap((c) => {
      const p = periods.get(c.periodId);
      return p ? [closureView(c, p, counts.get(c.id) ?? 0)] : [];
    });
  });
}

/** GET /closures/:id/report: the frozen report, as stored at close (variance summary + registry snapshot). */
export async function closureReport(prisma: PrismaClient, auth: AuthContext, rawId: string) {
  const id = parseId(rawId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const c = await tx.periodClosure.findUnique({ where: { id } });
    if (c === null) throw new DomainError("NOT_FOUND", "Closure not found");
    const p = await tx.fiscalPeriod.findUniqueOrThrow({ where: { id: c.periodId } });
    const locked = await tx.closureEnvelope.count({ where: { closureId: id } });
    return { closure: closureView(c, p, locked), summary: c.varianceSummary, registryVersion: c.registryVersion };
  });
}
