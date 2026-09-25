import { z } from "zod";

const DimensionKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const ValueCode = z.string().regex(/^[A-Za-z0-9_]{1,80}$/);

export const DimensionDataType = z.enum(["ENUM", "TEXT", "REFERENCE", "DATE_BUCKET"]);

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
