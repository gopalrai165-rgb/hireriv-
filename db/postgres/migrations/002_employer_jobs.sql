-- Step 50: employers pause their jobs, and jobs carry more details
-- (openings, shift, working hours, workplace address, walk-ins, who can apply).
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('draft', 'pending', 'open', 'paused', 'closed', 'rejected'));

ALTER TABLE jobs
  ADD COLUMN openings          integer CHECK (openings BETWEEN 1 AND 9999),
  ADD COLUMN shift             text NOT NULL DEFAULT '' CHECK (shift IN ('', 'Day', 'Night', 'Rotational', 'Flexible')),
  ADD COLUMN work_hours        text NOT NULL DEFAULT '',
  ADD COLUMN workplace_address text NOT NULL DEFAULT '',
  ADD COLUMN walk_in           boolean NOT NULL DEFAULT false,
  ADD COLUMN eligibility       text[] NOT NULL DEFAULT '{}';

-- Rows mirrored before these columns existed are refreshed on the next sync.
UPDATE jobs SET source_hash = '';
