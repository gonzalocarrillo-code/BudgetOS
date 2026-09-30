import { DomainError, FamilyInput, newId, type FamilyPlan } from "@budget/domain";
import { audit, outbox, withTenant, type Tx } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { buildPreview } from "../bulk/preview.js";
import type { PreviewStore } from "../bulk/preview-store.js";
import { planFamily, type Node } from "./plan.js";

/**
 * Family editing (product feedback 5, ADR-039). GET /envelopes/:id/family: the parent, its
 * children and how each follows it; POST …/family/preview: what a change does, down the tree;
 * POST …/family: saves how the children follow (rules, audited) and opens the amounts as a bulk
 * preview. Amounts are never written here: the bulk commit makes the drafts and one approval.
 */

/** The parent and its live descendants, each with its current amount (open draft, else approved), its approved amount and rule. */
async function loadFamily(tx: Tx, rootId: string): Promise<Map<string, Node>> {
  const root = await tx.envelope.findUnique({ where: { id: rootId } });
  if (root === null) throw new DomainError("NOT_FOUND", "Envelope not found", { id: rootId });
  const envs = [root];
  for (let level = [root.id]; level.length; ) {
    const kids = await tx.envelope.findMany({ where: { parentId: { in: level }, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" } });
    envs.push(...kids);
    level = kids.map((k) => k.id);
  }
  const versionIds = envs.flatMap((e) => [e.draftVersionId, e.currentVersionId]).filter((v): v is string => v !== null);
  const amounts = new Map((await tx.envelopeVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, amount: true } })).map((v) => [v.id, v.amount.toFixed(2)]));
  const rules = new Map(
    (await tx.envelopeAllocation.findMany({ where: { childEnvelopeId: { in: envs.map((e) => e.id) }, supersededAt: null }, select: { childEnvelopeId: true, mode: true, pct: true } })).map((r) => [
      r.childEnvelopeId,
      { mode: r.mode as "percent" | "manual", pct: r.pct === null ? null : r.pct.toFixed(6).replace(/\.?0+$/, "") },
    ]),
  );
  const nodes = new Map<string, Node>();
  for (const e of envs) {
    const head = e.draftVersionId ?? e.currentVersionId;
    nodes.set(e.id, { id: e.id, name: e.displayName ?? e.name, parentId: e.id === root.id ? null : e.parentId, currency: e.currency, status: e.status, amount: head ? (amounts.get(head) ?? null) : null, approved: e.currentVersionId ? (amounts.get(e.currentVersionId) ?? null) : null, proposed: e.draftVersionId !== null, rule: rules.get(e.id) ?? null, children: [] });
  }
  for (const n of nodes.values()) if (n.parentId) nodes.get(n.parentId)?.children.push(n.id);
  return nodes;
}

export async function getFamily(prisma: PrismaClient, auth: AuthContext, rawId: string): Promise<FamilyPlan> {
  const id = parseId(rawId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    assertInScope(auth, "envelope.read", await envelopeScopeTarget(tx, id));
    return planFamily(await loadFamily(tx, id), id, null);
  });
}

export async function previewFamily(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown): Promise<FamilyPlan> {
  const id = parseId(rawId);
  const input = parseInput(FamilyInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    assertInScope(auth, "envelope.read", await envelopeScopeTarget(tx, id));
    return planFamily(await loadFamily(tx, id), id, input);
  });
}

/**
 * Saves the rules of the parent's direct children that changed (one audit event and one outbox row
 * for the family), then builds the bulk preview of every amount the plan changes. The caller
 * reviews it and commits: drafts plus one approval request, parents approved first (ADR-039).
 */
export async function saveFamily(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown, store: PreviewStore) {
  const id = parseId(rawId);
  const input = parseInput(FamilyInput, raw);
  const plan = await withTenant(prisma, auth.ctx, async (tx) => {
    assertInScope(auth, "envelope.edit_draft", await envelopeScopeTarget(tx, id));
    const nodes = await loadFamily(tx, id);
    const plan = planFamily(nodes, id, input);
    const root = await tx.envelope.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    const changes = input.children.flatMap((c) => {
      const before = nodes.get(c.envelopeId)?.rule ?? null;
      const after = plan.members.find((m) => m.envelopeId === c.envelopeId);
      const next = { mode: c.mode, pct: after?.pct ?? null };
      return before?.mode === next.mode && before.pct === next.pct ? [] : [{ childId: c.envelopeId, before, after: next }];
    });
    if (changes.length) {
      for (const ch of changes) assertInScope(auth, "envelope.edit_draft", await envelopeScopeTarget(tx, ch.childId));
      const now = new Date();
      await tx.envelopeAllocation.updateMany({ where: { childEnvelopeId: { in: changes.map((c) => c.childId) }, supersededAt: null }, data: { supersededAt: now } });
      await tx.envelopeAllocation.createMany({
        data: changes.map((c) => ({ id: newId(), workspaceId: root.workspaceId, parentEnvelopeId: id, childEnvelopeId: c.childId, mode: c.after.mode, pct: c.after.pct, createdBy: auth.user.id })),
      });
      await audit(tx, { workspaceId: root.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "allocation.changed", entityType: "envelope", entityId: id, before: { rules: changes.map((c) => ({ envelopeId: c.childId, ...c.before })) }, after: { rules: changes.map((c) => ({ envelopeId: c.childId, ...c.after })) }, reason: input.rationale, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId: root.workspaceId, topic: "allocation.changed", payload: { envelopeId: id, children: changes.map((c) => c.childId) } });
    }
    return { plan, workspaceId: root.workspaceId };
  });
  const rows = [plan.plan.parent, ...plan.plan.members].filter((m) => m.changed && m.after !== null).map((m) => ({ envelopeId: m.envelopeId, amount: m.after as string }));
  const preview = rows.length ? await buildPreview(prisma, auth, { workspaceId: plan.workspaceId, selection: { envelopeIds: rows.map((r) => r.envelopeId) }, operation: { op: "paste", rows }, rationale: input.rationale }, store) : null;
  return { plan: plan.plan, preview };
}
