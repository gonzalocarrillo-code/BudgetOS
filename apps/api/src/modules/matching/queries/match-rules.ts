import { CAMPAIGN_DIMENSION, MatchCoverageQuery, MatchRulePredicate, type MatchCoverageResponse, type MatchRuleView, type MatchRulesResponse } from "@budget/domain";
import { matchCoverage, withTenant } from "@budget/db";
import type { MatchRule, PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function ruleView(r: MatchRule, envelopeName: string): MatchRuleView {
  return {
    id: r.id,
    envelopeId: r.envelopeId,
    envelopeName,
    predicate: MatchRulePredicate.parse(r.predicate),
    startDate: day(r.startDate),
    endDate: day(r.endDate),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

/** GET /workspaces/:ws/match-rules: live rules, newest first. */
export async function listMatchRules(prisma: PrismaClient, auth: AuthContext): Promise<MatchRulesResponse> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const rows = await tx.matchRule.findMany({ where: { workspaceId, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { envelope: { select: { name: true, displayName: true } } } });
    return { rules: rows.map((r) => ruleView(r, r.envelope.displayName ?? r.envelope.name)) };
  });
}

/** GET /workspaces/:ws/match-coverage?from&to&limit. */
export async function getMatchCoverage(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<MatchCoverageResponse> {
  const q = parseInput(MatchCoverageQuery, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, (tx) => matchCoverage(tx, workspaceId, { from: q.from, to: q.to, limit: q.limit ?? 100, campaignKey: CAMPAIGN_DIMENSION }));
}
