import {
  CAMPAIGN_DIMENSION,
  MatchCoverageQuery,
  MatchRulePredicate,
  NamingConventionPreviewInput,
  NamingConventionToken,
  SourceMapping,
  explainCampaignName,
  normalizeToken,
  type BudgetReferenceView,
  type MatchCoverageResponse,
  type MatchRuleView,
  type MatchRulesResponse,
  type NamingConventionPreviewResponse,
  type NamingConventionView,
} from "@budget/domain";
import { campaignNames, campaignSpend, matchCoverage, namingResolver, withTenant } from "@budget/db";
import { Decimal } from "decimal.js";
import type { MatchRule, NamingConvention, PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/** EX-6: every live campaign is read for the unresolved tokens; the list shows the largest ones. */
const MAX_CAMPAIGNS = 5000;
const MAX_UNRESOLVED = 100;

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
 * with exactly the reading matching uses. EX-6 (ADR-0091): every part says where its value came
 * from (alias, registry, dictionary), and `unresolved` lists the tokens nothing reads, per
 * position, over every live campaign (priced by their spend) or over the given names.
 */
export async function previewNamingConvention(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<NamingConventionPreviewResponse> {
  const input = parseInput(NamingConventionPreviewInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const keys = [...new Set(input.convention.tokens.flatMap((t) => (t.dimension === null ? [] : [t.dimension])))];
    const resolve = await namingResolver(tx, workspaceId, keys);
    let named: Array<{ name: string; campaign: string | null; amount: string | null }>;
    let sampled: typeof named;
    if (input.names) sampled = named = input.names.map((name) => ({ name, campaign: null, amount: null }));
    else {
      const spend = await campaignSpend(tx, workspaceId, MAX_CAMPAIGNS);
      const names = await campaignNames(tx, workspaceId, spend.map((c) => c.campaign), CAMPAIGN_DIMENSION);
      named = spend.map((c) => ({ name: names.get(c.campaign) ?? c.campaign, campaign: c.campaign, amount: c.amount }));
      sampled = named.slice(0, 8);
    }
    const explained = new Map(named.map((n) => [n, explainCampaignName(input.convention, n.name, resolve)]));
    const open = new Map<string, { position: number; dimension: string; token: string; campaigns: number; amount: Decimal | null }>();
    for (const [n, e] of explained) {
      for (const p of e.parts) {
        if (p.dimension === null || p.code !== null) continue;
        const k = `${p.position}\u0000${normalizeToken(p.raw)}`;
        const row = open.get(k) ?? { position: p.position, dimension: p.dimension, token: p.raw, campaigns: 0, amount: n.amount === null ? null : new Decimal(0) };
        row.campaigns++;
        if (row.amount !== null && n.amount !== null) row.amount = row.amount.plus(n.amount);
        open.set(k, row);
      }
    }
    const unresolved = [...open.values()]
      .sort((a, b) => (b.amount ?? new Decimal(0)).comparedTo(a.amount ?? new Decimal(0)) || b.campaigns - a.campaigns || a.position - b.position || a.token.localeCompare(b.token))
      .slice(0, MAX_UNRESOLVED)
      .map((u) => ({ ...u, amount: u.amount === null ? null : u.amount.toFixed(2) }));
    return {
      samples: sampled.map((n) => {
        const e = explained.get(n) ?? explainCampaignName(input.convention, n.name, resolve);
        return { name: n.name, campaign: n.campaign, dimensionValues: e.dimensionValues, problem: e.problem, parts: e.parts };
      }),
      unresolved,
      currency: (await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { reportingCurrency: true } })).reportingCurrency,
    };
  });
}

/** GET /workspaces/:ws/match-coverage?from&to&limit. */
export async function getMatchCoverage(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<MatchCoverageResponse> {
  const q = parseInput(MatchCoverageQuery, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, (tx) => matchCoverage(tx, workspaceId, { from: q.from, to: q.to, limit: q.limit ?? 100, campaignKey: CAMPAIGN_DIMENSION }));
}
