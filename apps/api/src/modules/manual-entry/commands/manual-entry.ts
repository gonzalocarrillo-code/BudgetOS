import { createHash } from "node:crypto";
import { CreateManualEntryInput, DomainError, UpdateManualEntryInput, newId, type ManualEntryRowInput } from "@budget/domain";
import { audit, bumpDataVersion, ensurePartitions, matchRunFacts, outbox, upsertKpiFacts, upsertSpendFacts, withTenant, type LockedRequestRow, type TenantContext, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { ManualEntryBatch, Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { addHours, recordRequestChange, type PolicySnapshot } from "../../approvals/engine.js";
import { manualEntryScopes } from "../../approvals/read.js";
import { assertInScope } from "../../../common/scope.guard.js";
import { matchPolicy, type DiffFacts } from "../../approvals/policy-matcher.js";
import { batchView } from "../queries/manual-entry.js";
import { resolveChannel, validateBatch, type NormalizedRow } from "../validate.js";

/**
 * Manual result entry, write side (spec §26.2). A batch is edited while DRAFT; submit needs every
 * row valid and opens an approval request (`entity_type='manual_entry'`, first matching policy).
 * On approval the rows become spend and KPI facts (`source_system='manual'`, `source_run_id` =
 * the batch), matched to budgets as ingestion does, with who entered and who approved each in
 * `manual_entry_fact`; then `facts.loaded`. Rejection (or changes requested) reopens it as DRAFT.
 * Every write is one audit_event and one outbox row.
 */

const json = (v: unknown) => v as Prisma.InputJsonValue;
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function record(tx: Tx, ctx: TenantContext, b: ManualEntryBatch, action: string, after: Record<string, unknown>, topic = "manual_entry.changed") {
  await audit(tx, { workspaceId: b.workspaceId, actorId: ctx.userId, actorType: ctx.actorType, action, entityType: "manual_entry", entityId: b.id, after: { status: b.status, channel: b.channel, ...after }, requestId: ctx.requestId });
  await outbox(tx, { workspaceId: b.workspaceId, topic, payload: { batchId: b.id, action, status: b.status, ...after } });
}

async function lockBatch(tx: Tx, rawId: string): Promise<ManualEntryBatch> {
  const id = parseId(rawId);
  await tx.$executeRaw`SELECT 1 FROM manual_entry_batch WHERE id = ${id}::uuid FOR UPDATE`;
  const b = await tx.manualEntryBatch.findUnique({ where: { id } });
  if (b === null) throw new DomainError("NOT_FOUND", "Manual entry batch not found");
  return b;
}

/** POST /workspaces/:ws/manual-entries */
export async function createManualEntry(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateManualEntryInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const channel = await resolveChannel(tx, auth.user.orgId, workspaceId, input.channel);
    const v = await validateBatch(tx, { orgId: auth.user.orgId, workspaceId }, { channel, periodStart: input.periodStart, periodEnd: input.periodEnd }, input.rows);
    const b = await tx.manualEntryBatch.create({
      data: { id: newId(), workspaceId, channel, periodStart: new Date(input.periodStart), periodEnd: new Date(input.periodEnd), rows: json(v.rows), totals: json(v.totals), createdBy: auth.user.id },
    });
    await record(tx, auth.ctx, b, "manual_entry.created", { rows: v.rows.length, issues: v.issues.length });
    return { ...batchView(b), issues: v.issues, warnings: v.warnings };
  });
}

/** PATCH /manual-entries/:id — rows (and channel / period) of a DRAFT batch; invalid rows are kept and returned with reasons. */
export async function updateManualEntry(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const input = parseInput(UpdateManualEntryInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const before = await lockBatch(tx, rawId);
    if (before.status !== "DRAFT") throw new DomainError("CONFLICT", `A ${before.status.toLowerCase()} batch cannot be edited`, { status: before.status });
    const channel = input.channel ? await resolveChannel(tx, auth.user.orgId, before.workspaceId, input.channel) : before.channel;
    const periodStart = input.periodStart ?? iso(before.periodStart);
    const periodEnd = input.periodEnd ?? iso(before.periodEnd);
    if (periodStart > periodEnd) throw new DomainError("VALIDATION", "periodStart after periodEnd");
    const rows = input.rows ?? (before.rows as ManualEntryRowInput[]);
    const v = await validateBatch(tx, { orgId: auth.user.orgId, workspaceId: before.workspaceId }, { channel, periodStart, periodEnd }, rows);
    const b = await tx.manualEntryBatch.update({ where: { id: before.id }, data: { channel, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), rows: json(v.rows), totals: json(v.totals) } });
    await record(tx, auth.ctx, b, "manual_entry.updated", { rows: v.rows.length, issues: v.issues.length, totals: v.totals });
    return { ...batchView(b), issues: v.issues, warnings: v.warnings };
  });
}

/** POST /manual-entries/:id/submit — every row valid; an approval request, or approved at once by an empty chain. */
export async function submitManualEntry(prisma: PrismaClient, auth: AuthContext, rawId: string) {
  return withTenant(prisma, auth.ctx, async (tx) => {
    const b = await lockBatch(tx, rawId);
    if (b.status !== "DRAFT") throw new DomainError("CONFLICT", `A ${b.status.toLowerCase()} batch cannot be submitted`, { status: b.status });
    const v = await validateBatch(tx, { orgId: auth.user.orgId, workspaceId: b.workspaceId }, { channel: b.channel, periodStart: iso(b.periodStart), periodEnd: iso(b.periodEnd) }, b.rows as ManualEntryRowInput[]);
    if (v.rows.length === 0) throw new DomainError("VALIDATION", "The batch has no rows");
    if (v.issues.length > 0) throw new DomainError("VALIDATION", `Rows to fix before sending for approval: ${new Set(v.issues.map((i) => i.rowNo)).size}`, { issues: v.issues.slice(0, 200) });
    // The enterer's budget-editing scope must cover every row (a scoped planner enters their markets only).
    for (const scope of await manualEntryScopes(tx, { workspaceId: b.workspaceId, channel: b.channel, rows: v.rows })) assertInScope(auth, "envelope.edit_draft", scope);
    const amount = new Decimal(v.totals.amount ?? 0);
    const facts: DiffFacts = { entityType: "manual_entry", amountAbs: amount, deltaAbs: amount, deltaPct: new Decimal(1), isOverAllocation: false, level: 0, dimensionValues: { channel: b.channel }, daysRemaining: 0 };
    const policy = await matchPolicy(tx, b.workspaceId, facts);
    if (policy === null) throw new DomainError("POLICY_NOT_FOUND", "No approval policy matched");
    const policyRef = { id: policy.id, name: policy.name, version: policy.version };
    const submitted = await tx.manualEntryBatch.update({ where: { id: b.id }, data: { status: "SUBMITTED", submittedAt: new Date(), rows: json(v.rows), totals: json(v.totals) } });
    if (policy.chain.length === 0) {
      const approved = await approveManualEntry(tx, auth.ctx, b.id, null, auth.user.id, `auto-approved by policy ${policy.name} v${policy.version}`);
      return { autoApproved: true as const, requestId: null, batch: approved, policy: policyRef };
    }
    const snapshot: PolicySnapshot = { conditions: policy.conditionsParsed, chain: policy.chain, blockSelfApproval: policy.blockSelfApproval, allowExternalEvidence: policy.allowExternalEvidence, policyName: policy.name };
    const request = await tx.approvalRequest.create({
      data: {
        id: newId(),
        workspaceId: b.workspaceId,
        entityType: "manual_entry",
        entityId: b.id,
        policyId: policy.id,
        policyVersion: policy.version,
        policySnapshot: snapshot as unknown as Prisma.InputJsonObject,
        currentStep: 0,
        status: "PENDING",
        summary: `Manual results · ${b.channel} ${iso(b.periodStart)} – ${iso(b.periodEnd)}: ${v.rows.length} rows, ${v.totals.amount ?? "?"} (reporting currency).`,
        requestedBy: auth.user.id,
        dueAt: addHours(new Date(), policy.chain[0]?.timeoutHours ?? 48),
      },
    });
    const pending = await tx.manualEntryBatch.update({ where: { id: submitted.id }, data: { approvalRequestId: request.id } });
    await recordRequestChange(tx, auth.ctx, request, "approval.requested", { manualEntryId: b.id, policy: policy.name, policyVersion: policy.version, status: "PENDING", step: 0 });
    return { autoApproved: false as const, requestId: request.id, batch: batchView(pending), policy: policyRef };
  });
}

const hash = (batchId: string, rowNo: number, metric?: string) => createHash("sha256").update(`manual:${batchId}:${rowNo}${metric ? `:${metric}` : ""}`).digest("hex");

/**
 * The approval of a batch (called by the approval engine after its last step, or by submit on an
 * empty chain): its rows become facts, matched to budgets, with lineage. `approvedBy` is the last
 * approver (the submitter on an auto-approval).
 */
export async function approveManualEntry(tx: Tx, ctx: TenantContext, batchId: string, requestId: string | null, approvedBy: string, reason: string) {
  const b = await tx.manualEntryBatch.findUnique({ where: { id: batchId } });
  if (b === null) throw new DomainError("NOT_FOUND", "Manual entry batch not found");
  if (b.status !== "SUBMITTED") throw new DomainError("CONFLICT", `A ${b.status.toLowerCase()} batch cannot be approved`, { status: b.status });
  const org = await tx.workspace.findUniqueOrThrow({ where: { id: b.workspaceId }, select: { orgId: true } });
  const v = await validateBatch(tx, { orgId: org.orgId, workspaceId: b.workspaceId }, { channel: b.channel, periodStart: iso(b.periodStart), periodEnd: iso(b.periodEnd) }, b.rows as ManualEntryRowInput[]);
  if (v.issues.length > 0) throw new DomainError("VALIDATION", "The batch no longer validates (the registry or FX rates changed); reject it for changes", { issues: v.issues.slice(0, 200) });

  const load = { workspaceId: b.workspaceId, sourceSystem: "manual", sourceRunId: b.id };
  const dims = (r: NormalizedRow) => ({ ...r.dimensionValues, channel: b.channel });
  await ensurePartitions(tx, iso(b.periodStart), iso(b.periodEnd));
  const spend = v.rows.map((r) => {
    const rep = v.reporting.get(r.rowNo);
    return { dimensionValues: dims(r), periodDate: r.periodDate, currency: r.currency, amount: r.amount, amountReporting: rep?.amount ?? r.amount, fxRateId: rep?.fxRateId ?? null, rowHash: hash(b.id, r.rowNo) };
  });
  const kpis = v.rows.flatMap((r) => Object.entries(r.kpis).map(([metric, value]) => ({ dimensionValues: dims(r), periodDate: r.periodDate, metric, value, attributionModel: null, rowHash: hash(b.id, r.rowNo, metric) })));
  await upsertSpendFacts(tx, load, spend);
  await upsertKpiFacts(tx, load, kpis);
  const envelopeIds = await matchRunFacts(tx, b.workspaceId, b.id);
  await tx.manualEntryFact.createMany({
    data: [
      ...v.rows.map((r) => ({ workspaceId: b.workspaceId, batchId: b.id, rowNo: r.rowNo, factTable: "spend_fact", metric: null, sourceRowHash: hash(b.id, r.rowNo), periodDate: new Date(r.periodDate), enteredBy: b.createdBy, approvedBy })),
      ...v.rows.flatMap((r) => Object.keys(r.kpis).map((metric) => ({ workspaceId: b.workspaceId, batchId: b.id, rowNo: r.rowNo, factTable: "kpi_fact", metric, sourceRowHash: hash(b.id, r.rowNo, metric), periodDate: new Date(r.periodDate), enteredBy: b.createdBy, approvedBy }))),
    ],
    skipDuplicates: true,
  });
  const approved = await tx.manualEntryBatch.update({ where: { id: b.id }, data: { status: "APPROVED" } });
  await audit(tx, { workspaceId: b.workspaceId, actorId: ctx.userId, actorType: ctx.actorType, action: "manual_entry.approved", entityType: "manual_entry", entityId: b.id, after: { status: "APPROVED", requestId, reason, spendFacts: spend.length, kpiFacts: kpis.length, envelopeIds, enteredBy: b.createdBy, approvedBy }, requestId: ctx.requestId });
  // Same topic as an ingest run: rollups, pacing and search pick the new actuals up.
  await outbox(tx, { workspaceId: b.workspaceId, topic: "facts.loaded", payload: { runId: b.id, sourceSystem: "manual", manualEntryId: b.id, envelopeIds } });
  await bumpDataVersion(tx, b.workspaceId);
  return batchView(approved);
}

/** Reject / changes requested / withdrawn: the batch goes back to DRAFT to be fixed and sent again (spec §26.2). */
export async function reopenManualEntry(tx: Tx, r: LockedRequestRow, outcome: "REJECTED" | "WITHDRAWN" | "CHANGES_REQUESTED") {
  const b = await tx.manualEntryBatch.findUnique({ where: { id: r.entityId } });
  if (b === null) throw new DomainError("NOT_FOUND", "Manual entry batch not found");
  const reopened = await tx.manualEntryBatch.update({ where: { id: b.id }, data: { status: "DRAFT", approvalRequestId: null } });
  await tx.approvalRequest.update({ where: { id: r.id }, data: outcome === "CHANGES_REQUESTED" ? { status: outcome } : { status: outcome, resolvedAt: new Date() } });
  // The decision's own audit_event and approval.changed row record this (recordRequestChange).
  return reopened;
}
