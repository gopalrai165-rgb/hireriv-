-- Undoes 002_employer_jobs: the extra job columns and the "paused" status.
-- Postgres is a copy of the jobs data in SQLite; paused jobs are marked closed
-- here only, and the next sync after migrating again restores them.
ALTER TABLE jobs
  DROP COLUMN IF EXISTS openings,
  DROP COLUMN IF EXISTS shift,
  DROP COLUMN IF EXISTS work_hours,
  DROP COLUMN IF EXISTS workplace_address,
  DROP COLUMN IF EXISTS walk_in,
  DROP COLUMN IF EXISTS eligibility;
UPDATE jobs SET status = 'closed' WHERE status = 'paused';
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('draft', 'pending', 'open', 'closed', 'rejected'));
UPDATE jobs SET source_hash = '';
