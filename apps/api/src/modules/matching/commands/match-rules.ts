import { CreateMatchRuleInput, DomainError, newId, type MatchRuleCondition, type MatchRuleGroupT, type MatchRuleWriteResponse, type RematchResult } from "@budget/domain";
import { audit, closedPeriods, matchFacts, outbox, withTenant, type MatchPass, type Tx } from "@budget/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { ruleView } from "../queries/match-rules.js";

/**
 * EX-1 (ADR-0085): match rules (registry rows, never columns) and re-matching. A rule write
 * re-matches the facts its predicate covers in the same transaction, so "Assign to budget" lands
 * at once; closed periods are left alone (their actuals are frozen). One audit_event and one
 * `facts.loaded` outbox row (the roll-up worker refreshes the envelopes that gained or lost facts).
 */

const REMATCH_TIMEOUT_MS = 120_000;

function dimensionKeys(g: MatchRuleGroupT): string[] {
  return g.children.flatMap((c) => ("field" in c ? [(c as MatchRuleCondition).field.key] : dimensionKeys(c as MatchRuleGroupT)));
}

const result = (p: MatchPass): RematchResult => ({ spend: p.spend, kpi: p.kpi, projection: p.projection, envelopeIds: p.envelopeIds });

async function keepRanges(tx: Tx, workspaceId: string) {
  return (await closedPeriods(tx, workspaceId)).map((c) => ({ start: c.start, end: c.end }));
}

/** Only someone who may edit the budget's draft (in scope) points facts at it. */
async function loadTargetEnvelope(tx: Tx, auth: AuthContext, workspaceId: string, envelopeId: string) {
  const env = await tx.envelope.findUnique({ where: { id: envelopeId }, select: { id: true, workspaceId: true, status: true, name: true, displayName: true } });
  if (env === null || env.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Envelope not found");
  assertInScope(auth, "envelope.edit_draft", await envelopeScopeTarget(tx, env.id));
  return env;
}

/** POST /workspaces/:ws/match-rules. */
export async function createMatchRule(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<MatchRuleWriteResponse> {
  const input = parseInput(CreateMatchRuleInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const env = await loadTargetEnvelope(tx, auth, workspaceId, input.envelopeId);
      if (env.status === "ARCHIVED") throw new DomainError("CONFLICT", "Envelope is archived");
      const keys = [...new Set(dimensionKeys(input.predicate))];
      const found = await tx.dimension.findMany({ where: { orgId: auth.user.orgId, isActive: true, key: { in: keys }, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true } });
      const missing = keys.filter((k) => !found.some((d) => d.key === k));
      if (missing.length) throw new DomainError("VALIDATION", "The rule names dimensions the registry does not have", { missing });
      const predicate = input.predicate as unknown as Prisma.InputJsonValue;
      const same = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM match_rule WHERE workspace_id = ${workspaceId}::uuid AND envelope_id = ${env.id}::uuid AND deleted_at IS NULL
          AND predicate = ${JSON.stringify(input.predicate)}::jsonb
          AND start_date IS NOT DISTINCT FROM ${input.startDate ?? null}::date AND end_date IS NOT DISTINCT FROM ${input.endDate ?? null}::date`;
      if (same[0]) throw new DomainError("CONFLICT", "This rule already exists", { ruleId: same[0].id });
      const row = await tx.matchRule.create({
        data: {
          id: newId(),
          workspaceId,
          envelopeId: env.id,
          predicate,
          startDate: input.startDate ? new Date(`${input.startDate}T00:00:00Z`) : null,
          endDate: input.endDate ? new Date(`${input.endDate}T00:00:00Z`) : null,
          createdBy: auth.user.id,
        },
      });
      const pass = await matchFacts(tx, workspaceId, { predicate: input.predicate, keep: await keepRanges(tx, workspaceId) });
      const view = ruleView(row, env.displayName ?? env.name);
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "match_rule.created", entityType: "match_rule", entityId: row.id, after: { ...view, rematch: result(pass) }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { envelopeIds: pass.envelopeIds, matchRuleId: row.id, action: "match_rule.created" } });
      return { rule: view, rematch: result(pass) };
    },
    { timeoutMs: REMATCH_TIMEOUT_MS },
  );
}

/** DELETE /match-rules/:id: soft delete, then the facts it covered are matched again without it. */
export async function deleteMatchRule(prisma: PrismaClient, auth: AuthContext, rawId: string): Promise<MatchRuleWriteResponse> {
  const id = parseId(rawId);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const current = await tx.matchRule.findUnique({ where: { id } });
      if (current === null || current.workspaceId !== workspaceId || current.deletedAt !== null) throw new DomainError("NOT_FOUND", "Match rule not found");
      const env = await loadTargetEnvelope(tx, auth, workspaceId, current.envelopeId);
      const row = await tx.matchRule.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: auth.user.id } });
      const pass = await matchFacts(tx, workspaceId, { predicate: current.predicate, keep: await keepRanges(tx, workspaceId) });
      const view = ruleView(row, env.displayName ?? env.name);
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "match_rule.deleted", entityType: "match_rule", entityId: id, before: ruleView(current, env.displayName ?? env.name), after: { deletedAt: row.deletedAt?.toISOString() ?? null, rematch: result(pass) }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { envelopeIds: pass.envelopeIds, matchRuleId: id, action: "match_rule.deleted" } });
      return { rule: view, rematch: result(pass) };
    },
    { timeoutMs: REMATCH_TIMEOUT_MS },
  );
}

/** POST /workspaces/:ws/match-rules/rematch: every live, unpinned fact outside closed periods is matched again. */
export async function rematchWorkspace(prisma: PrismaClient, auth: AuthContext): Promise<RematchResult> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const pass = await matchFacts(tx, workspaceId, { keep: await keepRanges(tx, workspaceId) });
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "facts.rematched", entityType: "workspace", entityId: workspaceId, after: result(pass), requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { envelopeIds: pass.envelopeIds, action: "facts.rematched" } });
      return result(pass);
    },
    { timeoutMs: REMATCH_TIMEOUT_MS },
  );
}
