import { z } from "zod";

export interface PolicyConditions {
  entityType?: "envelope_version" | "target_version" | "bulk_change" | undefined;
  amountAbs?: { gte?: number | undefined; lt?: number | undefined } | undefined;
  deltaAbs?: { gte?: number | undefined; lt?: number | undefined } | undefined;
  deltaPct?: { gte?: number | undefined; lt?: number | undefined } | undefined;
  isOverAllocation?: boolean | undefined;
  level?: { gte?: number | undefined; lte?: number | undefined } | undefined;
  dimension?: Record<string, string[]> | undefined;
  daysRemaining?: { lt?: number | undefined } | undefined;
  metricKey?: string[] | undefined;
  any?: PolicyConditions[] | undefined;
}

export const PolicyConditions: z.ZodType<PolicyConditions> = z.lazy(() =>
  z.object({
    entityType: z.enum(["envelope_version", "target_version", "bulk_change"]).optional(),
    amountAbs: z.object({ gte: z.number().optional(), lt: z.number().optional() }).optional(),
    deltaAbs: z.object({ gte: z.number().optional(), lt: z.number().optional() }).optional(),
    deltaPct: z.object({ gte: z.number().optional(), lt: z.number().optional() }).optional(),
    isOverAllocation: z.boolean().optional(),
    level: z.object({ gte: z.number().int().optional(), lte: z.number().int().optional() }).optional(),
    dimension: z.record(z.string(), z.array(z.string())).optional(),
    daysRemaining: z.object({ lt: z.number().int().optional() }).optional(),
    metricKey: z.array(z.string()).optional(),
    any: z.array(PolicyConditions).optional(),
  }),
);

export const ChainStep = z.object({
  role: z.enum(["PLANNER", "BUDGET_OWNER", "APPROVER", "FINANCE", "WORKSPACE_ADMIN"]),
  groupId: z.string().uuid().optional(),
  minApprovals: z.number().int().min(1).default(1),
  timeoutHours: z.number().int().default(48),
  escalateTo: z.enum(["FINANCE", "WORKSPACE_ADMIN"]).optional(),
});
export type ChainStep = z.infer<typeof ChainStep>;

/** POST /envelopes/:id/submit. `versionId` must be the envelope's open draft (optimistic concurrency). */
export const SubmitVersionInput = z.object({ versionId: z.string().uuid() });
export type SubmitVersionInput = z.infer<typeof SubmitVersionInput>;

/** POST /approvals/:id/decisions (spec §9.3; the request id comes from the route). */
export const DecideInput = z
  .object({
    decision: z.enum(["approve", "reject", "request_changes"]),
    comment: z.string().max(4000).optional(),
    channel: z.enum(["app", "slack", "email"]).default("app"),
  })
  .refine((v) => v.decision === "approve" || (v.comment !== undefined && v.comment.trim() !== ""), {
    message: "Comment required to reject or request changes",
    path: ["comment"],
  });
export type DecideInput = z.infer<typeof DecideInput>;

/** POST /approvals/:id/external-evidence (plan §8.2): a client's sign-off recorded against the current step. */
export const ExternalEvidenceInput = z.object({
  gcsUri: z.string().regex(/^gs:\/\/[^/]+\/.+/, "gs://bucket/object"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "hex sha256"),
  approverName: z.string().min(1).max(200),
  approvedOn: z.string().date(),
  comment: z.string().max(4000).optional(),
});
export type ExternalEvidenceInput = z.infer<typeof ExternalEvidenceInput>;

/** POST /approvals/:id/withdraw and POST /envelopes/:id/withdraw. */
export const WithdrawInput = z.object({ comment: z.string().max(4000).optional() });
export type WithdrawInput = z.infer<typeof WithdrawInput>;

/** POST /workspaces/:ws/policies. */
export const CreatePolicyInput = z.object({
  name: z.string().min(1).max(200),
  priority: z.number().int().min(0).max(100_000),
  conditions: PolicyConditions,
  chain: z.array(ChainStep).max(10),
  allowExternalEvidence: z.boolean().default(false),
  blockSelfApproval: z.boolean().default(true),
});
export type CreatePolicyInput = z.infer<typeof CreatePolicyInput>;

/** PATCH /policies/:id. Any change bumps `version`; open requests keep the snapshot they were created with. */
export const UpdatePolicyInput = z
  .object({
    version: z.number().int().min(1),
    name: z.string().min(1).max(200).optional(),
    priority: z.number().int().min(0).max(100_000).optional(),
    conditions: PolicyConditions.optional(),
    chain: z.array(ChainStep).max(10).optional(),
    allowExternalEvidence: z.boolean().optional(),
    blockSelfApproval: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdatePolicyInput = z.infer<typeof UpdatePolicyInput>;
