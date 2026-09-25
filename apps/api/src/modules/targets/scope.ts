import type { ScopeTarget } from "@budget/domain";
import type { Tx } from "@budget/db";
import { envelopeScopeTarget } from "../../common/scope.guard.js";

/**
 * Scope a target is checked against. Envelope targets use the envelope's dimensions. A filter
 * target spans whatever its filter selects, so only a workspace-wide role may write or approve it.
 */
export async function targetScope(tx: Tx, t: { scopeType: string; envelopeId: string | null }): Promise<ScopeTarget> {
  if (t.scopeType === "envelope" && t.envelopeId !== null) return envelopeScopeTarget(tx, t.envelopeId);
  return { dims: {}, ancestors: {} };
}
