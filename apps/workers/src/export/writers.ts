import ExcelJS from "exceljs";
import type { ExportTable } from "./table.js";

/**
 * File writers for an export table (plan §6.2). CSV is RFC 4180 with a UTF-8 BOM so Excel reads
 * the encoding; text cells that a spreadsheet would run as a formula get a leading apostrophe.
 * XLSX has a frozen, bold header, number formats per column kind, a bold totals row, and a
 * second sheet with what was exported.
 */

export interface ExportMeta {
  workspaceName: string;
  period: { start: string; end: string };
  generatedAt: string;
  dataVersion: number;
  query: unknown;
}

const BOM = "\u{FEFF}";
const FORMULA = /^[=+\-@\t\r]/;
const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(t: ExportTable): Buffer {
  const line = (cells: Array<string | null>, header = false) =>
    cells
      .map((v, i) => {
        if (v === null) return "";
        const kind = t.columns[i]?.kind ?? "text";
        return quote(!header && kind === "text" && FORMULA.test(v) ? `'${v}` : v);
      })
      .join(",");
  const lines = [line(t.columns.map((c) => c.label), true), ...t.rows.map((r) => line(r)), line(t.totals)];
  return Buffer.from(`${BOM}${lines.join("\r\n")}\r\n`, "utf8");
}

const FORMAT = { money: "#,##0.00", ratio: "0.0000", count: "0" } as const;

/** Numbers become spreadsheet numbers only here, at the file boundary (XLSX cells are doubles; ADR-017). */
export async function toXlsx(t: ExportTable, meta: ExportMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Budget OS";
  wb.created = new Date(meta.generatedAt);
  const ws = wb.addWorksheet("Export", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = t.columns.map((c) => ({ header: c.label, key: c.key, width: Math.min(48, Math.max(12, c.label.length + 2)), ...(c.kind === "text" ? {} : { style: { numFmt: FORMAT[c.kind] } }) }));
  ws.getRow(1).font = { bold: true };
  const value = (v: string | null, i: number) => (v === null ? null : t.columns[i]?.kind === "text" ? v : Number(v));
  for (const r of t.rows) ws.addRow(r.map(value));
  const totals = ws.addRow(t.totals.map(value));
  totals.font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: t.columns.length } };

  const about = wb.addWorksheet("About");
  about.columns = [{ width: 18 }, { width: 100 }];
  about.addRows([
    ["Workspace", meta.workspaceName],
    ["Period", `${meta.period.start} – ${meta.period.end}`],
    ["Generated at", meta.generatedAt],
    ["Data version", meta.dataVersion],
    ["Rows", t.rows.length],
    ["Query", JSON.stringify(meta.query)],
  ]);
  about.getColumn(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
