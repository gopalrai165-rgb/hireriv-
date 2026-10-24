-- Step 51: applicant tracking. Stage history and offer outcomes, for reporting.
-- No names, contact details, notes, pay or feedback: those stay in the app.

-- Every stage change, in order. Append-only in the app; this copy is replaced
-- with the app's history whenever an application changes.
CREATE TABLE application_stage_history (
  application_id  text NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  seq             integer NOT NULL CHECK (seq >= 0),
  from_stage      text NOT NULL,
  to_stage        text NOT NULL,
  changed_at      timestamptz NOT NULL,
  actor_kind      text NOT NULL CHECK (actor_kind IN ('team', 'employer', 'candidate', 'system')),
  is_correction   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (application_id, seq)
);
CREATE INDEX application_stage_history_to ON application_stage_history (to_stage, changed_at);

-- Offers: whether approved and how the candidate answered.
CREATE TABLE job_offers (
  id               text PRIMARY KEY,
  application_id   text NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  approval_status  text NOT NULL CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  response_status  text NOT NULL CHECK (response_status IN ('awaiting', 'accepted', 'declined')),
  created_at       timestamptz NOT NULL,
  approved_at      timestamptz,
  responded_at     timestamptz,
  withdrawn_at     timestamptz
);
CREATE INDEX job_offers_application ON job_offers (application_id);

ALTER TABLE applications ADD COLUMN assigned boolean NOT NULL DEFAULT false;

-- Refresh every application on the next sync so the new tables fill.
UPDATE applications SET source_hash = '';
