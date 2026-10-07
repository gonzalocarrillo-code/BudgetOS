import {
  CAMPAIGN_DIMENSION,
  MatchCoverageQuery,
  MatchRulePredicate,
  NamingConventionPreviewInput,
  NamingConventionToken,
  SourceMapping,
  parseCampaignName,
  type BudgetReferenceView,
  type MatchCoverageResponse,
  type MatchRuleView,
  type MatchRulesResponse,
  type NamingConventionPreviewResponse,
  type NamingConventionView,
} from "@budget/domain";
import { campaignNames, conventionResolver, matchCoverage, topCampaigns, withTenant } from "@budget/db";
import type { MatchRule, NamingConvention, PrismaClient } from "@prisma/client";
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

export function conventionView(r: NamingConvention): NamingConventionView {
  return {
    id: r.id,
    delimiter: r.delimiter as NamingConventionView["delimiter"],
    tokens: NamingConventionToken.array().parse(r.tokens),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * GET /workspaces/:ws/match-rules: the three kinds of mapping rule (ADR-0090) — campaign → budget
 * rules (newest first), naming conventions (in the order they apply: oldest first), and the
 * database references: every source whose mapping has a `budget_ref` column.
 */
export async function listMatchRules(prisma: PrismaClient, auth: AuthContext): Promise<MatchRulesResponse> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const rows = await tx.matchRule.findMany({ where: { workspaceId, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { envelope: { select: { name: true, displayName: true } } } });
    const conventions = await tx.namingConvention.findMany({ where: { workspaceId, deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const sources = await tx.dataSource.findMany({ where: { workspaceId }, select: { id: true, name: true, mapping: true }, orderBy: { name: "asc" } });
    const references: BudgetReferenceView[] = sources.flatMap((s) => {
      const m = SourceMapping.safeParse(s.mapping);
      if (!m.success) return [];
      return Object.entries(m.data.columns).flatMap(([column, c]) => ("role" in c && c.role === "budget_ref" ? [{ sourceId: s.id, sourceName: s.name, column }] : []));
    });
    return { rules: rows.map((r) => ruleView(r, r.envelope.displayName ?? r.envelope.name)), conventions: conventions.map(conventionView), references };
  });
}

/**
 * POST /workspaces/:ws/naming-conventions/preview: a convention (saved or not) read over campaign
 * names — the given ones, or the eight campaigns with the most live spend (their registry labels) —
 * with exactly the parser and registry lookup matching uses.
 */
export async function previewNamingConvention(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<NamingConventionPreviewResponse> {
  const input = parseInput(NamingConventionPreviewInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const keys = [...new Set(input.convention.tokens.flatMap((t) => (t.dimension === null ? [] : [t.dimension])))];
    const resolve = await conventionResolver(tx, workspaceId, keys);
    let named: Array<{ name: string; campaign: string | null }>;
    if (input.names) named = input.names.map((name) => ({ name, campaign: null }));
    else {
      const codes = await topCampaigns(tx, workspaceId, 8);
      const names = await campaignNames(tx, workspaceId, codes, CAMPAIGN_DIMENSION);
      named = codes.map((c) => ({ name: names.get(c) ?? c, campaign: c }));
    }
    return {
      samples: named.map(({ name, campaign }) => {
        const p = parseCampaignName(input.convention, name, resolve);
        return { name, campaign, dimensionValues: p.ok ? p.dimensionValues : null, problem: p.ok ? null : p.problem };
      }),
    };
  });
}

/** GET /workspaces/:ws/match-coverage?from&to&limit. */
export async function getMatchCoverage(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<MatchCoverageResponse> {
  const q = parseInput(MatchCoverageQuery, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, (tx) => matchCoverage(tx, workspaceId, { from: q.from, to: q.to, limit: q.limit ?? 100, campaignKey: CAMPAIGN_DIMENSION }));
}
