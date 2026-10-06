-- EX-3 (docs/adr/0087-campaign-demo-data.md): experiments need a `demo` flag, matching envelope /
-- envelope_version / target / target_version, so the demo dataset's one campaign-vs-campaign
-- experiment is included in seedDemoData's summary and purgeDemoData's deletion, and the reseed
-- endpoint can tell whether its own demo experiment already exists.
--
-- Reverse: ALTER TABLE experiment DROP COLUMN demo;
ALTER TABLE experiment ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
