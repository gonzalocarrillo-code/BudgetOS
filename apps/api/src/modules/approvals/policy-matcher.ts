import { ChainStep, PolicyConditions, type PolicyConditions as PolicyConditionsT } from "@budget/domain";
import type { Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { ApprovalPolicy } from "@prisma/client";
import { z } from "zod";

/**
 * Facts a policy is matched against (spec §9.2). Money stays Decimal: the thresholds in policy JSON
 * are plain numbers, compared as Decimal so no amount ever passes through a JS float.
 */
export interface DiffFacts {
  entityType: string;
  amountAbs: Decimal; // version amount, reporting currency
  deltaAbs: Decimal; // vs the approved amount (0 when none)
  deltaPct: Decimal; // |delta| / approved; 1 (100%) when there is no approved amount
  isOverAllocation: boolean;
  level: number; // 0 = root envelope
  dimensionValues: Record<string, string>;
  daysRemaining: number;
  metricKey?: string;
}

type Range = { gte?: number | undefined; lt?: number | undefined; lte?: number | undefined } | undefined;

function inRange(r: Range, v: Decimal): boolean {
  if (!r) return true;
  return (r.gte === undefined || v.gte(r.gte)) && (r.lt === undefined || v.lt(r.lt)) && (r.lte === undefined || v.lte(r.lte));
}

export function conditionsMatch(c: PolicyConditionsT, f: DiffFacts): boolean {
  if (c.any) return c.any.some((x) => conditionsMatch(x, f));
  if (c.entityType && c.entityType !== f.entityType) return false;
  if (!inRange(c.amountAbs, f.amountAbs.abs())) return false;
  if (!inRange(c.deltaAbs, f.deltaAbs.abs())) return false;
  if (!inRange(c.deltaPct, f.deltaPct.abs())) return false;
  if (c.isOverAllocation !== undefined && c.isOverAllocation !== f.isOverAllocation) return false;
  if (!inRange(c.level, new Decimal(f.level))) return false;
  if (c.daysRemaining?.lt !== undefined && !(f.daysRemaining < c.daysRemaining.lt)) return false;
  if (c.metricKey && (!f.metricKey || !c.metricKey.includes(f.metricKey))) return false;
  if (c.dimension) {
    for (const [k, allowed] of Object.entries(c.dimension)) {
      if (!allowed.includes(f.dimensionValues[k] ?? "")) return false;
    }
  }
  return true;
}

export type MatchedPolicy = Omit<ApprovalPolicy, "chain"> & { chain: ChainStep[]; conditionsParsed: PolicyConditionsT };

/** First active policy by priority whose conditions match. A policy with unreadable JSON is skipped, never matched. */
export async function matchPolicy(tx: Tx, workspaceId: string, f: DiffFacts): Promise<MatchedPolicy | null> {
  const policies = await tx.approvalPolicy.findMany({ where: { workspaceId, isActive: true }, orderBy: [{ priority: "asc" }, { name: "asc" }] });
  for (const p of policies) {
    const conditions = PolicyConditions.safeParse(p.conditions);
    const chain = z.array(ChainStep).safeParse(p.chain);
    if (!conditions.success || !chain.success) continue;
    if (conditionsMatch(conditions.data, f)) return { ...p, chain: chain.data, conditionsParsed: conditions.data };
  }
  return null;
}
