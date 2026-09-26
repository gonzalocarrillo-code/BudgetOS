import { SourceMapping, type ColumnMapping } from "@budget/domain";

/**
 * The mapping wizard's helpers (T-032): read a CSV's header and first rows in the browser (the
 * user's own file; nothing is summed here), guess each column's role by its name and values when
 * no AI suggestion is available, and check a mapping with the domain's own SourceMapping schema.
 */

export interface Sample {
  header: string[];
  rows: string[][];
}

/** RFC 4180 enough for a sample: quoted fields, doubled quotes, CRLF. Stops after `maxRows` data rows. */
export function parseCsvSample(text: string, maxRows = 20): Sample {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  const endRecord = () => {
    record.push(field);
    field = "";
    if (record.some((f) => f !== "")) records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length && records.length <= maxRows; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n") endRecord();
    else if (c !== "\r") field += c;
  }
  if (field !== "" || record.length) endRecord();
  const [header = [], ...rows] = records;
  return { header: header.map((h) => h.trim()), rows: rows.slice(0, maxRows) };
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "") || "metric";

/** The date format the sample's values follow (dd/MM vs MM/dd decided by a part above 12). */
export function guessDateFormat(values: string[]): "yyyy-MM-dd" | "yyyy-MM" | "dd/MM/yyyy" | "MM/dd/yyyy" {
  const v = values.filter(Boolean);
  if (v.length && v.every((x) => /^\d{4}-\d{2}$/.test(x))) return "yyyy-MM";
  if (v.length && v.every((x) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(x))) return v.some((x) => Number(x.split("/")[1]) > 12) ? "MM/dd/yyyy" : "dd/MM/yyyy";
  return "yyyy-MM-dd";
}

/** A first mapping by column name and values: dates, spend, currency, KPIs, and the registry's dimensions. */
export function guessMapping(sample: Sample, dimensions: Array<{ key: string; label: string }>): { kind: "spend" | "kpi" | "spend+kpi"; columns: Record<string, ColumnMapping> } {
  const columns: Record<string, ColumnMapping> = {};
  const values = (i: number) => sample.rows.map((r) => r[i] ?? "");
  let hasDate = false;
  let amount = false;
  let currency = false;
  let kpi = false;
  sample.header.forEach((name, i) => {
    const n = norm(name);
    const dim = dimensions.find((d) => norm(d.key) === n || norm(d.label) === n);
    if (dim) {
      columns[name] = { dimension: dim.key };
    } else if (!hasDate && /(date|day|period|month|fecha)/.test(n)) {
      columns[name] = { role: "period_date", format: guessDateFormat(values(i)) };
      hasDate = true;
    } else if (!currency && /^(currency|curr|ccy|moneda)$/.test(n)) {
      columns[name] = { role: "currency" };
      currency = true;
    } else if (!amount && /(spend|cost|amount|gasto|invest)/.test(n)) {
      columns[name] = { role: "amount" };
      amount = true;
    } else if (/(impression|click|conversion|lead|purchase|install|signup|order|revenue|visit)/.test(n)) {
      columns[name] = { role: "kpi", metric: slug(name) };
      kpi = true;
    } else {
      columns[name] = { role: "ignore" };
    }
  });
  return { kind: amount && kpi ? "spend+kpi" : kpi ? "kpi" : "spend", columns };
}

/** Why the mapping cannot be saved (the domain schema's messages), or an empty list. */
export function mappingProblems(mapping: { kind: string; columns: Record<string, ColumnMapping> }): string[] {
  const r = SourceMapping.safeParse(mapping);
  return r.success ? [] : [...new Set(r.error.issues.map((i) => i.message))];
}
