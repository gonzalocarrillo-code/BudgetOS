import { z } from "zod";
import { RematchResult } from "./matching.js";
import { DictionaryEntrySource, DictionaryKind } from "./naming-dictionaries.js";

export { builtinDictionaryRows, DictionaryEntrySource, SEEDABLE_KINDS } from "./naming-dictionaries.js";
export type { BuiltinRow, DictionaryRows } from "./naming-dictionaries.js";
export { parseNamingDate } from "./matching.js";

/**
 * EX-7 (ADR-0093): campaign-naming dictionaries are data — per workspace and granularity, visible
 * and editable in Registry › Campaign names › Dictionaries. An entry: the code as written in names
 * (matched case-, accent- and punctuation-insensitively) → the registry value it means (created on
 * demand), its meaning, notes, and where it came from. The built-in lists of naming-dictionaries.ts
 * are the seed, copied once per granularity; bulk paste, CSV and AI fill write entries too.
 */

const Text = (max: number) => z.string().trim().min(1).max(max);

/** One entry as typed, pasted, imported or accepted from AI. `value` defaults to the code. */
export const DictionaryEntryInput = z
  .object({
    code: Text(200),
    meaning: Text(200),
    value: Text(200).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();
export type DictionaryEntryInput = z.infer<typeof DictionaryEntryInput>;

/** PATCH an entry: any of its fields. */
export const UpdateDictionaryEntryInput = z
  .object({ code: Text(200).optional(), meaning: Text(200).optional(), value: Text(200).optional(), notes: z.string().trim().max(1000).nullable().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Change at least one field" });
export type UpdateDictionaryEntryInput = z.infer<typeof UpdateDictionaryEntryInput>;

/** At most this many entries per bulk write (paste, CSV import, accepted AI rows). */
export const MAX_BULK_ENTRIES = 5000;

/** POST …/bulk: paste, CSV import or accepted AI proposals (source `ai`). An existing code is replaced, or kept with `onConflict: skip`. */
export const BulkDictionaryInput = z
  .object({
    entries: z.array(DictionaryEntryInput).min(1).max(MAX_BULK_ENTRIES),
    source: z.enum(["user", "ai"]).default("user"),
    onConflict: z.enum(["replace", "skip"]).default("replace"),
  })
  .strict();
export type BulkDictionaryInput = z.infer<typeof BulkDictionaryInput>;

export const DictionaryEntryView = z.object({
  /** Null for an EX-6 alias not yet copied into the dictionary (read-only until the next write). */
  id: z.string().uuid().nullable(),
  code: z.string(),
  meaning: z.string(),
  value: z.string(),
  notes: z.string().nullable(),
  source: DictionaryEntrySource,
  /** EX-8: the external source a `sync` entry comes from. */
  syncSourceId: z.string().uuid().nullable(),
  /** An EX-6 alias of the convention, still read; copied into the dictionary on the next write. */
  legacy: z.boolean(),
  createdAt: z.string().nullable(),
});
export type DictionaryEntryView = z.infer<typeof DictionaryEntryView>;

/** GET /workspaces/:ws/naming-dictionaries/:dimension?q&limit. */
export const DictionaryQuery = z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(MAX_BULK_ENTRIES).optional() }).strict();
export type DictionaryQuery = z.infer<typeof DictionaryQuery>;

export const NamingDictionaryView = z.object({
  dimension: z.string(),
  label: z.string(),
  /** The built-in dictionary of the granularity's kind; null: none (a client code list starts empty). */
  kind: DictionaryKind.nullable(),
  /** The built-in entries were copied in (editable since). Until then the built-in dictionary is read as is. */
  seeded: z.boolean(),
  /** How many entries the built-in seed has (null: none, or a pattern such as quarter / year). */
  builtinCount: z.number().int().nullable(),
  /** EX-8: the external source the whole dictionary is linked to. */
  syncSourceId: z.string().uuid().nullable(),
  /** The 1-based position of the convention that reads this granularity, if any. */
  position: z.number().int().nullable(),
  /** Live entries matching `q` (before `limit`). */
  total: z.number().int(),
  entries: z.array(DictionaryEntryView),
});
export type NamingDictionaryView = z.infer<typeof NamingDictionaryView>;

/** GET /workspaces/:ws/naming-dictionaries: one line per granularity. */
export const NamingDictionariesResponse = z.object({
  dictionaries: z.array(NamingDictionaryView.omit({ entries: true, total: true }).extend({ entries: z.number().int() })),
  aiAvailable: z.boolean(),
});
export type NamingDictionariesResponse = z.infer<typeof NamingDictionariesResponse>;

/** Every dictionary write: what it did, the registry values it created, and the re-match (null when no convention reads the granularity). */
export const DictionaryWriteResponse = z.object({
  dimension: z.string(),
  written: z.number().int(),
  skipped: z.number().int(),
  removed: z.number().int(),
  createdValues: z.array(z.object({ dimension: z.string(), code: z.string(), label: z.string() })),
  rematch: RematchResult.nullable(),
});
export type DictionaryWriteResponse = z.infer<typeof DictionaryWriteResponse>;

// ---- AI fill -----------------------------------------------------------------------------------

/** At most this many unresolved codes, example names and registry values go to the model. */
export const MAX_AI_CODES = 200;
export const MAX_AI_EXAMPLES = 10;
export const MAX_AI_VALUES = 200;

/** POST …/ai-fill: the position's unresolved codes (from the saved convention), or the codes given. */
export const FillDictionaryAiInput = z
  .object({ position: z.number().int().min(1).max(20).optional(), codes: z.array(Text(200)).min(1).max(MAX_AI_CODES).optional() })
  .strict()
  .refine((v) => v.position !== undefined || v.codes !== undefined, { message: "Give a position or codes" });
export type FillDictionaryAiInput = z.infer<typeof FillDictionaryAiInput>;

/** The model's answer (validated before anyone sees it). `value`: an existing registry value code, or null. */
export const DictionaryAiAnswer = z
  .object({
    entries: z
      .array(z.object({ code: z.string().min(1).max(200), meaning: z.string().min(1).max(200), value: z.string().min(1).max(200).nullable().optional(), confidence: z.number().min(0).max(1) }).strict())
      .max(MAX_AI_CODES),
  })
  .strict();
export type DictionaryAiAnswer = z.infer<typeof DictionaryAiAnswer>;

export const DictionaryAiProposal = z.object({
  code: z.string(),
  meaning: z.string(),
  /** An existing registry value it maps to; null: the code becomes its own value. */
  value: z.string().nullable(),
  confidence: z.number(),
});
export type DictionaryAiProposal = z.infer<typeof DictionaryAiProposal>;

export const FillDictionaryAiResponse = z.object({
  dimension: z.string(),
  proposals: z.array(DictionaryAiProposal),
  model: z.string(),
  /** How many codes and example names were sent (no amounts, no ids). */
  codes: z.number().int(),
  examples: z.number().int(),
  applied: z.literal(false),
});
export type FillDictionaryAiResponse = z.infer<typeof FillDictionaryAiResponse>;

// ---- paste and CSV -----------------------------------------------------------------------------

export interface ParsedEntries {
  entries: DictionaryEntryInput[];
  /** 1-based line numbers that could not be read. */
  errors: number[];
}

const entryOf = (code: string | undefined, meaning: string | undefined, value?: string, notes?: string): DictionaryEntryInput | null => {
  const c = (code ?? "").trim();
  const m = (meaning ?? "").trim();
  if (c === "" || m === "" || c.length > 200 || m.length > 200) return null;
  const v = (value ?? "").trim();
  const n = (notes ?? "").trim();
  return { code: c, meaning: m, ...(v !== "" ? { value: v.slice(0, 200) } : {}), ...(n !== "" ? { notes: n.slice(0, 1000) } : {}) };
};

/** Bulk paste: `code<TAB>meaning[<TAB>value]` per line (a spreadsheet's two or three columns). Blank lines are skipped. */
export function parseDictionaryPaste(text: string): ParsedEntries {
  const out: ParsedEntries = { entries: [], errors: [] };
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    const [code, meaning, value] = line.split("\t");
    const e = entryOf(code, meaning, value);
    if (e) out.entries.push(e);
    else out.errors.push(i + 1);
  });
  return out;
}

const CSV_HEADER = ["code", "meaning", "value", "notes", "source"] as const;
const cell = (s: string): string => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Export: `code,meaning,value,notes,source`, RFC 4180 quoting. */
export function dictionaryToCsv(entries: ReadonlyArray<{ code: string; meaning: string; value: string; notes: string | null; source: string }>): string {
  return [CSV_HEADER.join(","), ...entries.map((e) => [e.code, e.meaning, e.value, e.notes ?? "", e.source].map(cell).join(","))].join("\n") + "\n";
}

/** RFC 4180 rows (quoted fields, doubled quotes, newlines inside quotes). */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Import: a header row naming at least `code` and `meaning` (any order; `value`, `notes` optional; `source` ignored). */
export function parseDictionaryCsv(text: string): ParsedEntries {
  const rows = csvRows(text.replace(/^\uFEFF/, ""));
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const at = (name: string) => header.indexOf(name);
  const out: ParsedEntries = { entries: [], errors: [] };
  if (at("code") < 0 || at("meaning") < 0) return { entries: [], errors: [1] };
  rows.slice(1).forEach((r, i) => {
    if (r.every((c) => c.trim() === "")) return;
    const get = (name: string) => (at(name) >= 0 ? r[at(name)] : undefined);
    const e = entryOf(get("code"), get("meaning"), get("value"), get("notes"));
    if (e) out.entries.push(e);
    else out.errors.push(i + 2);
  });
  return out;
}
