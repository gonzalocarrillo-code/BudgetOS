import { LIVE_LEAVES, TOP_LEVEL, readScopeFilter, type FilterGroupT, type Predicate } from "@budget/domain";
import type { AuthContext } from "./tenant.js";

/**
 * "The budget" in a headline number (UX-008, ADR-051). For someone who reads the whole workspace it
 * is the top-level budgets, each with everything spent under it: the same rows and totals as
 * Budgets' budget structure (ADR-050). Someone whose roles cover only some values reads the live
 * leaves inside that scope, because the top-level budgets above them are outside it.
 * `undefined` when no role grants envelope.read.
 */
export interface Headline {
  filter: FilterGroupT;
  subtree: boolean;
  /** Whole workspace (top-level budgets) or the caller's scope (leaves). */
  basis: "top_level" | "scoped_leaves";
}

export function headline(auth: AuthContext, extra: Predicate[] = []): Headline | undefined {
  let scope: FilterGroupT | null;
  try {
    scope = auth.isOrgAdmin ? null : readScopeFilter(auth.assignments, "envelope.read");
  } catch {
    return undefined;
  }
  if (scope === null) return { filter: { logic: "and", children: [...TOP_LEVEL, ...extra] }, subtree: true, basis: "top_level" };
  return { filter: { logic: "and", children: [...LIVE_LEAVES, scope, ...extra] }, subtree: false, basis: "scoped_leaves" };
}
