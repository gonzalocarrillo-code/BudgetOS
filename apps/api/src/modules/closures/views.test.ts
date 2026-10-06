import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ClosureView } from "@budget/domain";
import type { FiscalPeriod, PeriodClosure } from "@prisma/client";
import { closureView } from "./views.js";

/**
 * D-1 (audit T-12): `basis` is read out of `variance_summary.basis`, written only from the
 * close-period command onward. A closure written before that field existed has no `basis` key in
 * its stored JSON, and the view must still build and validate (no `basis` in its output), not throw.
 */
describe("closureView (D-1)", () => {
  const period: FiscalPeriod = {
    id: randomUUID(),
    workspaceId: randomUUID(),
    key: "2026-Q1",
    kind: "quarter",
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    endDate: new Date("2026-03-31T00:00:00.000Z"),
  } as FiscalPeriod;

  const base: PeriodClosure = {
    id: randomUUID(),
    workspaceId: period.workspaceId,
    periodId: period.id,
    status: "closed",
    closedBy: randomUUID(),
    closedAt: new Date("2026-04-02T09:00:00.000Z"),
    registryVersion: {},
    bqTable: "closure_old",
    error: null,
    varianceSummary: {},
  } as unknown as PeriodClosure;

  it("an old closure (no basis in its stored variance_summary) still renders, with no basis field", () => {
    const view = closureView(base, period, 2);
    expect(view.basis).toBeUndefined();
    expect(ClosureView.parse(view)).toEqual(view);
  });

  it("a closure with a recorded basis surfaces it", () => {
    const withBasis = { ...base, varianceSummary: { basis: { budget: "live_leaves", note: "Sum of approved leaf budgets live in the period." } } } as PeriodClosure;
    const view = closureView(withBasis, period, 2);
    expect(view.basis).toEqual({ budget: "live_leaves", note: "Sum of approved leaf budgets live in the period." });
  });

  it("an unrecognized basis shape is dropped rather than surfaced or thrown", () => {
    const malformed = { ...base, varianceSummary: { basis: { budget: "holdings" } } } as unknown as PeriodClosure;
    expect(closureView(malformed, period, 2).basis).toBeUndefined();
  });
});
