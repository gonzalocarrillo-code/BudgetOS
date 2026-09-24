import { z } from "zod";

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
