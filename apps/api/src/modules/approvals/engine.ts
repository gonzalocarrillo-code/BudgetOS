import { DomainError, newId } from "@budget/domain";
import { applyDates, applyEnd, archiveEnvelopes, audit, auditMany, closeBulkVersions, loadBulkChange, lockEnvelopes, outbox, releaseHeld, type BulkChangeRow, type LockedRequestRow, type TenantContext, type Tx } from "@budget/db";
import { clock } from "../../common/clock.js";
import { approveTargetVersion } from "../targets/commands/approve-target-version.js";
import { approveVersion } from "./commands/approve-version.js";
import { approveManualEntry, reopenManualEntry } from "../manual-entry/commands/manual-entry.js";
import { OPEN_STATUSES, PolicySnapshot, SUPPORTED_ENTITY_TYPES, requestTargets } from "./read.js";
import { revalidateDates } from "./revalidate-dates.js";

export { OPEN_STATUSES, PolicySnapshot, SUPPORTED_ENTITY_TYPES, requestTargets } from "./read.js";
export type { RequestTargets } from "./read.js";

const HOUR_MS = 3_600_000;
export const addHours = (d: Date, h: number) => new Date(d.getTime() + h * HOUR_MS);

export function snapshotOf(r: LockedRequestRow): PolicySnapshot {
  const parsed = PolicySnapshot.safeParse(r.policySnapshot);
  if (!parsed.success) throw new DomainError("VALIDATION", "Request has an unreadable policy snapshot", { requestId: r.id });
  return parsed.data;
}

export function assertOpen(r: LockedRequestRow): void {
  if (!(OPEN_STATUSES as readonly string[]).includes(r.status)) throw new DomainError("CONFLICT", `Request is ${r.status}`, { status: r.status });
}

export function assertEnvelopeRequest(r: LockedRequestRow): void {
  if (!(SUPPORTED_ENTITY_TYPES as readonly string[]).includes(r.entityType)) {
    throw new DomainError("VALIDATION", `Approvals for ${r.entityType} are not supported yet`, { entityType: r.entityType });
  }
}

/** A closed period freezes its envelopes' requests too (spec §15): no decision or withdrawal until it is restated. */
export async function assertNotLocked(tx: Tx, r: { entityType: string; entityId: string }): Promise<void> {
  if (r.entityType === "target_version" || r.entityType === "manual_entry") return; // a batch's closed-period rows are refused on save and submit
  const { versions } = await requestTargets(tx, r);
  const locked = await tx.envelope.count({ where: { id: { in: [...new Set(versions.map((v) => v.envelopeId))] }, status: "LOCKED" } });
  if (locked > 0) throw new DomainError("LOCKED", "Period is closed; restate via closure", { lockedEnvelopes: locked });
}

/** Every envelope a bulk change touches: its versions' budgets, sources, new budgets, the ended budget, the dated lines. */
async function bulkEnvelopeIds(tx: Tx, bulk: BulkChangeRow): Promise<string[]> {
  const versions = await tx.envelopeVersion.findMany({ where: { id: { in: bulk.versionIds } }, select: { envelopeId: true } });
  return [
    ...new Set([
      ...versions.map((v) => v.envelopeId),
      ...bulk.archiveIds,
      ...bulk.createdIds,
      ...(bulk.payload.end ? [bulk.payload.end.envelopeId] : []),
      ...(bulk.payload.dates ?? []).map((d) => d.envelopeId),
    ]),
  ];
}

/**
 * W3-5 lock order (audit I-15; structure.ts has the whole order): right after the request's own
 * lock, every envelope a decision on it may write, and their parents (the cap check locks those),
 * in id order. Later locks on the same rows are then no-ops, so a decision never holds one budget
 * while waiting for another that a move or a date change holds the other way round.
 */
export async function lockRequestEnvelopes(tx: Tx, r: { entityType: string; entityId: string }): Promise<void> {
  let ids: string[];
  if (r.entityType === "bulk_change") {
    const bulk = await loadBulkChange(tx, r.entityId);
    if (bulk === null) return;
    ids = await bulkEnvelopeIds(tx, bulk);
  } else if (r.entityType === "envelope_version") {
    const v = await tx.envelopeVersion.findUnique({ where: { id: r.entityId }, select: { envelopeId: true } });
    if (v === null) return;
    ids = [v.envelopeId];
  } else {
    return; // targets and manual entries lock no envelope
  }
  const parents = await tx.envelope.findMany({ where: { id: { in: ids }, parentId: { not: null } }, select: { parentId: true } });
  await lockEnvelopes(tx, [...new Set([...ids, ...parents.map((p) => p.parentId as string)])]);
}

/**
 * Approves every version of a bulk change (plan §9.3; split / merge per spec §7.5). Sources being
 * archived go first — their version is the zero amount — so the new siblings fit the parent's cap;
 * the rest go parents first. Then the sources are archived.
 *
 * A date change is checked again first (W3-5): if the tree moved since the request, this throws
 * `StaleRequestError` before anything is written, and decide() returns the request for changes.
 */
export async function finalizeBulk(tx: Tx, ctx: TenantContext, bulkChangeId: string, requestId: string | null, reason: string): Promise<void> {
  const bulk = await loadBulkChange(tx, bulkChangeId);
  if (!bulk) throw new DomainError("NOT_FOUND", "Bulk change not found");
  if (bulk.payload.dates) await revalidateDates(tx, bulk.payload.dates);
  const versions = await tx.envelopeVersion.findMany({ where: { id: { in: bulk.versionIds } }, select: { id: true, envelopeId: true } });
  // Sources that give their amount back (split / merge sources, an ended budget) go first, so the
  // new siblings (parts, the merge, a successor) fit the parent's cap; then parents before children.
  const release = new Set([...bulk.archiveIds, ...(bulk.payload.end ? [bulk.payload.end.envelopeId] : [])]);
  const d = await depths(tx, versions.map((v) => v.envelopeId));
  const rank = (v: { envelopeId: string }) => (release.has(v.envelopeId) ? -1 : (d.get(v.envelopeId) ?? 0));
  for (const v of versions.slice().sort((a, b) => rank(a) - rank(b))) {
    await approveVersion(tx, ctx, v.id, requestId, `${reason} (${bulk.kind} ${bulkChangeId})`);
  }
  await archiveEnvelopes(tx, bulk.archiveIds);
  if (bulk.payload.end) await applyEnd(tx, bulk.payload.end, bulk.createdBy); // H-011
  if (bulk.payload.dates) await applyRequestedDates(tx, ctx, bulk, new Set(versions.map((v) => v.envelopeId)), requestId, reason); // ADR-060
}

/**
 * The approved dates (ADR-060). Budgets with a version in the change were audited and announced by
 * approveVersion; the others (never approved, trimmed with their parent) get their own audit row
 * and outbox row here, and every held budget gets its resting status back (W3-5).
 */
async function applyRequestedDates(tx: Tx, ctx: TenantContext, bulk: BulkChangeRow, versioned: Set<string>, requestId: string | null, reason: string): Promise<void> {
  const dates = bulk.payload.dates ?? [];
  const rest = dates.filter((d) => !versioned.has(d.envelopeId));
  const before = new Map(
    (await tx.envelope.findMany({ where: { id: { in: rest.map((d) => d.envelopeId) } }, select: { id: true, workspaceId: true, startDate: true, endDate: true } })).map((e) => [e.id, e]),
  );
  await applyDates(tx, dates);
  await releaseHeld(tx, dates.map((d) => d.envelopeId));
  if (rest.length === 0) return;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const workspaceId = [...before.values()][0]?.workspaceId;
  if (workspaceId === undefined) return;
  await auditMany(
    tx,
    rest.map((d) => {
      const b = before.get(d.envelopeId);
      return {
        workspaceId,
        actorId: ctx.userId,
        actorType: ctx.actorType,
        action: "envelope.dates_changed",
        entityType: "envelope",
        entityId: d.envelopeId,
        before: b ? { startDate: iso(b.startDate), endDate: iso(b.endDate) } : null,
        after: { startDate: d.startDate, endDate: d.endDate, bulkChangeId: bulk.id, requestId },
        reason: `${reason} (${bulk.kind} ${bulk.id})`,
        requestId: ctx.requestId,
      };
    }),
  );
  for (const d of rest) {
    await outbox(tx, { workspaceId, topic: "budget.changed", payload: { envelopeId: d.envelopeId, kind: "dates", startDate: d.startDate, endDate: d.endDate, bulkChangeId: bulk.id, requestId } });
  }
}

/** Envelope depth (0 = root) so bulk approvals run parents first and child caps see the parent's new amount. */
async function depths(tx: Tx, envelopeIds: string[]): Promise<Map<string, number>> {
  const rows = await tx.$queryRaw<Array<{ id: string; d: number }>>`
    WITH RECURSIVE up AS (SELECT id AS start, parent_id, 0 AS d FROM envelope WHERE id = ANY(${envelopeIds}::uuid[])
      UNION ALL SELECT up.start, e.parent_id, up.d + 1 FROM envelope e JOIN up ON e.id = up.parent_id)
    SELECT start::text AS id, max(d)::int AS d FROM up GROUP BY start`;
  return new Map(rows.map((x) => [x.id, x.d]));
}

/**
 * Approvals that count toward the current step: approves, plus external evidence when the policy
 * allows it. W3-3 (audit I-18): counts distinct deciders, not rows -- one requester recording
 * external evidence twice (or, before the unique index in 20261013030000_partial_unique_constraints,
 * racing two decisions in) must not satisfy minApprovals twice over. The database backs this with a
 * unique index on (request_id, step_index, decided_by): a second row for the same decider is refused
 * before this ever runs again for that step.
 */
export async function countedApprovals(tx: Tx, r: LockedRequestRow, snapshot: PolicySnapshot): Promise<number> {
  const decisions = snapshot.allowExternalEvidence ? ["approve", "external_evidence"] : ["approve"];
  const deciders = await tx.approvalDecision.findMany({
    where: { requestId: r.id, stepIndex: r.currentStep, decision: { in: decisions } },
    distinct: ["decidedBy"],
    select: { decidedBy: true },
  });
  return deciders.length;
}

/**
 * After an approving decision: advance when the step has enough approvals; approve the version
 * after the last step. `final` (an admin's approval, ADR-048) approves the request outright,
 * whatever steps and approval counts remain.
 */
export async function advanceIfComplete(tx: Tx, ctx: TenantContext, r: LockedRequestRow, snapshot: PolicySnapshot, final = false): Promise<"advanced" | "approved" | "waiting"> {
  const step = snapshot.chain[r.currentStep];
  if (step === undefined) throw new DomainError("VALIDATION", "Request is past its last step", { requestId: r.id });
  if (!final && (await countedApprovals(tx, r, snapshot)) < step.minApprovals) return "waiting";
  const next = r.currentStep + 1;
  if (final || next >= snapshot.chain.length) {
    const reason = `approved via policy ${snapshot.policyName ?? r.policyId} v${r.policyVersion}`;
    if (r.entityType === "bulk_change") {
      await finalizeBulk(tx, ctx, r.entityId, r.id, reason);
    } else if (r.entityType === "target_version") {
      await approveTargetVersion(tx, ctx, r.entityId, r.id, reason);
    } else if (r.entityType === "manual_entry") {
      await approveManualEntry(tx, ctx, r.entityId, r.id, ctx.userId ?? r.requestedBy, reason);
    } else {
      await approveVersion(tx, ctx, r.entityId, r.id, reason);
    }
    await tx.approvalRequest.update({ where: { id: r.id }, data: { status: "APPROVED", resolvedAt: clock.now() } });
    return "approved";
  }
  const nextStep = snapshot.chain[next];
  await tx.approvalRequest.update({ where: { id: r.id }, data: { currentStep: next, status: "PENDING", dueAt: addHours(new Date(), nextStep?.timeoutHours ?? 48) } });
  return "advanced";
}

/**
 * Ends the request without approval (reject / withdraw) or returns it for changes. The version
 * leaves PENDING: REJECTED or WITHDRAWN drafts are closed for good (the envelope's draft pointer is
 * cleared so a new draft never overwrites them); CHANGES_REQUESTED reopens the same draft for edits.
 */
export async function closeRequest(tx: Tx, r: LockedRequestRow, outcome: "REJECTED" | "WITHDRAWN" | "CHANGES_REQUESTED"): Promise<void> {
  if (r.entityType === "bulk_change") {
    const bulk = await loadBulkChange(tx, r.entityId);
    if (!bulk) throw new DomainError("NOT_FOUND", "Bulk change not found");
    await closeBulkVersions(tx, bulk.versionIds, outcome);
    // Dated budgets held without a version of their own (W3-5) get their status back too.
    if (bulk.payload.dates) await releaseHeld(tx, bulk.payload.dates.map((d) => d.envelopeId));
    // New split / merge envelopes that will never be approved.
    if (outcome !== "CHANGES_REQUESTED") await archiveEnvelopes(tx, bulk.createdIds);
    await tx.approvalRequest.update({ where: { id: r.id }, data: outcome === "CHANGES_REQUESTED" ? { status: outcome } : { status: outcome, resolvedAt: new Date() } });
    return;
  }
  if (r.entityType === "manual_entry") {
    // Spec §26.2: a rejected (or returned) batch reopens as DRAFT.
    await reopenManualEntry(tx, r, outcome);
    return;
  }
  if (r.entityType === "target_version") {
    const tv = await tx.targetVersion.findUnique({ where: { id: r.entityId } });
    if (tv === null) throw new DomainError("NOT_FOUND", "Target version not found");
    if (outcome === "CHANGES_REQUESTED") {
      await tx.targetVersion.update({ where: { id: tv.id }, data: { status: "DRAFT" } });
      await tx.approvalRequest.update({ where: { id: r.id }, data: { status: outcome } });
      return;
    }
    await tx.targetVersion.update({ where: { id: tv.id }, data: { status: outcome === "REJECTED" ? "REJECTED" : "WITHDRAWN" } });
    await tx.target.update({ where: { id: tv.targetId }, data: { draftVersionId: null } });
    await tx.approvalRequest.update({ where: { id: r.id }, data: { status: outcome, resolvedAt: new Date() } });
    return;
  }
  const version = await tx.envelopeVersion.findUnique({ where: { id: r.entityId }, include: { envelope: true } });
  if (version === null) throw new DomainError("NOT_FOUND", "Version not found");
  const env = version.envelope;
  const restingStatus = env.currentVersionId ? "APPROVED" : "DRAFT";
  if (outcome === "CHANGES_REQUESTED") {
    await tx.envelopeVersion.update({ where: { id: version.id }, data: { status: "DRAFT" } });
    await tx.envelope.update({ where: { id: env.id }, data: { status: restingStatus, rowVersion: { increment: 1 } } });
    await tx.approvalRequest.update({ where: { id: r.id }, data: { status: "CHANGES_REQUESTED" } });
    return;
  }
  await tx.envelopeVersion.update({ where: { id: version.id }, data: { status: outcome === "REJECTED" ? "REJECTED" : "WITHDRAWN" } });
  await tx.envelope.update({ where: { id: env.id }, data: { status: restingStatus, draftVersionId: null, rowVersion: { increment: 1 } } });
  await tx.approvalRequest.update({ where: { id: r.id }, data: { status: outcome, resolvedAt: new Date() } });
}

/** §8.6 integration: "request changes" opens a blocking thread on the envelope; submit is blocked until it is resolved. */
export async function openBlockingThread(tx: Tx, ctx: TenantContext, r: LockedRequestRow, comment: string): Promise<string> {
  // A bulk change spans many envelopes: the thread sits on the request itself.
  const anchor =
    r.entityType === "bulk_change" || r.entityType === "manual_entry"
      ? { anchorType: "approval_request", anchorId: r.id }
      : r.entityType === "target_version"
        ? { anchorType: "target", anchorId: (await tx.targetVersion.findUniqueOrThrow({ where: { id: r.entityId }, select: { targetId: true } })).targetId }
        : { anchorType: "envelope", anchorId: (await tx.envelopeVersion.findUniqueOrThrow({ where: { id: r.entityId }, select: { envelopeId: true } })).envelopeId };
  const threadId = newId();
  await tx.thread.create({
    data: {
      id: threadId,
      workspaceId: r.workspaceId,
      ...anchor,
      anchorMeta: { approvalRequestId: r.id },
      title: "Changes requested",
      isBlocking: true,
      createdBy: ctx.userId ?? r.requestedBy,
      comments: { create: { id: newId(), authorId: ctx.userId ?? r.requestedBy, bodyMd: comment } },
    },
  });
  return threadId;
}

/** One audit_event + one outbox row for a request-level change. */
export async function recordRequestChange(tx: Tx, ctx: TenantContext, r: { id: string; workspaceId: string }, action: string, after: Record<string, unknown>): Promise<void> {
  await audit(tx, {
    workspaceId: r.workspaceId,
    actorId: ctx.userId,
    actorType: ctx.actorType,
    action,
    entityType: "approval_request",
    entityId: r.id,
    after,
    requestId: ctx.requestId,
  });
  await outbox(tx, { workspaceId: r.workspaceId, topic: "approval.changed", payload: { requestId: r.id, action, ...after } });
}
