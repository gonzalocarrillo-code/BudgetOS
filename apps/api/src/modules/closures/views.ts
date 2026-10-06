import { ClosureBasis, type ClosureView } from "@budget/domain";
import type { FiscalPeriod, PeriodClosure } from "@prisma/client";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** D-1: the basis recorded in `variance_summary.basis` at close time; absent on older closures. */
function basisOf(varianceSummary: unknown): ClosureBasis | undefined {
  const raw = (varianceSummary as { basis?: unknown } | null)?.basis;
  const parsed = ClosureBasis.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function closureView(c: PeriodClosure, p: FiscalPeriod, lockedEnvelopes: number): ClosureView {
  const basis = basisOf(c.varianceSummary);
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    period: { id: p.id, key: p.key, kind: p.kind, start: iso(p.startDate), end: iso(p.endDate) },
    status: c.status as ClosureView["status"],
    closedBy: c.closedBy,
    closedAt: c.closedAt.toISOString(),
    table: `closures.${c.bqTable}`,
    lockedEnvelopes,
    ...(basis ? { basis } : {}),
    error: c.error ?? null,
  };
}
