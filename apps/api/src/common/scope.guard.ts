import { DomainError, canInScope, type Action, type ScopeTarget } from "@budget/domain";
import { dimensionValuePaths, type Tx } from "@budget/db";
import type { AuthContext } from "./tenant.js";

/**
 * Dimension-scope check for a known target (spec §5.4, plan §7.2). Route-level permission is the
 * interceptor's job; this runs in services once the entity is loaded. Org admins are unscoped.
 */
export function assertInScope(auth: AuthContext, action: Action, target: ScopeTarget): void {
  if (auth.isOrgAdmin) return;
  if (!canInScope(auth.assignments, action, target)) {
    throw new DomainError("FORBIDDEN", `Outside your scope for ${action}`, { action });
  }
}

/** Envelope dimension codes plus each value's ancestry (root … value), read through RLS. */
export async function envelopeScopeTarget(tx: Tx, envelopeId: string): Promise<ScopeTarget> {
  const rows = await tx.envelopeDimension.findMany({ where: { envelopeId }, select: { dimensionId: true, valueId: true } });
  if (rows.length === 0) {
    const exists = await tx.envelope.findUnique({ where: { id: envelopeId }, select: { id: true } });
    if (exists === null) throw new DomainError("NOT_FOUND", "Envelope not found");
  }
  return scopeTargetForValues(tx, rows);
}

/** Scope target for a set of (dimension, value) pairs, e.g. a tuple about to be written. */
export async function scopeTargetForValues(tx: Tx, rows: Array<{ dimensionId: string; valueId: string }>): Promise<ScopeTarget> {
  const dimensionIds = [...new Set(rows.map((r) => r.dimensionId))];
  const keys = new Map((await tx.dimension.findMany({ where: { id: { in: dimensionIds } }, select: { id: true, key: true } })).map((d) => [d.id, d.key]));
  const byId = new Map((await dimensionValuePaths(tx, dimensionIds)).map((p) => [p.id, p]));
  const dims: Record<string, string> = {};
  const ancestors: Record<string, string[]> = {};
  for (const r of rows) {
    const key = keys.get(r.dimensionId);
    const value = byId.get(r.valueId);
    if (key === undefined || value === undefined) continue;
    dims[key] = value.code;
    const chain: string[] = [];
    for (let v: typeof value | undefined = value; v !== undefined; v = v.parentValueId ? byId.get(v.parentValueId) : undefined) {
      chain.unshift(v.code);
    }
    ancestors[key] = chain;
  }
  return { dims, ancestors };
}
