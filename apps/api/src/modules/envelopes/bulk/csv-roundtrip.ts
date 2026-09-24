import { BULK_MAX_ROWS, CsvExportInput, CsvImportInput, DomainError, MoneyString, QueryRequest, canInScope, type CsvImportReport } from "@budget/domain";
import { envelopePaths, loadBulkHeads, withTenant } from "@budget/db";
import { compileQuery, pageOf } from "@budget/query-planner";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { envelopeScopeTargets } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { parseCsv, toCsv } from "./csv.js";
import { buildPreview } from "./preview.js";
import type { PreviewStore } from "./preview-store.js";

/** Columns the round trip writes. Import only needs `envelope_id` and `amount`; the rest is context. */
export const CSV_HEADER = ["envelope_id", "path", "currency", "approved_amount", "amount"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIDE = { start: "0001-01-01", end: "9999-12-31" };

/** POST /workspaces/:ws/envelopes/csv-export: the selection with its head amounts, ready to edit in a spreadsheet. */
export async function exportCsv(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<string> {
  const input = parseInput(CsvExportInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      let ids: string[];
      if ("envelopeIds" in input.selection) ids = [...new Set(input.selection.envelopeIds)];
      else {
        ids = [];
        let cursor: string | null = null;
        do {
          const q = QueryRequest.parse({ workspaceId, filter: input.selection.filter, period: { kind: "range", ...WIDE }, measures: ["budget"], limit: 1000, ...(cursor ? { cursor } : {}) });
          const c = compileQuery(q, WIDE, new Date().toISOString().slice(0, 10));
          const page = pageOf(c, await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values), q.limit);
          ids.push(...page.rows.map((r) => String(r["envelope_id"])));
          if (ids.length > BULK_MAX_ROWS) throw new DomainError("VALIDATION", "Use the export job for >10k rows");
          cursor = page.nextCursor;
        } while (cursor);
      }
      const heads = await loadBulkHeads(tx, ids);
      const scopes = await envelopeScopeTargets(tx, heads.map((h) => h.id));
      const visible = auth.isOrgAdmin ? heads : heads.filter((h) => canInScope(auth.assignments, "envelope.read", scopes.get(h.id) ?? { dims: {} }));
      const approved = new Map(
        (await tx.envelopeVersion.findMany({ where: { id: { in: visible.map((h) => h.currentVersionId).filter((x): x is string => x !== null) } }, select: { id: true, amount: true } })).map((v) => [v.id, v.amount.toFixed(2)]),
      );
      const paths = await envelopePaths(tx, visible.map((h) => h.id));
      const rows = visible
        .map((h) => [h.id, (paths.get(h.id) ?? [h.name]).join(" / "), h.currency, h.currentVersionId ? (approved.get(h.currentVersionId) ?? "") : "", h.headAmount ?? ""])
        .sort((a, b) => (a[1] as string).localeCompare(b[1] as string));
      return toCsv(CSV_HEADER, rows);
    },
    { timeoutMs: 60_000 },
  );
}

/**
 * POST /workspaces/:ws/envelopes/csv-import (plan §9.3 round trip). Columns are mapped by header
 * (case-insensitive; `envelope_id` and `amount` required). Bad lines are reported, never guessed;
 * the valid rows become a `paste` preview that commits like any bulk edit.
 */
export async function importCsv(prisma: PrismaClient, auth: AuthContext, raw: unknown, store: PreviewStore): Promise<CsvImportReport> {
  const input = parseInput(CsvImportInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const table = parseCsv(input.csv);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const idCol = header.indexOf("envelope_id");
  const amountCol = header.indexOf("amount");
  if (idCol === -1 || amountCol === -1) throw new DomainError("VALIDATION", "CSV needs envelope_id and amount columns", { header });
  const errors: CsvImportReport["errors"] = [];
  const rows: Array<{ envelopeId: string; amount: string }> = [];
  const seen = new Map<string, number>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const id = (cells[idCol] ?? "").trim();
    const amount = (cells[amountCol] ?? "").trim().replace(/[\s,](?=\d{3}(\D|$))/g, "");
    if (!UUID.test(id)) return errors.push({ line, message: `envelope_id "${id}" is not a uuid` });
    if (!MoneyString.safeParse(amount).success) return errors.push({ line, message: `amount "${cells[amountCol] ?? ""}" is not a number with at most 2 decimals` });
    const dup = seen.get(id);
    if (dup !== undefined) return errors.push({ line, message: `envelope ${id} already on line ${dup}` });
    seen.set(id, line);
    rows.push({ envelopeId: id, amount });
    return undefined;
  });
  if (rows.length > BULK_MAX_ROWS) throw new DomainError("VALIDATION", "Use CSV import jobs for >10k rows", { max: BULK_MAX_ROWS });
  // Unknown ids are line errors too, not a failed import.
  const known = new Set((await withTenant(prisma, auth.ctx, (tx) => loadBulkHeads(tx, rows.map((r) => r.envelopeId)))).map((h) => h.id));
  const valid = rows.filter((r) => {
    if (known.has(r.envelopeId)) return true;
    errors.push({ line: seen.get(r.envelopeId) ?? 0, message: `envelope ${r.envelopeId} not found` });
    return false;
  });
  errors.sort((a, b) => a.line - b.line);
  const preview =
    valid.length === 0
      ? null
      : await buildPreview(
          prisma,
          auth,
          { workspaceId, selection: { envelopeIds: valid.map((r) => r.envelopeId) }, operation: { op: "paste", rows: valid }, rationale: input.rationale },
          store,
        );
  return { rowsRead: table.length - 1, errors, preview };
}
