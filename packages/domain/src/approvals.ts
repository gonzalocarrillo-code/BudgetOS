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
