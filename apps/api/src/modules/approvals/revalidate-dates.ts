import { DomainError } from "@budget/domain";
import { lockEnvelopes, type BulkDatesLine, type Tx } from "@budget/db";

/**
 * W3-5 (audit I-17): a date change is checked when it is requested (change-dates.ts `planDates`)
 * and applied when it is approved, possibly days later. Before the approval writes any date, the
 * same checks run again under the budgets' row locks; any mismatch sends the request back
 * (CHANGES_REQUESTED, decide.ts) instead of writing dates that leave a budget outside its parent,
 * a child outside its budget, or that undo a change made meanwhile.
 */

export type StaleReason = "missing" | "moved" | "changed" | "archived" | "locked" | "ended" | "outside_parent" | "child_outside";

/** Why the request went back, in words, for the blocking thread. */
export const STALE_REASON_TEXT: Record<StaleReason, string> = {
  missing: "it no longer exists",
  moved: "it was moved under another budget",
  changed: "it was edited",
  archived: "it was archived",
  locked: "its period was closed",
  ended: "it has ended",
  outside_parent: "the new dates no longer fit inside its parent's",
  child_outside: "a budget under it falls outside the new dates",
};

/** The dates request no longer matches the tree. A CONFLICT (409); decide() returns the request for changes. */
export class StaleRequestError extends DomainError {
  constructor(
    public readonly envelopeId: string,
    public readonly reason: StaleReason,
    extra: Record<string, unknown> = {},
  ) {
    super("CONFLICT", "The budget changed since the request was made; re-request the dates", { envelopeId, reason, ...extra });
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
type Range = { startDate: string; endDate: string };
const outside = (inner: Range, outer: Range) => inner.startDate < outer.startDate || inner.endDate > outer.endDate;

/** Locks every line (by id) and re-runs the request's checks against the tree as it is now. */
export async function revalidateDates(tx: Tx, lines: BulkDatesLine[]): Promise<void> {
  const ids = lines.map((l) => l.envelopeId);
  await lockEnvelopes(tx, ids);
  const byId = new Map(lines.map((l) => [l.envelopeId, l]));
  const rows = new Map(
    (await tx.envelope.findMany({ where: { id: { in: ids } }, select: { id: true, parentId: true, status: true, rowVersion: true, endedAt: true } })).map((e) => [e.id, e]),
  );
  const otherParents = [...new Set([...rows.values()].map((e) => e.parentId).filter((p): p is string => p !== null && !byId.has(p)))];
  const parents = new Map(
    (await tx.envelope.findMany({ where: { id: { in: otherParents } }, select: { id: true, status: true, startDate: true, endDate: true } })).map((p) => [p.id, p]),
  );

  for (const l of lines) {
    const e = rows.get(l.envelopeId);
    if (e === undefined) throw new StaleRequestError(l.envelopeId, "missing");
    // Requests made before W3-5 carry neither; their range checks below still run.
    if (l.parentId !== undefined && e.parentId !== l.parentId) throw new StaleRequestError(l.envelopeId, "moved", { parentId: e.parentId, requestedParentId: l.parentId });
    if (l.rowVersion !== undefined && e.rowVersion !== l.rowVersion) throw new StaleRequestError(l.envelopeId, "changed");
    if (e.status === "ARCHIVED") throw new StaleRequestError(l.envelopeId, "archived");
    if (e.status === "LOCKED") throw new StaleRequestError(l.envelopeId, "locked");
    if (e.endedAt !== null) throw new StaleRequestError(l.envelopeId, "ended");
    if (e.parentId === null) continue;
    // The parent's dates as they will be: its own new dates when it is a line too.
    const asLine = byId.get(e.parentId);
    const parent = parents.get(e.parentId);
    const range = asLine ?? (parent && parent.status !== "ARCHIVED" ? { startDate: iso(parent.startDate), endDate: iso(parent.endDate) } : null);
    if (range !== null && outside(l, range)) {
      throw new StaleRequestError(l.envelopeId, "outside_parent", { parentId: e.parentId, startDate: range.startDate, endDate: range.endDate });
    }
  }

  // Every child still inside its budget's new dates: a line by its new dates, any other by its own.
  const children = await tx.envelope.findMany({ where: { parentId: { in: ids }, status: { not: "ARCHIVED" } }, select: { id: true, parentId: true, startDate: true, endDate: true } });
  for (const c of children) {
    const parent = c.parentId === null ? undefined : byId.get(c.parentId);
    if (parent === undefined) continue;
    const range = byId.get(c.id) ?? { startDate: iso(c.startDate), endDate: iso(c.endDate) };
    if (outside(range, parent)) throw new StaleRequestError(parent.envelopeId, "child_outside", { childId: c.id });
  }
}
