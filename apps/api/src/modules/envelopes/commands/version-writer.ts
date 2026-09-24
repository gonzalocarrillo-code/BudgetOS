import { DomainError, newId } from "@budget/domain";
import { audit, bumpDataVersion, lockEnvelope, outbox, type LockedEnvelopeRow, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { Prisma } from "@prisma/client";
import { assertInScope, envelopeScopeTarget } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";

/** Shared steps of every envelope write (spec §7): lock, writable, scope, concurrency, version row, audit + outbox. */

export async function lockForWrite(tx: Tx, auth: AuthContext, envelopeId: string, action: "envelope.edit_draft"): Promise<LockedEnvelopeRow> {
  const env = await lockEnvelope(tx, envelopeId);
  if (env === null) throw new DomainError("NOT_FOUND", "Envelope not found");
  if (env.status === "LOCKED") throw new DomainError("LOCKED", "Period is closed; restate via closure");
  if (env.status === "ARCHIVED") throw new DomainError("CONFLICT", "Envelope is archived");
  assertInScope(auth, action, await envelopeScopeTarget(tx, envelopeId));
  return env;
}

/** The version the client must have seen: the open draft, else the current approved version. */
export const headVersionId = (env: LockedEnvelopeRow): string | null => env.draftVersionId ?? env.currentVersionId;

export function assertBasedOnHead(env: LockedEnvelopeRow, basedOnVersionId: string | null): void {
  const head = headVersionId(env);
  if ((basedOnVersionId ?? null) !== head) {
    throw new DomainError("CONFLICT", "Envelope changed since you loaded it", { currentVersionId: head });
  }
}

/** A draft under approval is frozen: withdraw it (T-011) before editing again. */
export async function assertDraftNotPending(tx: Tx, env: LockedEnvelopeRow): Promise<void> {
  if (env.draftVersionId === null) return;
  const draft = await tx.envelopeVersion.findUnique({ where: { id: env.draftVersionId }, select: { status: true } });
  if (draft?.status === "PENDING") {
    throw new DomainError("CONFLICT", "A version of this envelope is awaiting approval", { currentVersionId: env.draftVersionId });
  }
}

/**
 * FX into the workspace reporting currency. No provider is chosen yet (plan §16 question 2), so this
 * reads the latest `fx_rate` on or before today and refuses to guess when none exists.
 */
export async function resolveFx(tx: Tx, currency: string, workspaceId: string): Promise<{ id: string | null; rate: Decimal }> {
  const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { reportingCurrency: true } });
  if (ws === null) throw new DomainError("NOT_FOUND", "Workspace not found");
  if (ws.reportingCurrency === currency) return { id: null, rate: new Decimal(1) };
  const fx = await tx.fxRate.findFirst({
    where: { base: currency, quote: ws.reportingCurrency, asOfDate: { lte: new Date() } },
    orderBy: { asOfDate: "desc" },
  });
  if (fx === null) {
    throw new DomainError("VALIDATION", `No FX rate ${currency}→${ws.reportingCurrency}`, { base: currency, quote: ws.reportingCurrency });
  }
  return { id: fx.id, rate: new Decimal(fx.rate.toString()) };
}

export interface PhasingRow {
  month: string;
  amount: string;
}

/** Phasing: first-of-month dates, unique, inside the envelope's months, summing exactly to the amount. */
export function checkPhasing(amount: Decimal, phasing: PhasingRow[] | undefined, range: { startDate: string; endDate: string }): void {
  if (phasing === undefined) return;
  const seen = new Set<string>();
  const first = `${range.startDate.slice(0, 7)}-01`;
  const last = `${range.endDate.slice(0, 7)}-01`;
  let sum = new Decimal(0);
  for (const p of phasing) {
    if (!p.month.endsWith("-01")) throw new DomainError("VALIDATION", "Phasing months are first-of-month dates", { month: p.month });
    if (seen.has(p.month)) throw new DomainError("VALIDATION", "Phasing month repeated", { month: p.month });
    if (p.month < first || p.month > last) throw new DomainError("VALIDATION", "Phasing month outside the envelope dates", { month: p.month });
    seen.add(p.month);
    sum = sum.plus(p.amount);
  }
  if (!sum.equals(amount)) throw new DomainError("VALIDATION", "Phasing must sum to amount", { sum: sum.toFixed(2), amount: amount.toFixed(2) });
}

export interface DraftSpec {
  amount: Decimal;
  phasing: PhasingRow[] | undefined;
  rationale: string | undefined;
  attachments: Prisma.InputJsonValue;
}

/**
 * Inserts a new DRAFT version and points the envelope at it. The previous open draft is superseded,
 * never deleted, and the approved version is never touched.
 */
export async function writeDraftVersion(tx: Tx, auth: AuthContext, env: LockedEnvelopeRow, spec: DraftSpec) {
  checkPhasing(spec.amount, spec.phasing, env);
  const last = await tx.envelopeVersion.aggregate({ where: { envelopeId: env.id }, _max: { versionNo: true } });
  const versionNo = (last._max.versionNo ?? 0) + 1;
  const fx = await resolveFx(tx, env.currency, env.workspaceId);
  const version = await tx.envelopeVersion.create({
    data: {
      id: newId(),
      envelopeId: env.id,
      versionNo,
      amount: spec.amount.toFixed(2),
      amountReporting: spec.amount.mul(fx.rate).toDecimalPlaces(2).toFixed(2),
      fxRateId: fx.id,
      status: "DRAFT",
      basedOnVersionId: env.currentVersionId,
      rationale: spec.rationale ?? null,
      attachments: spec.attachments,
      createdBy: auth.user.id,
      ...(spec.phasing ? { phasing: { create: spec.phasing.map((p) => ({ month: new Date(`${p.month}T00:00:00Z`), amount: p.amount })) } } : {}),
    },
  });
  if (env.draftVersionId) {
    await tx.envelopeVersion.update({ where: { id: env.draftVersionId }, data: { status: "SUPERSEDED", supersededAt: new Date() } });
  }
  await tx.envelope.update({
    where: { id: env.id },
    data: { draftVersionId: version.id, status: env.status === "APPROVED" ? "APPROVED" : "DRAFT", rowVersion: { increment: 1 } },
  });
  return version;
}

/** Exactly one audit_event and one outbox row per write path, plus the cache data version. */
export async function recordEnvelopeChange(
  tx: Tx,
  auth: AuthContext,
  args: { workspaceId: string; envelopeId: string; action: string; kind: string; before?: unknown; after: Record<string, unknown>; reason?: string | undefined },
): Promise<void> {
  await audit(tx, {
    workspaceId: args.workspaceId,
    actorId: auth.user.id,
    actorType: auth.ctx.actorType,
    action: args.action,
    entityType: "envelope",
    entityId: args.envelopeId,
    before: args.before ?? null,
    after: args.after,
    ...(args.reason ? { reason: args.reason } : {}),
    requestId: auth.ctx.requestId,
  });
  await outbox(tx, { workspaceId: args.workspaceId, topic: "budget.changed", payload: { envelopeId: args.envelopeId, kind: args.kind, ...args.after } });
  await bumpDataVersion(tx, args.workspaceId);
}
