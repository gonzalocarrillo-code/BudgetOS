import { DomainError } from "@budget/domain";
import { envelopeTimeline, withTenant, type TimelineRow } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";

export interface TimelineParams {
  limit?: string | undefined;
  cursor?: string | undefined;
  descendants?: string | undefined;
}

const TITLES: Record<string, string> = {
  "envelope.created": "Envelope created",
  "envelope.updated": "Details changed",
  "envelope.version.created": "Draft saved",
  "envelope.phasing.changed": "Re-phased",
  "envelope.version.restored": "Version restored",
  "envelope.version.approved": "Version approved",
  "approval.requested": "Submitted for approval",
  "approval.approve": "Approved a step",
  "approval.reject": "Rejected",
  "approval.request_changes": "Changes requested",
  "approval.external_evidence": "External evidence recorded",
  "approval.withdrawn": "Request withdrawn",
  "approval.escalated": "Escalated (overdue)",
  "comment.created": "Comment",
  "comment.replied": "Reply",
  "alert.opened": "Alert opened",
  "alert.resolved": "Alert resolved",
  "ingest.completed": "Actuals loaded",
  "closure.created": "Period closed",
  "closure.restated": "Period restated",
  "envelope.moved": "Moved",
  "envelope.split": "Split",
  "envelope.merged": "Merged",
};

function toDto(r: TimelineRow) {
  return {
    at: r.at.toISOString(),
    id: r.id,
    source: r.source,
    kind: r.kind,
    title: TITLES[r.kind] ?? r.kind,
    actor: r.actorId || r.actorType ? { id: r.actorId, name: r.actorName, type: r.actorType } : null,
    detail: { before: r.before ?? null, after: r.after ?? null, reason: r.reason, body: r.body },
    refs: { entityType: r.entityType, entityId: r.entityId },
  };
}

/** GET /envelopes/:id/timeline (spec §9.4). `descendants=true` is the roll-up timeline of the subtree. */
export async function getTimeline(prisma: PrismaClient, auth: AuthContext, rawId: string, params: TimelineParams) {
  const envelopeId = parseId(rawId);
  const limit = params.limit === undefined ? 100 : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new DomainError("VALIDATION", "limit must be 1..500");
  if (params.descendants !== undefined && params.descendants !== "true" && params.descendants !== "false") {
    throw new DomainError("VALIDATION", "descendants must be true or false");
  }
  let before: { atKey: string; id: string } | null = null;
  if (params.cursor) {
    try {
      const [at, id] = JSON.parse(Buffer.from(params.cursor, "base64url").toString()) as [string, string];
      if (typeof at !== "string" || typeof id !== "string" || Number.isNaN(Date.parse(at))) throw new Error("shape");
      before = { atKey: at, id };
    } catch {
      throw new DomainError("VALIDATION", "malformed cursor");
    }
  }
  const workspaceId = auth.ctx.workspaceId;
  if (workspaceId === null) throw new DomainError("VALIDATION", "Workspace required");
  return withTenant(prisma, auth.ctx, async (tx) => {
    assertInScope(auth, "envelope.read", await envelopeScopeTarget(tx, envelopeId));
    const rows = await envelopeTimeline(tx, { workspaceId, envelopeId, descendants: params.descendants === "true", limit: limit + 1, before });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify([last.atKey, last.id])).toString("base64url") : null;
    return { rows: page.map(toDto), nextCursor };
  });
}

/**
 * `as_of` for point-in-time reads. A bare date is the end of that day in UTC ("the approved budget
 * on 14 March" includes approvals made on the 14th); a datetime is used as given.
 */
export function parseAsOf(raw: string | undefined): Date | null {
  if (raw === undefined || raw === "") return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T23:59:59.999Z`) : new Date(raw);
  if (Number.isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(raw)) throw new DomainError("VALIDATION", "as_of must be YYYY-MM-DD or an ISO datetime");
  return d;
}
