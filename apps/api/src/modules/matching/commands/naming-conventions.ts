import { CAMPAIGN_DIMENSION, CreateNamingConventionInput, DomainError, newId, type NamingConventionWriteResponse, type RematchResult } from "@budget/domain";
import { audit, closedPeriods, matchFacts, outbox, withTenant, type MatchPass, type Tx } from "@budget/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { conventionView } from "../queries/match-rules.js";

/**
 * EX-5 (ADR-0090): naming conventions — how campaign names are built — are registry rows a data
 * admin writes (source.manage, like the unmatched queue: they decide where spend lands for every
 * budget, not one). A write re-matches, in the same transaction, every live unpinned fact that has
 * a campaign (closed periods are left alone). One audit_event and one `facts.loaded` outbox row.
 */

const REMATCH_TIMEOUT_MS = 120_000;
/** The facts a convention can change: those with a campaign. */
const HAS_CAMPAIGN = { logic: "and", children: [{ field: { kind: "dimension", key: CAMPAIGN_DIMENSION }, op: "not_empty" }] };

const result = (p: MatchPass): RematchResult => ({ spend: p.spend, kpi: p.kpi, projection: p.projection, envelopeIds: p.envelopeIds });

async function rematchCampaigns(tx: Tx, workspaceId: string): Promise<MatchPass> {
  const keep = (await closedPeriods(tx, workspaceId)).map((c) => ({ start: c.start, end: c.end }));
  return matchFacts(tx, workspaceId, { predicate: HAS_CAMPAIGN, keep });
}

/** POST /workspaces/:ws/naming-conventions. */
export async function createNamingConvention(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<NamingConventionWriteResponse> {
  const input = parseInput(CreateNamingConventionInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const keys = [...new Set(input.tokens.flatMap((t) => (t.dimension === null ? [] : [t.dimension])))];
      const found = await tx.dimension.findMany({ where: { orgId: auth.user.orgId, isActive: true, key: { in: keys }, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true } });
      const missing = keys.filter((k) => !found.some((d) => d.key === k));
      if (missing.length) throw new DomainError("VALIDATION", "The convention names dimensions the registry does not have", { missing });
      const tokens = input.tokens as unknown as Prisma.InputJsonValue;
      const same = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM naming_convention WHERE workspace_id = ${workspaceId}::uuid AND deleted_at IS NULL AND delimiter = ${input.delimiter} AND tokens = ${JSON.stringify(input.tokens)}::jsonb`;
      if (same[0]) throw new DomainError("CONFLICT", "This naming convention already exists", { namingConventionId: same[0].id });
      const row = await tx.namingConvention.create({ data: { id: newId(), workspaceId, delimiter: input.delimiter, tokens, createdBy: auth.user.id } });
      const pass = await rematchCampaigns(tx, workspaceId);
      const view = conventionView(row);
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "naming_convention.created", entityType: "naming_convention", entityId: row.id, after: { ...view, rematch: result(pass) }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { envelopeIds: pass.envelopeIds, namingConventionId: row.id, action: "naming_convention.created" } });
      return { convention: view, rematch: result(pass) };
    },
    { timeoutMs: REMATCH_TIMEOUT_MS },
  );
}

/** DELETE /naming-conventions/:id: soft delete, then the campaign facts are matched again without it. */
export async function deleteNamingConvention(prisma: PrismaClient, auth: AuthContext, rawId: string): Promise<NamingConventionWriteResponse> {
  const id = parseId(rawId);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const current = await tx.namingConvention.findUnique({ where: { id } });
      if (current === null || current.workspaceId !== workspaceId || current.deletedAt !== null) throw new DomainError("NOT_FOUND", "Naming convention not found");
      const row = await tx.namingConvention.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: auth.user.id } });
      const pass = await rematchCampaigns(tx, workspaceId);
      const view = conventionView(row);
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "naming_convention.deleted", entityType: "naming_convention", entityId: id, before: conventionView(current), after: { deletedAt: row.deletedAt?.toISOString() ?? null, rematch: result(pass) }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { envelopeIds: pass.envelopeIds, namingConventionId: id, action: "naming_convention.deleted" } });
      return { convention: view, rematch: result(pass) };
    },
    { timeoutMs: REMATCH_TIMEOUT_MS },
  );
}
