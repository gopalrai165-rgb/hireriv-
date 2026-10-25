-- Undoes 003_ats: the stage history and offer outcome copies. SQLite keeps the
-- originals, so the next sync after migrating again fills them back in.
DROP TABLE IF EXISTS job_offers;
DROP TABLE IF EXISTS application_stage_history;
ALTER TABLE applications DROP COLUMN IF EXISTS assigned;
UPDATE applications SET source_hash = '';
