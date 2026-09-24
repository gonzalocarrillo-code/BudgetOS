import { BULK_MAX_ROWS, BulkRequest, DomainError, QueryRequest, canInScope, newId, type BulkPreview } from "@budget/domain";
import { actualsByEnvelope, envelopePaths, loadBulkHeads, previousPeriodAmounts, withTenant, type BulkHeadRow, type Tx } from "@budget/db";
import { compileQuery, pageOf } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { envelopeScopeTargets } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { matchPolicy, type DiffFacts } from "../../approvals/policy-matcher.js";
import { resolveFx } from "../commands/version-writer.js";
import { allocate, type AllocContext } from "./allocate.js";
import { capViolations } from "./caps.js";
import { PREVIEW_TTL_SECONDS, type PreviewStore } from "./preview-store.js";

/** What commit needs from a preview; stored as JSON under `bulk:<previewId>`. */
export interface StoredPreview {
  previewId: string;
  workspaceId: string;
  createdBy: string;
  rationale: string;
  op: string;
  rows: Array<{ envelopeId: string; headVersionId: string | null; before: string | null; after: string; currency: string }>;
  expiresAt: string;
}

const WIDE = { start: "0001-01-01", end: "9999-12-31" };

/** A filter selection becomes envelope ids through the planner (same FilterGroup semantics as the grid). */
async function idsForFilter(tx: Tx, workspaceId: string, filter: BulkRequest["selection"] & { filter: unknown }): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const q = QueryRequest.parse({ workspaceId, filter: filter.filter, period: { kind: "range", ...WIDE }, measures: ["budget"], limit: 1000, ...(cursor ? { cursor } : {}) });
    const c = compileQuery(q, WIDE, new Date().toISOString().slice(0, 10));
    const page = pageOf(c, await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values), q.limit);
    ids.push(...page.rows.map((r) => String(r["envelope_id"])));
    if (ids.length > BULK_MAX_ROWS) throw new DomainError("VALIDATION", "Use CSV import for >10k rows", { max: BULK_MAX_ROWS });
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

function assertAllInScope(auth: AuthContext, ids: string[], targets: Awaited<ReturnType<typeof envelopeScopeTargets>>): void {
  if (auth.isOrgAdmin) return;
  const outside = ids.filter((id) => {
    const t = targets.get(id);
    return t === undefined || !canInScope(auth.assignments, "envelope.bulk", t);
  });
  if (outside.length) throw new DomainError("FORBIDDEN", "Some envelopes are outside your scope", { outside: outside.slice(0, 50), count: outside.length });
}

export async function buildPreview(prisma: PrismaClient, auth: AuthContext, raw: unknown, store: PreviewStore): Promise<BulkPreview> {
  const req = parseInput(BulkRequest, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  if (req.workspaceId !== workspaceId) throw new DomainError("VALIDATION", "workspaceId does not match the request workspace");
  const op = req.operation;

  const preview = await withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      let ids: string[];
      if (op.op === "paste") {
        ids = op.rows.map((r) => r.envelopeId);
        if ("filter" in req.selection) throw new DomainError("VALIDATION", "Paste targets explicit envelopes; use selection.envelopeIds");
        const allowed = new Set(req.selection.envelopeIds);
        const extra = ids.filter((id) => !allowed.has(id));
        if (extra.length) throw new DomainError("VALIDATION", "Pasted rows outside the selection", { extra: extra.slice(0, 50) });
      } else {
        ids = "envelopeIds" in req.selection ? [...new Set(req.selection.envelopeIds)] : await idsForFilter(tx, workspaceId, req.selection as never);
      }
      if (ids.length > BULK_MAX_ROWS) throw new DomainError("VALIDATION", "Use CSV import for >10k rows", { max: BULK_MAX_ROWS });
      if (ids.length === 0) throw new DomainError("VALIDATION", "The selection is empty");

      const heads = await loadBulkHeads(tx, ids);
      const byId = new Map(heads.map((h) => [h.id, h]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) throw new DomainError("NOT_FOUND", "Some envelopes were not found", { missing: missing.slice(0, 50), count: missing.length });
      assertAllInScope(auth, ids, await envelopeScopeTargets(tx, ids));

      const skipped: BulkPreview["skipped"] = [];
      const editable: BulkHeadRow[] = [];
      for (const h of heads) {
        if (h.status === "LOCKED") skipped.push({ envelopeId: h.id, reason: "period closed" });
        else if (h.status === "ARCHIVED") skipped.push({ envelopeId: h.id, reason: "archived" });
        else if (h.headStatus === "PENDING") skipped.push({ envelopeId: h.id, reason: "a version is awaiting approval" });
        else editable.push(h);
      }

      const ctx: AllocContext = {};
      if (op.op === "redistribute") {
        const notChildren = editable.filter((h) => h.parentId !== op.parentId).map((h) => h.id);
        if (notChildren.length) throw new DomainError("VALIDATION", "redistribute works on children of parentId", { notChildren: notChildren.slice(0, 50) });
        const [parent] = await loadBulkHeads(tx, [op.parentId]);
        if (!parent) throw new DomainError("NOT_FOUND", "Parent not found");
        const approved = parent.currentVersionId ? await tx.envelopeVersion.findUnique({ where: { id: parent.currentVersionId }, select: { amount: true } }) : null;
        ctx.parentAmount = approved ? new Decimal(approved.amount.toString()) : null;
        ctx.parentCurrency = parent.currency;
        if (op.method === "by_last_actuals") {
          ctx.actuals = new Map([...(await actualsByEnvelope(tx, editable.map((h) => h.id)))].map(([k, v]) => [k, new Decimal(v)]));
        }
      }
      if (op.op === "copy_previous_period") {
        const prev = await previousPeriodAmounts(tx, editable.map((h) => h.id));
        ctx.previous = new Map([...prev].map(([k, v]) => [k, { amount: v.amount === null ? null : new Decimal(v.amount), currency: v.currency }]));
      }

      const { after, skipped: opSkipped } = allocate(
        editable.map((h) => ({ envelopeId: h.id, currency: h.currency, before: h.headAmount === null ? null : new Decimal(h.headAmount) })),
        op,
        ctx,
      );
      skipped.push(...opSkipped);

      const changed = editable.filter((h) => {
        const a = after.get(h.id);
        if (a === undefined) return false;
        if (h.headAmount !== null && a.equals(h.headAmount)) {
          skipped.push({ envelopeId: h.id, reason: "unchanged" });
          return false;
        }
        return true;
      });

      // Reporting-currency amounts for caps and policy (one FX lookup per currency).
      const rates = new Map<string, Decimal>();
      for (const c of new Set(changed.map((h) => h.currency))) rates.set(c, (await resolveFx(tx, c, workspaceId)).rate);
      const rep = (h: BulkHeadRow, amount: Decimal) => amount.mul(rates.get(h.currency) ?? 1).toDecimalPlaces(2);
      const afterRep = new Map(changed.map((h) => [h.id, rep(h, after.get(h.id) as Decimal)]));

      const violations: BulkPreview["capViolations"] = await capViolations(tx, changed, afterRep);

      const beforeRep = changed.reduce((s, h) => s.plus(rep(h, new Decimal(h.headAmount ?? 0))), new Decimal(0));
      const afterRepTotal = [...afterRep.values()].reduce((s, v) => s.plus(v), new Decimal(0));
      const facts: DiffFacts = {
        entityType: "bulk_change",
        amountAbs: afterRepTotal,
        deltaAbs: afterRepTotal.minus(beforeRep),
        deltaPct: beforeRep.isZero() ? new Decimal(1) : afterRepTotal.minus(beforeRep).div(beforeRep),
        isOverAllocation: violations.length > 0,
        level: 0,
        dimensionValues: {},
        daysRemaining: 0,
      };
      const policy = changed.length ? await matchPolicy(tx, workspaceId, facts) : null;
      const paths = await envelopePaths(tx, changed.map((h) => h.id));
      const previewId = newId();
      const expiresAt = new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString();
      const rows = changed.map((h) => {
        const a = after.get(h.id) as Decimal;
        return { envelopeId: h.id, path: paths.get(h.id) ?? [h.name], before: h.headAmount === null ? null : new Decimal(h.headAmount).toFixed(2), after: a.toFixed(2), delta: a.minus(h.headAmount ?? 0).toFixed(2) };
      });
      const stored: StoredPreview = {
        previewId,
        workspaceId,
        createdBy: auth.user.id,
        rationale: req.rationale,
        op: op.op,
        rows: changed.map((h) => ({ envelopeId: h.id, headVersionId: h.headVersionId, before: h.headAmount, after: (after.get(h.id) as Decimal).toFixed(2), currency: h.currency })),
        expiresAt,
      };
      return {
        stored,
        preview: {
          previewId,
          rows,
          // Totals in the workspace reporting currency, so a mixed-currency selection still adds up.
          totalsBefore: beforeRep.toFixed(2),
          totalsAfter: afterRepTotal.toFixed(2),
          capViolations: violations,
          policyPreview: policy ? { name: policy.name, chain: policy.chain.map((s) => s.role) } : null,
          skipped,
          expiresAt,
        } satisfies BulkPreview,
      };
    },
    { timeoutMs: 60_000 },
  );
  if (preview.stored.rows.length) await store.put(preview.stored.previewId, JSON.stringify(preview.stored), PREVIEW_TTL_SECONDS);
  return preview.preview;
}
