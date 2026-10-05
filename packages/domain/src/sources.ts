import { z } from "zod";
import { ParsePattern } from "./naming.js";

/** Data sources and column mapping (spec §14). Every connector maps raw columns to dimensions and roles. */

const FactMetric = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "lower_snake_case metric");
const Currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code");

export const DimensionColumn = z
  .object({
    dimension: z.string().min(1),
    transform: z.enum(["lower", "upper", "trim"]).optional(),
    /** Raw value → registry code, applied after the transform. */
    valueMap: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();
export type DimensionColumn = z.infer<typeof DimensionColumn>;

export const RoleColumn = z.discriminatedUnion("role", [
  z.object({ role: z.literal("period_date"), format: z.enum(["yyyy-MM-dd", "yyyy-MM", "dd/MM/yyyy", "MM/dd/yyyy"]).default("yyyy-MM-dd") }).strict(),
  /** Spend. The currency comes from here, or from a `currency` column. */
  z.object({ role: z.literal("amount"), currency: Currency.optional() }).strict(),
  z.object({ role: z.literal("currency") }).strict(),
  z.object({ role: z.literal("kpi"), metric: FactMetric, attributionModel: z.string().max(40).optional() }).strict(),
  z.object({ role: z.literal("projection"), metric: FactMetric.default("spend") }).strict(),
  z.object({ role: z.literal("formula_version") }).strict(),
  z.object({ role: z.literal("horizon_end") }).strict(),
  /** T-036 (§24.3): compared with envelope.match_key, or parsed with the source's parse_pattern. */
  z.object({ role: z.literal("match_key") }).strict(),
  z.object({ role: z.literal("ignore") }).strict(),
]);

export const ColumnMapping = z.union([DimensionColumn, RoleColumn]);
export type ColumnMapping = z.infer<typeof ColumnMapping>;

export const SourceKind = z.enum(["spend", "kpi", "spend+kpi", "projection"]);

export const SourceMapping = z
  .object({ columns: z.record(z.string().min(1), ColumnMapping), kind: SourceKind })
  .superRefine((m, ctx) => {
    const roles = Object.values(m.columns).flatMap((c) => ("role" in c ? [c] : []));
    const count = (role: string) => roles.filter((r) => r.role === role).length;
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["columns"] });
    if (count("period_date") !== 1) issue("Map exactly one period_date column");
    if (count("match_key") > 1) issue("Map at most one match_key column");
    if (!Object.values(m.columns).some((c) => "dimension" in c) && count("match_key") === 0) issue("Map at least one dimension column, or a match_key column");
    if (m.kind === "spend" || m.kind === "spend+kpi") {
      if (count("amount") !== 1) issue("A spend source maps exactly one amount column");
      const amount = roles.find((r) => r.role === "amount");
      if (amount && amount.role === "amount" && amount.currency === undefined && count("currency") !== 1) issue("The amount needs a currency, inline or from a currency column");
    }
    if ((m.kind === "kpi" || m.kind === "spend+kpi") && count("kpi") === 0) issue("A KPI source maps at least one kpi column");
    if (m.kind === "projection" && (count("projection") !== 1 || count("formula_version") !== 1 || count("horizon_end") !== 1)) {
      issue("A projection source maps one projection, one formula_version and one horizon_end column");
    }
  });
export type SourceMapping = z.infer<typeof SourceMapping>;

const Cron = z.string().regex(/^(\S+\s){4}\S+$/, "five-field cron expression");
const SecretRef = z.string().regex(/^projects\/[^/]+\/secrets\/[^/]+(\/versions\/[^/]+)?$/, "Secret Manager resource name");

/** Non-secret connector config; credentials live in Secret Manager behind `secretRef`. */
export const SourceConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("csv"), uri: z.string().regex(/^gs:\/\/[^/]+\/.+\.csv$/, "gs://bucket/…/file.csv") }).strict(),
  z
    .object({
      kind: z.literal("snowflake"),
      account: z.string().regex(/^[A-Za-z0-9_.-]+$/, "alphanumeric, underscore, period, hyphen"),
      username: z.string().min(1),
      warehouse: z.string().min(1),
      database: z.string().min(1),
      schema: z.string().min(1),
      view: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]*$/, "unquoted identifier"),
      secretRef: SecretRef,
    })
    .strict(),
  z.object({ kind: z.literal("sheets"), spreadsheetId: z.string().min(10), range: z.string().min(1), secretRef: SecretRef.optional() }).strict(),
  z
    .object({
      kind: z.literal("bigquery"),
      projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "lowercase letter, alphanumeric or hyphen, ends with alphanumeric"),
      dataset: z.string().regex(/^[A-Za-z0-9_]+$/),
      table: z.string().regex(/^[A-Za-z0-9_]+$/),
      updatedAtColumn: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
      secretRef: SecretRef.optional(),
    })
    .strict(),
]);
export type SourceConfig = z.infer<typeof SourceConfig>;

/** POST /workspaces/:ws/sources. */
export const CreateSourceInput = z.object({
  name: z.string().min(1).max(200),
  config: SourceConfig,
  mapping: SourceMapping,
  /** D-004: take the mapping from this saved profile (and follow it when it changes). */
  mappingProfileId: z.string().uuid().optional(),
  schedule: Cron.optional(),
  /** T-036: named groups (dimension keys) read from the match_key column. */
  parsePattern: ParsePattern.optional(),
});
export type CreateSourceInput = z.infer<typeof CreateSourceInput>;

/** PATCH /sources/:id. The kind never changes; a new kind is a new source. */
export const UpdateSourceInput = z
  .object({
    name: z.string().min(1).max(200).optional(),
    config: SourceConfig.optional(),
    mapping: SourceMapping.optional(),
    schedule: Cron.nullable().optional(),
    parsePattern: ParsePattern.nullable().optional(),
    isActive: z.boolean().optional(),
    /** D-004: follow a saved profile, or null to keep the mapping as the source's own. */
    mappingProfileId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type UpdateSourceInput = z.infer<typeof UpdateSourceInput>;

/** POST /workspaces/:ws/unmatched-spend/map: assign every unmatched fact with exactly this tuple to an envelope. */
export const MapUnmatchedInput = z.object({
  dimensionValues: z.record(z.string().min(1), z.string().min(1)).refine((d) => Object.keys(d).length > 0, "dimensionValues is empty"),
  envelopeId: z.string().uuid(),
});
export type MapUnmatchedInput = z.infer<typeof MapUnmatchedInput>;

/**
 * POST /workspaces/:ws/mapping-suggestions (T-032 mapping wizard): a file's header and first rows,
 * sent before any source exists, for @budget/ai to suggest a mapping. Nothing is saved.
 */
export const SuggestMappingSampleInput = z.object({
  header: z.array(z.string().min(1).max(200)).min(1).max(200),
  rows: z.array(z.array(z.union([z.string().max(2000), z.number(), z.null()]))).max(20),
});
export type SuggestMappingSampleInput = z.infer<typeof SuggestMappingSampleInput>;

/** POST /uploads: a CSV the user will upload and then point a csv source at. */
export const CreateUploadInput = z.object({
  filename: z.string().regex(/^[\w.\- ]{1,120}\.csv$/i, "a .csv file name"),
});
export type CreateUploadInput = z.infer<typeof CreateUploadInput>;

/** Outbox payload of `ingest.requested`: the ingest worker runs this queued run. */
export const IngestRequested = z.object({ runId: z.string().uuid(), sourceId: z.string().uuid() });
export type IngestRequested = z.infer<typeof IngestRequested>;

// ---------------------------------------------------------------------------------------------
// Mapping profiles, synonyms and the mapping preview (docs/DATA_PLAN.md §2.3, D-004 to D-006)
// ---------------------------------------------------------------------------------------------

/** The guesser's normal form of a header or a word: lower case, no accents, letters and digits only. */
export const normTerm = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");

/** What a column synonym maps a header to: a dimension, or a role without file-specific details. */
export const ColumnSynonymTarget = z.union([
  z.object({ dimension: z.string().min(1) }).strict(),
  z.object({ role: z.enum(["period_date", "amount", "currency", "match_key", "formula_version", "horizon_end", "ignore"]) }).strict(),
  z.object({ role: z.literal("kpi"), metric: FactMetric }).strict(),
  z.object({ role: z.literal("projection"), metric: FactMetric }).strict(),
]);
export type ColumnSynonymTarget = z.infer<typeof ColumnSynonymTarget>;
export const MetricSynonymTarget = z.object({ metric: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/) }).strict();

const col = (terms: string[], target: ColumnSynonymTarget) => terms.map((term) => ({ term: normTerm(term), target }));
/**
 * Built-in column synonyms (D-005): what common exports call their columns. A workspace's own rows
 * (learned or manual) come first; an inactive workspace row switches a built-in one off.
 */
export const DEFAULT_COLUMN_SYNONYMS: ReadonlyArray<{ term: string; target: ColumnSynonymTarget }> = [
  ...col(["spend", "cost", "media cost", "amount spent", "amount", "investment", "gasto", "inversion", "costo", "spend usd"], { role: "amount" }),
  ...col(["date", "day", "fecha", "dia", "reporting date", "period", "month", "mes"], { role: "period_date" }),
  ...col(["currency", "ccy", "currency code", "moneda", "divisa"], { role: "currency" }),
  ...col(["impressions", "impr", "imps", "impresiones"], { role: "kpi", metric: "impressions" }),
  ...col(["clicks", "link clicks", "clics"], { role: "kpi", metric: "clicks" }),
  ...col(["conversions", "conv", "purchases", "results", "conversiones"], { role: "kpi", metric: "conversions" }),
  ...col(["revenue", "conversion value", "purchase value", "sales", "ingresos"], { role: "kpi", metric: "revenue" }),
  ...col(["leads", "lead", "prospectos"], { role: "kpi", metric: "leads" }),
  ...col(["reach", "alcance"], { role: "kpi", metric: "reach" }),
  ...col(["campaign", "campaign name", "campana", "campaña"], { role: "match_key" }),
];

const met = (terms: string[], metric: string) => terms.map((term) => ({ term: normTerm(term), target: { metric } }));
/**
 * Built-in metric synonyms (D-005, §7 glossary): the words clients use for the org's metrics.
 * tCPA is a target CPA, so it means the metric `cpa`.
 */
export const DEFAULT_METRIC_SYNONYMS: ReadonlyArray<{ term: string; target: { metric: string } }> = [
  ...met(["tcpa", "target cpa", "cpa target", "cost per acquisition", "cost per action", "cost per conversion", "cpa"], "cpa"),
  ...met(["troas", "target roas", "roas target", "return on ad spend", "roas"], "roas"),
  ...met(["cost per click", "avg cpc", "cpc"], "cpc"),
  ...met(["cost per mille", "cost per thousand", "cpm"], "cpm"),
  ...met(["click through rate", "ctr"], "ctr"),
  ...met(["cost per lead", "cpl"], "cpl"),
];

export const MappingSynonymView = z.object({
  /** null for a built-in synonym. */
  id: z.string().uuid().nullable(),
  kind: z.enum(["column", "metric"]),
  term: z.string(),
  target: z.union([ColumnSynonymTarget, MetricSynonymTarget]),
  origin: z.enum(["builtin", "learned", "manual"]),
  uses: z.number().int(),
  isActive: z.boolean(),
});
export type MappingSynonymView = z.infer<typeof MappingSynonymView>;
export const MappingSynonymsResponse = z.object({
  columns: z.array(MappingSynonymView),
  metrics: z.array(MappingSynonymView),
  /** Normal-form words that name a ratio metric here (cpa, tcpa, roas…): the guesser leaves those columns out. */
  ratioWords: z.array(z.string()).default([]),
});
export type MappingSynonymsResponse = z.infer<typeof MappingSynonymsResponse>;

/** POST /workspaces/:ws/mapping-synonyms: a word the workspace uses. */
export const CreateMappingSynonymInput = z
  .object({ kind: z.enum(["column", "metric"]), term: z.string().trim().min(1).max(120), target: z.union([MetricSynonymTarget, ColumnSynonymTarget]) })
  .superRefine((v, ctx) => {
    const isMetric = "metric" in v.target && !("role" in v.target);
    if ((v.kind === "metric") !== isMetric) ctx.addIssue({ code: z.ZodIssueCode.custom, message: v.kind === "metric" ? "A metric synonym's target is { metric }" : "A column synonym's target is a dimension or a role", path: ["target"] });
  });
export type CreateMappingSynonymInput = z.infer<typeof CreateMappingSynonymInput>;
/** PATCH /mapping-synonyms/:id: switch one off (or back on); rows are never deleted. */
export const UpdateMappingSynonymInput = z.object({ isActive: z.boolean() });

export const MappingProfileView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: SourceKind,
  mapping: z.object({ kind: SourceKind, columns: z.record(z.string(), ColumnMapping) }),
  parsePattern: z.string().nullable(),
  header: z.array(z.string()),
  sources: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type MappingProfileView = z.infer<typeof MappingProfileView>;
export const MappingProfilesResponse = z.object({ profiles: z.array(MappingProfileView) });

/** POST /workspaces/:ws/mapping-profiles. `header` is the file's columns, for matching the next file. */
export const CreateMappingProfileInput = z.object({
  name: z.string().trim().min(1).max(120),
  mapping: SourceMapping,
  parsePattern: ParsePattern.optional(),
  header: z.array(z.string().min(1).max(200)).min(1).max(200),
});
export type CreateMappingProfileInput = z.infer<typeof CreateMappingProfileInput>;
/** PATCH /mapping-profiles/:id. A mapping change reaches every source that follows the profile. */
export const UpdateMappingProfileInput = z
  .object({ name: z.string().trim().min(1).max(120).optional(), mapping: SourceMapping.optional(), parsePattern: ParsePattern.nullable().optional(), archived: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type UpdateMappingProfileInput = z.infer<typeof UpdateMappingProfileInput>;

/** POST /workspaces/:ws/mapping-profiles/match: the saved profile a file's header fits, if any. */
export const MatchMappingProfileInput = z.object({ header: z.array(z.string().min(1).max(200)).min(1).max(200) });
export const MatchMappingProfileResponse = z.object({ profile: MappingProfileView.nullable(), fit: z.enum(["exact", "covers"]).nullable() });
export type MatchMappingProfileResponse = z.infer<typeof MatchMappingProfileResponse>;

/** POST /workspaces/:ws/mapping-preview: a mapping (complete or not) run over a file's sample. */
export const MappingPreviewInput = z.object({
  mapping: z.object({ kind: SourceKind, columns: z.record(z.string().min(1), ColumnMapping) }),
  header: z.array(z.string().min(1).max(200)).min(1).max(200),
  rows: z.array(z.array(z.union([z.string().max(2000), z.number(), z.null()]))).max(200),
  parsePattern: ParsePattern.optional(),
});
export type MappingPreviewInput = z.infer<typeof MappingPreviewInput>;

export const MappingPreviewColumn = z.object({
  column: z.string(),
  /** What it maps to, in words the wizard shows ("Country", "Spend", "KPI conversions", "left out"). */
  mapsTo: z.string(),
  /** Dimension columns: each distinct sample value, its registry code, or the nearest one when unknown. */
  values: z.array(z.object({ raw: z.string(), code: z.string().nullable(), suggestion: z.string().nullable(), count: z.number().int() })).optional(),
  /** Problems that reject rows. */
  issues: z.array(z.string()),
  /** Things worth knowing that reject nothing (a ratio left out, a KPI no metric reads yet). */
  notes: z.array(z.string()),
});
export const MappingPreviewReport = z.object({
  rowsChecked: z.number().int(),
  rowsRejected: z.number().int(),
  /** Why the mapping cannot be saved as it is (the SourceMapping rules). */
  problems: z.array(z.string()),
  columns: z.array(MappingPreviewColumn),
  /** The first rejected rows, with the ingest pipeline's own reason. */
  rejects: z.array(z.object({ row: z.number().int(), reason: z.string() })),
});
export type MappingPreviewReport = z.infer<typeof MappingPreviewReport>;
