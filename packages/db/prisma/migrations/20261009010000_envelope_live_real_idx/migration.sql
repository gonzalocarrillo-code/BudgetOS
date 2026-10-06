-- Reverse: DROP INDEX IF EXISTS envelope_live_real_idx;
--
-- T-5 follow-up (W1-4 coordinator review): the planner's demo_mode CTE
-- (compile-query.ts, compile-aggregate.bq.ts) runs
--   NOT EXISTS (SELECT 1 FROM envelope r WHERE r.workspace_id = $1 AND NOT r.demo AND r.status <> 'ARCHIVED')
-- once per query to decide whether the workspace still has no real budget. envelope_demo_idx
-- (20260927020000) only covers rows WHERE demo, the opposite predicate; without a matching index
-- that EXISTS falls back to scanning the workspace's envelope rows. This partial index covers the
-- predicate exactly, so the check is a fast existence probe regardless of workspace size.
CREATE INDEX IF NOT EXISTS envelope_live_real_idx ON envelope (workspace_id) WHERE NOT demo AND status <> 'ARCHIVED';
