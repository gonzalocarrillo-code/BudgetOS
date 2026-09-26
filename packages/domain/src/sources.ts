import { z } from "zod";

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
    if (!Object.values(m.columns).some((c) => "dimension" in c)) issue("Map at least one dimension column");
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
      account: z.string().min(1),
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
      projectId: z.string().min(1),
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
  schedule: Cron.optional(),
});
export type CreateSourceInput = z.infer<typeof CreateSourceInput>;

/** PATCH /sources/:id. The kind never changes; a new kind is a new source. */
export const UpdateSourceInput = z
  .object({
    name: z.string().min(1).max(200).optional(),
    config: SourceConfig.optional(),
    mapping: SourceMapping.optional(),
    schedule: Cron.nullable().optional(),
    isActive: z.boolean().optional(),
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
