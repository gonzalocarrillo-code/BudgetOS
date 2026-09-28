-- UX-001 (product feedback round 6, docs/UX_AUDIT_AND_ADMIN_PLAN.md P0-1): closing a tour before
-- its last step records that the person skipped it, so the invitation does not come back until a
-- new version is published. A skip is not a completion (the adoption metric counts completions).
--
-- Reverse: ALTER TABLE tour_completion DROP COLUMN IF EXISTS dismissed;
ALTER TABLE tour_completion ADD COLUMN IF NOT EXISTS dismissed boolean NOT NULL DEFAULT false;
