import { capInputs, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";

/**
 * Parent caps after a bulk change (plan §4.3): for every parent of a changed row, and every changed
 * row that is itself a parent, the children's approved amounts with the changed ones replaced by
 * their new values (reporting currency). Parents that allow over-allocation are skipped.
 */
export async function capViolations(
  tx: Tx,
  changed: Array<{ id: string; parentId: string | null }>,
  afterRep: Map<string, Decimal>,
): Promise<Array<{ parentId: string; parentAmount: string; childrenAfter: string }>> {
  const parentIds = [...new Set([...changed.map((h) => h.parentId).filter((p): p is string => p !== null), ...changed.map((h) => h.id)])];
  const groups = new Map<string, { parentAmount: string | null; allow: boolean; children: Decimal }>();
  for (const row of await capInputs(tx, parentIds)) {
    const g = groups.get(row.parentId) ?? { parentAmount: row.parentAmount, allow: row.allowOverAllocation, children: new Decimal(0) };
    g.children = g.children.plus(afterRep.get(row.childId) ?? row.childAmount ?? 0);
    groups.set(row.parentId, g);
  }
  const out: Array<{ parentId: string; parentAmount: string; childrenAfter: string }> = [];
  for (const [parentId, g] of groups) {
    const parentAfter = afterRep.get(parentId) ?? (g.parentAmount === null ? null : new Decimal(g.parentAmount));
    if (g.allow || parentAfter === null) continue;
    if (g.children.gt(parentAfter)) out.push({ parentId, parentAmount: parentAfter.toFixed(2), childrenAfter: g.children.toFixed(2) });
  }
  return out;
}
