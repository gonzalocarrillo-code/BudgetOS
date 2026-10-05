import { BudgetImportCommitInput, BudgetImportInput, BudgetImportTemplateQuery, DomainError, newId, resolvePeriod, type BudgetImportPreview } from "@budget/domain";
import { audit, auditMany, bumpDataVersion, lockWorkspaceImport, outbox, recomputeNames, withTenant, type LockedEnvelopeRow, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { toCsv } from "../bulk/csv.js";
import { PREVIEW_TTL_SECONDS, type PreviewStore } from "../bulk/preview-store.js";
import { insertEnvelopeRow } from "../commands/create-envelope.js";
import { routeStructural } from "../commands/structure.js";
import { assertDraftNotPending, lockForWrite, writeDraftVersion } from "../commands/version-writer.js";
import { buildImportPlan, parentsOf, type ImportPlan, type PlannedNode } from "./plan.js";

/**
 * Budget CSV import (docs/DATA_PLAN.md §3, D-007 and D-008). The template comes from the
 * workspace's registry; the preview reads a file into a plan without writing anything; the commit
 * rebuilds the plan in its own transaction and writes it as drafts under one approval, like a paste
 * or a split: new budgets, the parents it creates, and amount changes, approved together.
 */
const TX = { timeoutMs: 120_000 };

/** GET /workspaces/:ws/budget-import/template: the columns this workspace's file takes, and two live budgets as examples. */
export async function budgetImportTemplate(prisma: PrismaClient, auth: AuthContext, raw: unknown, today = new Date().toISOString().slice(0, 10)): Promise<{ filename: string; csv: string }> {
  const q = parseInput(BudgetImportTemplateQuery, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, fiscalYearStartMonth: true, reportingCurrency: true } });
    const template = q.templateId ? await tx.hierarchyTemplate.findFirst({ where: { id: q.templateId, workspaceId } }) : await tx.hierarchyTemplate.findFirst({ where: { workspaceId, isDefault: true } });
    if (q.templateId && !template) throw new DomainError("NOT_FOUND", "Hierarchy template not found");
    const dimRows = await tx.dimension.findMany({ where: { orgId: auth.user.orgId, isActive: true, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true, key: true, workspaceId: true } });
    const withValues = new Set((await tx.dimensionValue.groupBy({ by: ["dimensionId"], where: { dimensionId: { in: dimRows.map((d) => d.id) }, isActive: true } })).map((v) => v.dimensionId));
    const keys = [...new Set(dimRows.filter((d) => withValues.has(d.id)).map((d) => d.key))];
    const order = template?.path ?? [];
    const dims = [...order.filter((k) => keys.includes(k)), ...keys.filter((k) => !order.includes(k)).sort()];
    const fy = resolvePeriod({ kind: "relative", preset: "current_year" }, today, ws.fiscalYearStartMonth);
    const months: string[] = [];
    for (let d = new Date(`${fy.start}T00:00:00Z`); d.toISOString().slice(0, 10) <= fy.end; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
    const header = ["key", "parent_key", ...dims, "name", "currency", "amount", "start_date", "end_date", ...months, "envelope_id", "rationale"];
    const help = [`# One row per budget. Granularities: codes or labels from the registry. Parents follow the hierarchy "${template?.name ?? "none"}" unless parent_key names another row's key or a budget id. Months (${months[0]} …) are optional phasing and must add up to amount. A row with envelope_id, or with the granularities and dates of an existing budget, changes that budget. Rows starting with # are ignored. Everything becomes drafts under one approval.`, ...header.slice(1).map(() => "")];
    // Two live leaves as examples: re-importing them unchanged changes nothing.
    const leaves = await tx.envelope.findMany({ where: { workspaceId, status: { in: ["APPROVED", "DRAFT"] }, endedAt: null, children: { none: {} } }, orderBy: { createdAt: "asc" }, take: 2 });
    const amounts = new Map((await tx.envelopeVersion.findMany({ where: { id: { in: leaves.map((e) => e.currentVersionId).filter((v): v is string => v !== null) } }, select: { id: true, amount: true } })).map((v) => [v.id, v.amount.toFixed(2)]));
    const examples = leaves.map((e) => {
      const dv = e.dimensionValues as Record<string, string>;
      return ["", "", ...dims.map((k) => dv[k] ?? ""), e.name, e.currency, (e.currentVersionId ? amounts.get(e.currentVersionId) : undefined) ?? "", e.startDate.toISOString().slice(0, 10), e.endDate.toISOString().slice(0, 10), ...months.map(() => ""), e.id, ""];
    });
    const slug = ws.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
    return { filename: `budget-import-${slug}.csv`, csv: toCsv(header, [help, ...examples]) };
  });
}

/** What the preview shows: the plan's lines, the parents it creates, and whether Commit may run. */
function previewOf(previewId: string, plan: ImportPlan): BudgetImportPreview {
  const counts = { new: 0, change: 0, same: 0, error: 0, parents: plan.nodes.filter((n) => n.kind === "parent").length };
  for (const l of plan.lines) counts[l.status] += 1;
  const blocked =
    counts.error > 0 ? `${counts.error} line${counts.error === 1 ? " has" : "s have"} a problem; fix the file and preview again`
    : plan.overCap.length > 0 ? `${plan.overCap.map((o) => o.name).join(", ")} would go over budget`
    : counts.new + counts.change === 0 ? "Nothing to change: every line matches the budget as it is"
    : null;
  return { previewId, lines: plan.lines, parents: parentsOf(plan), overCap: plan.overCap, counts, totals: { new: plan.totals.new.toFixed(2), change: plan.totals.change.toFixed(2) }, currency: plan.reporting, unknownColumns: plan.unknownColumns, blocked };
}

interface Stored {
  kind: "budget-import";
  workspaceId: string;
  userId: string;
  csv: string;
  templateId?: string;
}

/** POST /workspaces/:ws/budget-import/preview: the file read into a plan; nothing is written. */
export async function previewBudgetImport(prisma: PrismaClient, auth: AuthContext, raw: unknown, store: PreviewStore): Promise<BudgetImportPreview> {
  const input = parseInput(BudgetImportInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const previewId = newId();
  const plan = await withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const plan = await buildImportPlan(tx, auth, workspaceId, input.csv, input.templateId);
      const stored: Stored = { kind: "budget-import", workspaceId, userId: auth.user.id, csv: input.csv, ...(input.templateId ? { templateId: input.templateId } : {}) };
      await store.put(tx, previewId, "budget-import", JSON.stringify(stored), PREVIEW_TTL_SECONDS);
      return plan;
    },
    TX,
  );
  return previewOf(previewId, plan);
}

/**
 * POST /workspaces/:ws/budget-import/commit: rebuilds the plan (the budgets may have moved since the
 * preview) and writes it as drafts under one approval. Parents first, then the rows; changes are new
 * draft versions on their budgets. An admin's import applies at once (ADR-048).
 */
export async function commitBudgetImport(prisma: PrismaClient, auth: AuthContext, raw: unknown, store: PreviewStore) {
  const input = parseInput(BudgetImportCommitInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const result = await withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      // Consumed atomically (DELETE … RETURNING) inside this transaction: a second, concurrent
      // commit of the same preview can never also pass this check (W1-5 ADR-0072).
      const rawStored = await store.take(tx, input.previewId);
      const stored = JSON.parse(rawStored ?? "null") as Stored | null;
      if (!stored || stored.kind !== "budget-import" || stored.workspaceId !== workspaceId || stored.userId !== auth.user.id) throw new DomainError("NOT_FOUND", "Import preview not found or expired; preview the file again");
      // I-16: serialize commits for this workspace so two concurrent commits cannot both read "not
      // created yet" and both insert the same tuple. The loser waits here, then rebuilds the plan
      // against what the winner just wrote, so its own commit sees the row as unchanged and 409s.
      await lockWorkspaceImport(tx, workspaceId);
      const plan = await buildImportPlan(tx, auth, workspaceId, stored.csv, stored.templateId);
      const check = previewOf(input.previewId, plan);
      if (check.blocked) throw new DomainError("CONFLICT", `The file no longer imports as previewed: ${check.blocked}`, { counts: check.counts, overCap: check.overCap });
      return write(tx, auth, workspaceId, plan, input.rationale);
    },
    TX,
  );
  return result;
}

async function write(tx: Tx, auth: AuthContext, workspaceId: string, plan: ImportPlan, rationale: string) {
  const created = new Map<string, LockedEnvelopeRow>(); // ref → row
  const versionIds: string[] = [];
  const createdAudits: Parameters<typeof auditMany>[1] = [];
  // Parents before the rows under them.
  for (const n of [...plan.nodes].sort((a, b) => a.depth - b.depth)) {
    const parentId = n.parent === null ? null : "envelopeId" in n.parent ? n.parent.envelopeId : (created.get(n.parent.ref) as LockedEnvelopeRow).id;
    const row = await insertEnvelopeRow(tx, auth, workspaceId, { name: n.name, parentId, dimensionValues: n.dimensionValues, startDate: n.startDate, endDate: n.endDate, currency: n.currency, ownerId: null, periodId: null }, "envelope.create");
    const v = await writeDraftVersion(tx, auth, row, { amount: n.amount, phasing: n.phasing, rationale: n.rationale ?? rationale, attachments: [] });
    created.set(n.ref, row);
    versionIds.push(v.id);
    createdAudits.push({ workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "envelope.created", entityType: "envelope", entityId: row.id, after: { imported: true, line: n.line, kind: n.kind, amount: n.amount.toFixed(2), versionId: v.id }, reason: rationale, requestId: auth.ctx.requestId });
  }
  const changed: string[] = [];
  for (const c of plan.changes) {
    const env = await lockForWrite(tx, auth, c.envelope.id, "envelope.edit_draft");
    await assertDraftNotPending(tx, env);
    const v = await writeDraftVersion(tx, auth, env, { amount: c.amount, phasing: c.phasing, rationale: c.rationale ?? rationale, attachments: [] });
    versionIds.push(v.id);
    changed.push(env.id);
    createdAudits.push({ workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "envelope.draft.imported", entityType: "envelope", entityId: env.id, before: { versionId: c.envelope.currentVersionId, amount: c.envelope.amount }, after: { line: c.line, amount: c.amount.toFixed(2), versionId: v.id }, reason: rationale, requestId: auth.ctx.requestId });
  }
  const createdIds = [...created.values()].map((r) => r.id);
  await recomputeNames(tx, workspaceId, createdIds);
  const total = plan.totals.new.plus(plan.totals.change);
  const routed = await routeStructural(tx, auth, {
    kind: "import",
    workspaceId,
    versionIds,
    archiveIds: [],
    createdIds,
    holdIds: changed,
    amountReporting: plan.totals.new.plus(plan.changes.reduce((s, c) => s.plus(c.amount.mul(plan.rates.get(c.envelope.currency) ?? 1)), new Decimal(0))).toDecimalPlaces(2),
    deltaAbs: plan.totals.new.plus(plan.totals.change.abs()).toDecimalPlaces(2),
    deltaPct: new Decimal(1),
    rationale,
  });
  await auditMany(tx, createdAudits);
  const leaves = plan.nodes.filter((n: PlannedNode) => n.kind === "leaf").length;
  const summary = { created: leaves, parents: plan.nodes.length - leaves, changed: changed.length, total: total.toFixed(2), ...routed };
  await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "budgets.imported", entityType: "workspace", entityId: workspaceId, after: summary, reason: rationale, requestId: auth.ctx.requestId });
  await outbox(tx, { workspaceId, topic: "budget.changed", payload: { kind: "import", createdIds, changedIds: changed, bulkChangeId: routed.bulkChangeId, requestId: routed.requestId } });
  await bumpDataVersion(tx, workspaceId);
  return { ...summary, createdIds, changedIds: changed };
}
