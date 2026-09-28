-- A budget someone renamed keeps its own name (product feedback 2026-09-28: "can we rename
-- budgets?"): the display naming template no longer overwrites it. "Use the template name" clears it.
ALTER TABLE envelope ADD COLUMN IF NOT EXISTS name_custom boolean NOT NULL DEFAULT false;
