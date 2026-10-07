import { MAX_AI_NAMES, SuggestNamingInput, dictionaryKindFor, newId, proposalFromSuggestion, type SuggestNamingResponse } from "@budget/domain";
import { openAiClient, suggestNamingConvention } from "@budget/ai";
import { audit, namingResolver, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { namingDimensions, workspaceCampaignNames } from "../queries/naming.js";

/**
 * EX-6 (ADR-0092): POST /workspaces/:ws/naming-conventions/suggest — "Suggest with AI", support
 * only. 503 before anything is read when OpenAI is not configured. Only distinct campaign names
 * (the pasted ones, or the workspace's largest MAX_AI_NAMES) and dimension keys go to @budget/ai;
 * the validated answer comes back as a proposal the user reviews. Nothing is applied. The request
 * is audited (who, how many names, which model) without the names or the prompt: one audit_event
 * + one `source.changed` outbox row.
 */
export async function suggestNaming(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<SuggestNamingResponse> {
  const input = parseInput(SuggestNamingInput, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const client = openAiClient(); // 503 before any name is read
  const { names, dims } = await withTenant(prisma, auth.ctx, async (tx) => ({
    names: input.names ?? (await workspaceCampaignNames(tx, workspaceId, MAX_AI_NAMES)),
    dims: (await namingDimensions(tx, auth.user.orgId, workspaceId)).map((d) => ({ ...d, dictionary: dictionaryKindFor(d.key) })),
  }));
  // No transaction is held over the network call.
  const res = await suggestNamingConvention(names, dims, client);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const resolve = await namingResolver(tx, workspaceId, dims.map((d) => d.key));
    const proposal = proposalFromSuggestion(res.suggestion, resolve);
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "naming_convention.ai_suggested", entityType: "naming_convention", entityId: newId(), after: { names: res.names, model: res.model, positions: res.suggestion.positions.length, mappings: res.suggestion.mappings.length, applied: false }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "source.changed", payload: { action: "naming_convention.ai_suggested", names: res.names } });
    return { suggestion: res.suggestion, proposal, model: res.model, names: res.names, applied: false as const };
  });
}
