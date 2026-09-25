import type { ClosureView } from "@budget/domain";
import type { FiscalPeriod, PeriodClosure } from "@prisma/client";

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function closureView(c: PeriodClosure, p: FiscalPeriod, lockedEnvelopes: number): ClosureView {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    period: { id: p.id, key: p.key, kind: p.kind, start: iso(p.startDate), end: iso(p.endDate) },
    status: c.status as ClosureView["status"],
    closedBy: c.closedBy,
    closedAt: c.closedAt.toISOString(),
    table: `closures.${c.bqTable}`,
    lockedEnvelopes,
  };
}
