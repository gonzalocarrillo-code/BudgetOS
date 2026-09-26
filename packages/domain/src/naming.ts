import { z } from "zod";

/**
 * Naming templates and match keys (spec §24, plan §4.10). A template is chips: dimensions,
 * separators, free text, the envelope's period. `display` renders labels (what the grid, search and
 * Slack show); `match_key` renders codes (what a source's name column is compared with). The
 * dimension tuple stays the identity either way.
 */

export const NamingKind = z.enum(["display", "match_key"]);
export type NamingKind = z.infer<typeof NamingKind>;

export const PeriodFormat = z.enum(["yyyy", "yyyy-QQ", "yyyy-MM", "MMM yyyy", "fiscal"]);
export type PeriodFormat = z.infer<typeof PeriodFormat>;

export const NamingChip = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dimension"), key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/) }),
  z.object({ type: z.literal("separator"), value: z.enum(["_", "-", ":", "·", " ", "/", "|"]) }),
  z.object({ type: z.literal("text"), value: z.string().min(1).max(40) }),
  z.object({ type: z.literal("period"), format: PeriodFormat }),
]);
export type NamingChip = z.infer<typeof NamingChip>;

const templateFields = {
  kind: NamingKind,
  chips: z.array(NamingChip).min(1).max(30),
  casing: z.enum(["original", "lower", "upper"]).default("original"),
  whitespace: z.enum(["keep", "underscore", "dash", "remove"]).default("keep"),
  stripAccents: z.boolean().default(false),
};

/** POST /workspaces/:ws/naming-templates: the new active template of its kind (the previous one is retired). */
export const CreateNamingTemplateInput = z.object(templateFields);
export type CreateNamingTemplateInput = z.infer<typeof CreateNamingTemplateInput>;

/** PATCH /naming-templates/:id: a new version of the template (the kind never changes). */
export const UpdateNamingTemplateInput = z
  .object({ chips: templateFields.chips.optional(), casing: templateFields.casing.optional(), whitespace: templateFields.whitespace.optional(), stripAccents: z.boolean().optional(), isActive: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type UpdateNamingTemplateInput = z.infer<typeof UpdateNamingTemplateInput>;

/** POST /naming-templates/preview: a template (saved or not) over sample envelopes (five when none are given). */
export const NamingPreviewInput = z.object({ template: z.object(templateFields), sampleEnvelopeIds: z.array(z.string().uuid()).max(20).default([]) });
export type NamingPreviewInput = z.infer<typeof NamingPreviewInput>;

export interface NamingTemplateT {
  kind: NamingKind;
  chips: NamingChip[];
  casing: "original" | "lower" | "upper";
  whitespace: "keep" | "underscore" | "dash" | "remove";
  stripAccents: boolean;
}

export interface NamingContext {
  dims: Record<string, { code: string; label: string }>;
  period?: { start: string; end: string; fiscalLabel: string } | undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An envelope's period in a chip's format; its start date decides (a budget belongs to where it starts). */
export function formatPeriod(period: NamingContext["period"], format: PeriodFormat): string {
  if (!period) return "";
  const [y = "", m = "01"] = period.start.split("-");
  const month = Number(m);
  switch (format) {
    case "yyyy":
      return y;
    case "yyyy-QQ":
      return `${y}-Q${Math.ceil(month / 3)}`;
    case "yyyy-MM":
      return `${y}-${m}`;
    case "MMM yyyy":
      return `${MONTHS[month - 1] ?? ""} ${y}`;
    case "fiscal":
      return period.fiscalLabel;
  }
}

/** Spec §24.2. */
export function renderTemplate(t: NamingTemplateT, ctx: NamingContext): string {
  const parts = t.chips.map((ch) =>
    ch.type === "dimension" ? ((t.kind === "display" ? ctx.dims[ch.key]?.label : ctx.dims[ch.key]?.code) ?? "") : ch.type === "separator" || ch.type === "text" ? ch.value : formatPeriod(ctx.period, ch.format),
  );
  let out = parts.join("");
  if (t.stripAccents) out = out.normalize("NFD").replace(/\p{M}/gu, "");
  out = t.casing === "lower" ? out.toLowerCase() : t.casing === "upper" ? out.toUpperCase() : out;
  out = t.whitespace === "underscore" ? out.replace(/\s+/g, "_") : t.whitespace === "dash" ? out.replace(/\s+/g, "-") : t.whitespace === "remove" ? out.replace(/\s+/g, "") : out;
  return out;
}

/**
 * A source's parse pattern: a regex with named groups, each a dimension key, e.g.
 * `^(?<country>[A-Z]{2})_(?<platform>[a-z_]+)`. Null when it is not a valid regex with at least one group.
 */
export function compileParsePattern(pattern: string): RegExp | null {
  try {
    const re = new RegExp(pattern, "u");
    return /\(\?<[a-z][a-z0-9_]*>/.test(pattern) ? re : null;
  } catch {
    return null;
  }
}
export const ParsePattern = z.string().min(3).max(500).refine((p) => compileParsePattern(p) !== null, "A regex with at least one named group, e.g. (?<country>[A-Z]{2})_(?<platform>\\w+)");
