import { z } from "zod";

const DimensionKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const ValueCode = z.string().regex(/^[A-Za-z0-9_]{1,80}$/);

export const DimensionDataType = z.enum(["ENUM", "TEXT", "REFERENCE", "DATE_BUCKET"]);

/**
 * EX-9 (ADR-0094): where a dimension's values come from. `registry`: hand-managed values (add,
 * edit, nest, merge, retire). `facts`: the distinct values found on the workspace's live spend and
 * KPI facts — read-only, never typed by hand (`campaign`).
 */
export const DimensionValuesSource = z.enum(["registry", "facts"]);
export type DimensionValuesSource = z.infer<typeof DimensionValuesSource>;

export const CreateDimensionInput = z.object({
  key: DimensionKey,
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  dataType: DimensionDataType,
  icon: z.string().min(1).max(300),
  color: z.string().max(32).optional(),
  allowedParents: z.array(DimensionKey).default([]),
  isRequiredForLeaf: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  workspaceId: z.string().uuid().nullable(),
  valuesSource: DimensionValuesSource.default("registry"),
});
export type CreateDimensionInput = z.infer<typeof CreateDimensionInput>;

export const UpdateDimensionInput = z.object({
  label: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().min(1).max(300).optional(),
  color: z.string().max(32).nullable().optional(),
  allowedParents: z.array(DimensionKey).optional(),
  isRequiredForLeaf: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateDimensionInput = z.infer<typeof UpdateDimensionInput>;

export const AddValuesInput = z.object({
  values: z
    .array(
      z.object({
        code: ValueCode,
        label: z.string().min(1).max(200),
        parentCode: ValueCode.optional(),
        aliases: z.array(ValueCode).default([]),
        externalIds: z.record(z.string(), z.string()).default({}),
      }),
    )
    .min(1)
    .max(5000),
});
export type AddValuesInput = z.infer<typeof AddValuesInput>;

export const UpdateValueInput = z.object({
  label: z.string().min(1).max(200).optional(),
  /** Move under another value of the same dimension (null: to the top level). The subtree moves with it. */
  parentCode: ValueCode.nullable().optional(),
  aliases: z.array(ValueCode).optional(),
  externalIds: z.record(z.string(), z.string()).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateValueInput = z.infer<typeof UpdateValueInput>;

export const MergeValuesInput = z.object({
  fromCode: ValueCode,
  intoCode: ValueCode,
});
export type MergeValuesInput = z.infer<typeof MergeValuesInput>;

export const SaveHierarchyTemplateInput = z.object({
  name: z.string().min(1).max(200),
  path: z.array(DimensionKey).min(1).max(20),
  isDefault: z.boolean().default(false),
});
export type SaveHierarchyTemplateInput = z.infer<typeof SaveHierarchyTemplateInput>;

/** PATCH /hierarchy-templates/:id: rename, reorder the path, or make it the workspace default (T-031). */
export const UpdateHierarchyTemplateInput = z
  .object({ name: z.string().min(1).max(200).optional(), path: z.array(DimensionKey).min(1).max(20).optional(), isDefault: z.literal(true).optional() })
  .refine((v) => v.name !== undefined || v.path !== undefined || v.isDefault !== undefined, { message: "Nothing to update" });
export type UpdateHierarchyTemplateInput = z.infer<typeof UpdateHierarchyTemplateInput>;

export const UploadAssetInput = z.object({
  contentType: z.literal("image/svg+xml"),
  svg: z.string().min(1),
});
export type UploadAssetInput = z.infer<typeof UploadAssetInput>;

/** GET /workspaces/:ws/dimensions/:key/fact-values (EX-9): one page of a data-derived dimension's values. */
export const FactValuesQuery = z.object({
  /** Case-insensitive substring of the value. */
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  /** ADR-082: demo facts count only while the workspace is pure demo, unless asked for. */
  includeDemo: z.enum(["true", "false"]).optional(),
});
export type FactValuesQuery = z.infer<typeof FactValuesQuery>;

/** One value of a data-derived dimension, as the facts say it: never a registry row. */
export const FactDimensionValue = z.object({
  code: z.string(),
  /** Live spend in the workspace's reporting currency (Decimal string, 2 dp); "0.00" for a KPI-only value. */
  spend: z.string(),
  currency: z.string(),
  /** First and last fact date (YYYY-MM-DD) across spend and KPI facts. */
  firstSeen: z.string(),
  lastSeen: z.string(),
  /** The facts' source systems (sorted). */
  sourceSystems: z.array(z.string()),
});
export type FactDimensionValue = z.infer<typeof FactDimensionValue>;

export const FactValuesResponse = z.object({
  key: z.string(),
  valuesSource: z.literal("facts"),
  items: z.array(FactDimensionValue),
  /** Values matching `q` (all pages). */
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type FactValuesResponse = z.infer<typeof FactValuesResponse>;
