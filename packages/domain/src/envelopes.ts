import { z } from "zod";
import { FilterGroup } from "./filter-ast.js";

/** NUMERIC(18,2): up to 16 integer digits and 2 decimals, as a decimal string (never a JS number). */
export const MoneyString = z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/, "Money is a decimal string with at most 2 decimals");
const IsoDate = z.string().date();
const Currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code");

export const PhasingEntry = z.object({ month: IsoDate, amount: MoneyString });

/** POST /workspaces/:ws/envelopes (spec §17). An optional amount opens the first draft version. */
export const CreateEnvelopeInput = z
  .object({
    name: z.string().min(1).max(200),
    parentId: z.string().uuid().nullable().default(null),
    dimensionValues: z.record(z.string().min(1), z.string().min(1)),
    startDate: IsoDate,
    endDate: IsoDate,
    currency: Currency,
    ownerId: z.string().uuid().nullable().default(null),
    periodId: z.string().uuid().nullable().default(null),
    amount: MoneyString.optional(),
    phasing: z.array(PhasingEntry).optional(),
    rationale: z.string().max(4000).optional(),
  })
  .refine((v) => v.startDate <= v.endDate, { message: "startDate must not be after endDate", path: ["endDate"] })
  .refine((v) => v.phasing === undefined || v.amount !== undefined, { message: "phasing needs an amount", path: ["phasing"] });
export type CreateEnvelopeInput = z.infer<typeof CreateEnvelopeInput>;

/** PATCH /envelopes/:id/draft (spec §7.1). */
export const CreateDraftVersionInput = z.object({
  amount: MoneyString,
  rationale: z.string().max(4000).optional(),
  phasing: z.array(PhasingEntry).optional(),
  /** Optimistic concurrency: the version the client saw (draft ?? current), null for none. */
  basedOnVersionId: z.string().uuid().nullable(),
  attachments: z.array(z.object({ gcsUri: z.string(), name: z.string(), sha256: z.string() })).default([]),
});
export type CreateDraftVersionInput = z.infer<typeof CreateDraftVersionInput>;

/** PATCH /envelopes/:id/phasing: re-phase the head version's amount into a new draft. */
export const UpdatePhasingInput = z.object({
  phasing: z.array(PhasingEntry).min(1),
  basedOnVersionId: z.string().uuid(),
  rationale: z.string().max(4000).optional(),
});
export type UpdatePhasingInput = z.infer<typeof UpdatePhasingInput>;

/** POST /envelopes/:id/restore/:versionId: copy a past version into a new draft. */
export const RestoreVersionInput = z.object({
  basedOnVersionId: z.string().uuid().nullable(),
  rationale: z.string().max(4000).optional(),
});
export type RestoreVersionInput = z.infer<typeof RestoreVersionInput>;

/** PATCH /envelopes/:id: metadata only; amounts change through versions, tuples through move (T-014). */
export const UpdateEnvelopeInput = z
  .object({
    rowVersion: z.number().int().min(1),
    name: z.string().min(1).max(200).optional(),
    ownerId: z.string().uuid().nullable().optional(),
    startDate: IsoDate.optional(),
    endDate: IsoDate.optional(),
    periodId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type UpdateEnvelopeInput = z.infer<typeof UpdateEnvelopeInput>;

// ---------------------------------------------------------------------------------------------
// Bulk edit (spec §7.4, plan §9.3)
// ---------------------------------------------------------------------------------------------

export const BULK_MAX_ROWS = 10_000;

export const BulkOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), amount: MoneyString }),
  z.object({ op: z.literal("add"), amount: MoneyString }), // negative allowed
  z.object({ op: z.literal("pct"), pct: z.number().min(-100).max(10_000) }), // +15 => ×1.15
  z.object({
    op: z.literal("redistribute"),
    parentId: z.string().uuid(),
    method: z.enum(["proportional", "even", "by_last_actuals", "by_weights"]),
    weights: z.record(z.string().uuid(), z.number().min(0)).optional(),
    total: MoneyString.optional(),
  }),
  z.object({ op: z.literal("copy_previous_period"), factor: z.number().min(0).max(100).default(1) }),
  z.object({ op: z.literal("scale_to_total"), total: MoneyString }),
  z.object({ op: z.literal("paste"), rows: z.array(z.object({ envelopeId: z.string().uuid(), amount: MoneyString })).min(1).max(BULK_MAX_ROWS) }),
]);
export type BulkOperation = z.infer<typeof BulkOperation>;

export const BulkRequest = z.object({
  workspaceId: z.string().uuid(),
  selection: z.union([z.object({ envelopeIds: z.array(z.string().uuid()).min(1).max(BULK_MAX_ROWS) }), z.object({ filter: FilterGroup })]),
  operation: BulkOperation,
  rationale: z.string().min(3).max(4000),
});
export type BulkRequest = z.infer<typeof BulkRequest>;

export const BulkPreview = z.object({
  previewId: z.string().uuid(),
  rows: z.array(
    z.object({
      envelopeId: z.string().uuid(),
      path: z.array(z.string()),
      before: z.string().nullable(),
      after: z.string(),
      delta: z.string(),
    }),
  ),
  totalsBefore: z.string(),
  totalsAfter: z.string(),
  capViolations: z.array(z.object({ parentId: z.string().uuid(), parentAmount: z.string(), childrenAfter: z.string() })),
  policyPreview: z.object({ name: z.string(), chain: z.array(z.string()) }).nullable(),
  /** Rows the operation could not produce (e.g. no previous period), with the reason. Not committed. */
  skipped: z.array(z.object({ envelopeId: z.string().uuid(), reason: z.string() })).default([]),
  expiresAt: z.string().datetime(),
});
export type BulkPreview = z.infer<typeof BulkPreview>;

/** POST …/envelopes/csv-import: a CSV (header row: envelope_id, amount; other columns ignored) becomes a paste preview. */
export const CsvImportReport = z.object({
  rowsRead: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
  preview: BulkPreview.nullable(),
});
export type CsvImportReport = z.infer<typeof CsvImportReport>;

/** POST /workspaces/:ws/envelopes/csv-export: the selection to write out for editing. */
export const CsvExportInput = z.object({
  selection: z.union([z.object({ envelopeIds: z.array(z.string().uuid()).min(1).max(BULK_MAX_ROWS) }), z.object({ filter: FilterGroup })]),
});
export type CsvExportInput = z.infer<typeof CsvExportInput>;

/** POST /workspaces/:ws/envelopes/csv-import: the edited CSV back; columns mapped by header. */
export const CsvImportInput = z.object({
  csv: z.string().min(1).max(5_000_000),
  rationale: z.string().min(3).max(4000),
});
export type CsvImportInput = z.infer<typeof CsvImportInput>;

// ---------------------------------------------------------------------------------------------
// Move / split / merge (spec §7.5)
// ---------------------------------------------------------------------------------------------

/** POST /envelopes/:id/move. `parentId: null` moves to the root. */
export const MoveEnvelopeInput = z.object({
  parentId: z.string().uuid().nullable(),
  rowVersion: z.number().int().min(1),
  rationale: z.string().max(4000).optional(),
});
export type MoveEnvelopeInput = z.infer<typeof MoveEnvelopeInput>;

/**
 * POST /envelopes/:id/split: N new siblings (same parent, dates, currency) whose drafts sum to the
 * source's approved amount. Each part's dimensions default to the source's; given keys override.
 */
export const SplitEnvelopeInput = z.object({
  basedOnVersionId: z.string().uuid(),
  rationale: z.string().min(3).max(4000),
  parts: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        amount: MoneyString,
        dimensionValues: z.record(z.string().min(1), z.string().min(1)).default({}),
      }),
    )
    .min(2)
    .max(50),
});
export type SplitEnvelopeInput = z.infer<typeof SplitEnvelopeInput>;

/** POST /envelopes/merge: siblings in one currency become one new sibling holding their approved total. */
export const MergeEnvelopesInput = z.object({
  sourceIds: z.array(z.string().uuid()).min(2).max(50),
  name: z.string().min(1).max(200),
  dimensionValues: z.record(z.string().min(1), z.string().min(1)),
  rationale: z.string().min(3).max(4000),
});
export type MergeEnvelopesInput = z.infer<typeof MergeEnvelopesInput>;

/**
 * POST /envelopes/:id/children (T-031b, plan 0.6): a child under this envelope in one action. It
 * takes the parent's dates and currency and its dimensions (given keys override), gets a draft for
 * `amount`, and that draft is submitted: it goes through the matching policy like any other.
 */
export const AddChildInput = z.object({
  name: z.string().min(1).max(200),
  amount: MoneyString,
  dimensionValues: z.record(z.string().min(1), z.string().min(1)).default({}),
  rationale: z.string().min(3).max(4000),
});
export type AddChildInput = z.infer<typeof AddChildInput>;

/**
 * POST /envelopes/structure/preview (T-031b): what an add-child, move, split or merge would do,
 * without doing it. The server runs the real command in a transaction it rolls back, so the preview
 * applies exactly the checks the change would (caps, cycles, locks, scope, policy routing).
 */
export const StructurePreviewInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_child"), envelopeId: z.string().uuid(), input: AddChildInput }),
  z.object({ op: z.literal("move"), envelopeId: z.string().uuid(), input: MoveEnvelopeInput }),
  z.object({ op: z.literal("split"), envelopeId: z.string().uuid(), input: SplitEnvelopeInput }),
  z.object({ op: z.literal("merge"), input: MergeEnvelopesInput }),
]);
export type StructurePreviewInput = z.infer<typeof StructurePreviewInput>;
