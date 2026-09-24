-- T-007: planner queries use correlated per-envelope subqueries whose cost estimate crosses
-- jit_above_cost at a few thousand envelopes. LLVM JIT then costs ~1.5 s per query while the
-- query itself runs in ~100 ms (measured in packages/query-planner/src/planner.bench.ts).
-- Large analytic reads route to BigQuery (spec §6.2), so the application role never benefits from JIT.
-- Reverse: ALTER ROLE budget_app RESET jit;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'budget_app') THEN
    ALTER ROLE budget_app SET jit = off;
  END IF;
END
$$;
