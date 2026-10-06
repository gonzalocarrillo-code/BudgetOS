-- W3-3 (audit I-18, I-19; plan docs/STACK_HARDENING_PLAN.md). Six SELECT-then-INSERT races the
-- application already guards with a `findFirst` check that has no backing constraint, so two
-- concurrent requests both pass the check and both write. Postgres now refuses the second write
-- instead of silently doubling the row; the app layer catches the resulting unique-violation
-- (Prisma P2002) and raises its own `DomainError('CONFLICT', ...)` with a useful message, same
-- pattern as the existing P2002 catches in workspaces.ts / add-person.ts / metrics.ts /
-- close-period.ts. Any violation the app code does *not* catch still becomes a 409 via the global
-- `AllExceptionsFilter` (P2002 -> CONFLICT), so no path regresses to a 500.
--
-- Expand-only: every index here is new (IF NOT EXISTS) and nothing existing is dropped, renamed or
-- made stricter in a way old code violates -- every app path already enforces the same uniqueness
-- at the SELECT-then-INSERT level, so no existing row can violate the new index (checked against
-- the golden dataset: zero rows found per query below before this migration).
--
-- CONCURRENTLY cannot run inside Prisma's migration transaction; plain CREATE UNIQUE INDEX IF NOT
-- EXISTS takes a brief ACCESS EXCLUSIVE lock, acceptable here since every one of these tables is
-- small (same reasoning as 20261012000000_schema_invariants's indexes).
--
-- Reverse (expand-only; a contract migration would need its own PR per AGENTS.md):
--   DROP INDEX IF EXISTS ingest_run_source_open_run, target_envelope_active_metric,
--     pacing_rule_workspace_live_name, role_assignment_unique_scoped,
--     role_assignment_unique_org_wide, approval_decision_request_step_decider,
--     envelope_lineage_continues_source;

-- =========================================================================================
-- I-19: ingest "run now" -- apps/api/src/modules/sources/commands/sources.ts's queueRun() checks
-- for an open run (status queued|running) for the source, then inserts. One queued-or-running run
-- per source at a time.
-- =========================================================================================
CREATE UNIQUE INDEX IF NOT EXISTS ingest_run_source_open_run
  ON ingest_run (source_id)
  WHERE status IN ('queued', 'running');

-- =========================================================================================
-- I-19: one active target per (envelope, metric) -- create-target.ts's createTarget() checks for a
-- clashing active envelope-scoped target, then inserts. scope_type='filter' targets have no
-- envelope_id (NULL), and NULL is never equal to NULL in a unique index, so filter-scoped targets
-- (never deduplicated by the app either) are unaffected.
-- =========================================================================================
CREATE UNIQUE INDEX IF NOT EXISTS target_envelope_active_metric
  ON target (envelope_id, metric_key)
  WHERE status = 'active';

-- =========================================================================================
-- I-19: pacing rule names -- rules.ts's insertRule()/updateRule() check for a clashing live
-- (not soft-deleted) rule name in the workspace, then insert/rename. A soft-deleted rule's name is
-- free again (deleted_at IS NOT NULL falls outside the index).
-- =========================================================================================
CREATE UNIQUE INDEX IF NOT EXISTS pacing_rule_workspace_live_name
  ON pacing_rule (workspace_id, name)
  WHERE deleted_at IS NULL;

-- =========================================================================================
-- I-19: role assignments -- assign-role.ts's assignRole() checks for a clashing
-- (workspace, principal, role) row (scope is deliberately not part of the dedupe: the message is
-- "Role already assigned" regardless of scope), then inserts. workspace_id is NULL for an org-wide
-- ORG_ADMIN assignment; Postgres treats every NULL as distinct from every other NULL in a unique
-- index, so the workspace-scoped index alone would let unlimited duplicate org-wide rows through --
-- hence the second, NULL-only index covering that case specifically.
-- =========================================================================================
CREATE UNIQUE INDEX IF NOT EXISTS role_assignment_unique_scoped
  ON role_assignment (workspace_id, principal_type, principal_id, role)
  WHERE workspace_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS role_assignment_unique_org_wide
  ON role_assignment (principal_type, principal_id, role)
  WHERE workspace_id IS NULL;

-- =========================================================================================
-- I-18: one decision per (request, step, decider) -- decide.ts's decide() already checks
-- `already` (a count) before inserting; external-evidence.ts's recordExternalEvidence() has no such
-- check at all, so the same requester uploading evidence twice creates two rows with the same
-- (request_id, step_index, decided_by), and countedApprovals() (apps/api/src/modules/approvals/
-- engine.ts) counts rows rather than distinct deciders (I-18's exact finding) -- satisfying
-- minApprovals with one person's two uploads. Fixed here at the constraint; engine.ts's
-- countedApprovals is changed in the same PR to COUNT(DISTINCT decided_by) so a future caller that
-- forgets this constraint (e.g. a bulk importer) still can't inflate the count even if it somehow
-- bypassed the unique index. Not partial: every decision row, of any channel or decision value,
-- counts toward "this person already decided this step".
-- =========================================================================================
CREATE UNIQUE INDEX IF NOT EXISTS approval_decision_request_step_decider
  ON approval_decision (request_id, step_index, decided_by);

-- =========================================================================================
-- I-28: `reintroduce` takes no lock on the ended source -> two successors. end-reintroduce.ts is
-- changed in this PR to lock the source envelope row (FOR UPDATE, via the existing lockEnvelope())
-- before checking endedAt, and to re-check for an existing successor under that lock; this index is
-- the database backstop for any path that reaches createSuccessor() without going through that
-- lock (and for the always-possible “two already-locked, already-checked transactions still commit
-- out of order” case the row lock alone does not rule out, since ending a budget never revisits its
-- own row once ended). One `continues` successor per source envelope; `move`/`split`/`merge` keep
-- their own (unrelated) lineage shape and are not covered.
-- =========================================================================================
CREATE UNIQUE INDEX IF NOT EXISTS envelope_lineage_continues_source
  ON envelope_lineage (from_envelope_id)
  WHERE kind = 'continues';
