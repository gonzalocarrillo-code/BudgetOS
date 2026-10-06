/**
 * ADR-073: every wall-clock timing budget in apps/api's suites (`expect(x).toBeLessThan(<ms>)`)
 * assumes developer hardware. GitHub's shared CI runner is slower (its cores are shared with the
 * Postgres service and with the other test files running at once, see vitest.config.mjs), so every
 * such assertion should route its budget through this helper instead of a bare literal.
 * `PERF_BUDGET_SCALE` (CI: "3") scales every budget; unset or "1" locally and in `pnpm bench`
 * leaves the product's real numbers unchanged.
 */
export function perfBudgetMs(ms: number): number {
  const scale = Number(process.env["PERF_BUDGET_SCALE"] ?? 1);
  return ms * (Number.isFinite(scale) && scale > 0 ? scale : 1);
}
