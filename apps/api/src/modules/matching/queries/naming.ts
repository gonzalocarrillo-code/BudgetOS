import { AnalyzeNamesInput, CAMPAIGN_DIMENSION, analyzeCampaignNames, type AnalyzeNamesResponse, type NamingConventionState } from "@budget/domain";
import { campaignNames, campaignSpend, namingResolver, withTenant, type Tx } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { conventionView } from "./match-rules.js";

/** EX-6 (ADR-0091): reads behind the workspace's naming convention (Registry) and "Analyze names". */

/** The names analysis reads from facts at most (largest spend first). */
export const MAX_ANALYZED = 1000;

/** Whether "Suggest with AI" can run: OpenAI is configured for the deployment (OPENAI_API_KEY, Secret Manager). */
export const aiAvailable = (env: NodeJS.ProcessEnv = process.env): boolean => (env["OPENAI_API_KEY"] ?? "") !== "";

/** The workspace's live dimensions (org-wide and its own), except the campaign itself. */
export async function namingDimensions(tx: Tx, orgId: string, workspaceId: string): Promise<Array<{ key: string; label: string }>> {
  const dims = await tx.dimension.findMany({ where: { orgId, isActive: true, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true, label: true }, orderBy: [{ sortOrder: "asc" }, { key: "asc" }] });
  const seen = new Set<string>();
  return dims.filter((d) => d.key !== CAMPAIGN_DIMENSION && !seen.has(d.key) && (seen.add(d.key), true));
}

/** The workspace's campaign names (registry labels), largest live spend first. */
export async function workspaceCampaignNames(tx: Tx, workspaceId: string, limit: number): Promise<string[]> {
  const codes = (await campaignSpend(tx, workspaceId, limit)).map((c) => c.campaign);
  const names = await campaignNames(tx, workspaceId, codes, CAMPAIGN_DIMENSION);
  return codes.map((c) => names.get(c) ?? c);
}

/** GET /workspaces/:ws/naming-convention. */
export async function getNamingConvention(prisma: PrismaClient, auth: AuthContext): Promise<NamingConventionState> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const live = await tx.namingConvention.findMany({ where: { workspaceId, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const [current] = live;
    return { convention: current ? conventionView(current) : null, others: Math.max(0, live.length - 1), aiAvailable: aiAvailable() };
  });
}

/**
 * POST /workspaces/:ws/naming-conventions/analyze: deterministic, no AI. The pasted names, or the
 * workspace's campaign names; the delimiter, each position's cardinality, examples and best
 * dictionary (through the workspace's dimensions), and a proposed convention. Nothing is saved.
 */
export async function analyzeNames(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<AnalyzeNamesResponse> {
  const input = parseInput(AnalyzeNamesInput, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const names = input.names ?? (await workspaceCampaignNames(tx, workspaceId, MAX_ANALYZED));
    const dims = await namingDimensions(tx, auth.user.orgId, workspaceId);
    const resolve = await namingResolver(
      tx,
      workspaceId,
      dims.map((d) => d.key),
    );
    const analysis = analyzeCampaignNames(names, dims, (d, tk) => resolve(d, tk)?.source === "registry", input.delimiter);
    return { ...analysis, source: input.names ? "pasted" : "facts" };
  });
}
