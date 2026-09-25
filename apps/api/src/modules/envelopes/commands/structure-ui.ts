import { AddChildInput, DomainError, StructurePreviewInput } from "@budget/domain";
import { withTenant, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { createEnvelopeIn } from "./create-envelope.js";
import { mergeIn, moveIn, splitIn } from "./structure.js";
import { submitVersionIn } from "./submit-version.js";
import { resolveFx } from "./version-writer.js";

/**
 * Envelope structure from the UI (T-031b, plan 0.6 §9.3): add a child in one action, and a preview
 * for add-child, move, split and merge that runs the real command and rolls it back.
 */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** The add-child body, inside a caller's transaction: create under the parent, then submit its draft. */
export async function addChildIn(tx: Tx, auth: AuthContext, workspaceId: string, parentId: string, input: AddChildInput) {
  const parent = await tx.envelope.findUnique({ where: { id: parentId } });
  if (parent === null || parent.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Parent envelope not found");
  if (parent.status === "LOCKED") throw new DomainError("LOCKED", "The parent's period is closed");
  if (parent.status === "ARCHIVED") throw new DomainError("CONFLICT", "The parent is archived");
  const child = await createEnvelopeIn(tx, auth, workspaceId, {
    name: input.name,
    parentId,
    dimensionValues: { ...(parent.dimensionValues as Record<string, string>), ...input.dimensionValues },
    startDate: isoDate(parent.startDate),
    endDate: isoDate(parent.endDate),
    currency: parent.currency,
    ownerId: parent.ownerId,
    periodId: parent.periodId,
    amount: input.amount,
    rationale: input.rationale,
  });
  if (child.draftVersionId === null) throw new Error("add-child: the child has no draft");
  const submitted = await submitVersionIn(tx, auth, child.id, { versionId: child.draftVersionId });
  return { envelopeId: child.id, parentId, ...submitted };
}

/** POST /envelopes/:id/children */
export async function addChild(prisma: PrismaClient, auth: AuthContext, rawParentId: string, raw: unknown) {
  const parentId = parseId(rawParentId);
  const input = parseInput(AddChildInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, (tx) => addChildIn(tx, auth, workspaceId, parentId, input), { timeoutMs: 30_000 });
}

// ---------------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------------

class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super("structure preview rollback");
  }
}

/** A parent's cap in the reporting currency: its approved amount against its live children's approved total. */
async function capOf(tx: Tx, parentId: string | null) {
  if (parentId === null) return null;
  const parent = await tx.envelope.findUnique({ where: { id: parentId }, select: { id: true, name: true, currentVersionId: true, allowOverAllocation: true } });
  if (parent === null) return null;
  const children = await tx.envelope.findMany({ where: { parentId, status: { not: "ARCHIVED" } }, select: { currentVersionId: true } });
  const ids = [parent.currentVersionId, ...children.map((c) => c.currentVersionId)].filter((v): v is string => v !== null);
  const amounts = new Map((await tx.envelopeVersion.findMany({ where: { id: { in: ids } }, select: { id: true, amountReporting: true } })).map((v) => [v.id, new Decimal(v.amountReporting.toString())]));
  const childrenTotal = children.reduce((s, c) => s.plus((c.currentVersionId ? amounts.get(c.currentVersionId) : undefined) ?? 0), new Decimal(0));
  return { id: parent.id, name: parent.name, approved: parent.currentVersionId ? (amounts.get(parent.currentVersionId) ?? null) : null, children: childrenTotal, allowOverAllocation: parent.allowOverAllocation };
}

type Cap = NonNullable<Awaited<ReturnType<typeof capOf>>>;
const capView = (cap: Cap | null, delta: Decimal) => {
  if (cap === null) return null;
  const after = cap.children.plus(delta);
  return {
    id: cap.id,
    name: cap.name,
    approved: cap.approved?.toFixed(2) ?? null,
    childrenBefore: cap.children.toFixed(2),
    childrenAfter: after.toFixed(2),
    remainingAfter: cap.approved ? cap.approved.minus(after).toFixed(2) : null,
    overCap: cap.approved !== null && after.gt(cap.approved) && !cap.allowOverAllocation,
    allowOverAllocation: cap.allowOverAllocation,
  };
};

async function approvedReporting(tx: Tx, envelopeId: string): Promise<Decimal> {
  const e = await tx.envelope.findUnique({ where: { id: envelopeId }, select: { currentVersionId: true } });
  if (!e?.currentVersionId) return new Decimal(0);
  const v = await tx.envelopeVersion.findUnique({ where: { id: e.currentVersionId }, select: { amountReporting: true } });
  return new Decimal(v?.amountReporting.toString() ?? 0);
}

/** How the change is routed: applied at once, auto-approved by a policy, or a request with its first step. */
async function routingOf(tx: Tx, result: { autoApproved?: boolean; requestId?: string | null; policy?: { name: string; version: number } } | { lineageId: string }) {
  if (!("autoApproved" in result)) return { kind: "immediate" as const, policy: null, steps: [] as string[] };
  if (result.autoApproved) return { kind: "auto_approved" as const, policy: result.policy ?? null, steps: [] as string[] };
  const request = result.requestId ? await tx.approvalRequest.findUnique({ where: { id: result.requestId }, select: { policySnapshot: true } }) : null;
  const chain = ((request?.policySnapshot as { chain?: Array<{ role: string }> } | null)?.chain ?? []).map((c) => c.role);
  return { kind: "approval" as const, policy: result.policy ?? null, steps: chain };
}

/**
 * POST /envelopes/structure/preview. The change runs for real inside a transaction that is then
 * rolled back: nothing is written (audit, outbox and all), and every check the change would make
 * is made. A refused change is `{ ok: false, error }` so the dialog can say why and keep Commit off.
 */
export async function previewStructure(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const p = parseInput(StructurePreviewInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const reporting = (await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { reportingCurrency: true } }))?.reportingCurrency ?? "USD";
  try {
    await withTenant(
      prisma,
      auth.ctx,
      async (tx) => {
        let parent: ReturnType<typeof capView>;
        let previousParent: ReturnType<typeof capView> = null;
        let total: Decimal;
        let result: Parameters<typeof routingOf>[1];
        if (p.op === "add_child") {
          const cap = await capOf(tx, p.envelopeId);
          const env = await tx.envelope.findUnique({ where: { id: p.envelopeId }, select: { currency: true } });
          total = new Decimal(p.input.amount).mul((await resolveFx(tx, env?.currency ?? reporting, workspaceId)).rate).toDecimalPlaces(2);
          result = await addChildIn(tx, auth, workspaceId, p.envelopeId, p.input);
          parent = capView(cap, total);
        } else if (p.op === "move") {
          const env = await tx.envelope.findUnique({ where: { id: p.envelopeId }, select: { parentId: true } });
          total = await approvedReporting(tx, p.envelopeId);
          const [to, from] = [await capOf(tx, p.input.parentId), await capOf(tx, env?.parentId ?? null)];
          result = await moveIn(tx, auth, p.envelopeId, p.input);
          parent = capView(to, total);
          previousParent = capView(from, total.negated());
        } else if (p.op === "split") {
          const env = await tx.envelope.findUnique({ where: { id: p.envelopeId }, select: { parentId: true } });
          total = await approvedReporting(tx, p.envelopeId);
          const cap = await capOf(tx, env?.parentId ?? null);
          result = await splitIn(tx, auth, workspaceId, p.envelopeId, p.input);
          parent = capView(cap, new Decimal(0)); // the parts sum to the source
        } else {
          const ids = [...new Set(p.input.sourceIds)];
          if (ids.length < 2) throw new DomainError("VALIDATION", "Merge needs at least two different envelopes");
          const first = await tx.envelope.findUnique({ where: { id: ids[0] as string }, select: { parentId: true } });
          total = (await Promise.all(ids.map((id) => approvedReporting(tx, id)))).reduce((s, v) => s.plus(v), new Decimal(0));
          const cap = await capOf(tx, first?.parentId ?? null);
          result = await mergeIn(tx, auth, workspaceId, ids, p.input);
          parent = capView(cap, new Decimal(0)); // the merge holds the sum
        }
        throw new Rollback({ ok: true as const, op: p.op, currency: reporting, amount: total.toFixed(2), parent, previousParent, routing: await routingOf(tx, result) });
      },
      { timeoutMs: 60_000 },
    );
  } catch (e) {
    if (e instanceof Rollback) return e.value as Record<string, unknown>;
    if (e instanceof DomainError) return { ok: false as const, op: p.op, error: { code: e.code, message: e.message, details: e.details ?? null } };
    throw e;
  }
  throw new Error("structure preview: unreachable");
}
