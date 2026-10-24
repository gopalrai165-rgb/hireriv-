-- Hireriv jobs data in PostgreSQL (Step 48).
--
-- These tables mirror the jobs side of the site. SQLite stays the source of
-- truth: when DATABASE_URL is set the app copies every change here and the
-- public jobs API (/api/jobs) searches these tables.
--
-- Ids are the app's own ids (e.g. "hr-101"), so rows can be matched both ways.
-- No candidate names, emails or phone numbers are copied: applications and
-- saved jobs carry a one-way hash of the candidate's key instead, which is
-- enough to enforce "one live application per person per job".

-- Categories form a two-level tree: the three kinds of work at the top
-- ("Office & professional", "Skilled & technical", "Industrial, field &
-- service") and the site's categories under them.
CREATE TABLE job_categories (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  parent_id  integer REFERENCES job_categories (id) ON DELETE RESTRICT,
  work_kind  text NOT NULL CHECK (work_kind IN ('office', 'skilled', 'field')),
  CHECK (name <> ''),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX job_categories_name ON job_categories (parent_id, lower(name));
CREATE INDEX job_categories_parent ON job_categories (parent_id);

CREATE TABLE skills (
  id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name  text NOT NULL CHECK (name <> '')
);
CREATE UNIQUE INDEX skills_name ON skills (lower(name));

CREATE TABLE jobs (
  id                 text PRIMARY KEY,
  slug               text NOT NULL UNIQUE,
  title              text NOT NULL CHECK (title <> ''),
  company_name       text NOT NULL DEFAULT '',
  employer_id        text,                       -- employer account id (accounts live in SQLite)
  created_by         text NOT NULL DEFAULT 'team' CHECK (created_by IN ('team', 'employer')),
  description        text NOT NULL DEFAULT '',
  responsibilities   text[] NOT NULL DEFAULT '{}',
  qualifications     text[] NOT NULL DEFAULT '{}',
  benefits           text[] NOT NULL DEFAULT '{}',
  employment_type    text NOT NULL,
  work_arrangement   text NOT NULL,
  work_kind          text NOT NULL CHECK (work_kind IN ('office', 'skilled', 'field')),
  group_keys         text[] NOT NULL DEFAULT '{}', -- the site's job groups (IT & Engineering, Fresher jobs…)
  experience_text    text NOT NULL DEFAULT '',
  experience_min     numeric(4, 1) CHECK (experience_min >= 0),
  experience_max     numeric(4, 1),
  education          text NOT NULL DEFAULT '',
  schedule           text NOT NULL DEFAULT '',
  salary_min         numeric(12, 2) CHECK (salary_min > 0),
  salary_max         numeric(12, 2) CHECK (salary_max > 0),
  salary_currency    char(3) NOT NULL DEFAULT 'INR',
  pay_period         text CHECK (pay_period IN ('month', 'year', 'day', 'hour')),
  pay_note           text NOT NULL DEFAULT '',
  monthly_pay_max    numeric(14, 2),             -- highest pay as ₹ a month, for filtering and sorting
  quick_apply        boolean NOT NULL DEFAULT false,
  status             text NOT NULL CHECK (status IN ('draft', 'pending', 'open', 'closed', 'rejected')),
  is_sample          boolean NOT NULL DEFAULT false,
  posted_on          date,
  published_at       timestamptz,
  closes_on          date,
  created_at         timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  id_sort            text NOT NULL,              -- id with zero-padded numbers, for a stable order
  search_vector      tsvector NOT NULL,          -- weighted: title A, skills B, company and category C, text D
  source_hash        text NOT NULL,              -- change detection for the mirror
  CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max),
  CHECK ((salary_min IS NULL AND salary_max IS NULL) = (pay_period IS NULL)),
  CHECK (experience_min IS NULL OR experience_max >= experience_min)
);
CREATE INDEX jobs_search ON jobs USING GIN (search_vector);
CREATE INDEX jobs_groups ON jobs USING GIN (group_keys);
CREATE INDEX jobs_live_newest ON jobs (posted_on DESC, id_sort DESC) WHERE status = 'open' AND NOT is_sample;
CREATE INDEX jobs_pay ON jobs (monthly_pay_max DESC NULLS LAST) WHERE status = 'open';
CREATE INDEX jobs_type ON jobs (employment_type);
CREATE INDEX jobs_arrangement ON jobs (work_arrangement);
CREATE INDEX jobs_employer ON jobs (employer_id) WHERE employer_id IS NOT NULL;

-- Where the job is. One row per place (today the site has one per job).
CREATE TABLE job_locations (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id     text NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  city       text NOT NULL CHECK (city <> ''),
  state      text NOT NULL DEFAULT '',
  country    text NOT NULL DEFAULT 'India',
  is_remote  boolean NOT NULL DEFAULT false,
  UNIQUE (job_id, city)
);
CREATE INDEX job_locations_city ON job_locations (city);
CREATE INDEX job_locations_state ON job_locations (state);

CREATE TABLE job_category_assignments (
  job_id       text NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  category_id  integer NOT NULL REFERENCES job_categories (id) ON DELETE RESTRICT,
  is_primary   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (job_id, category_id)
);
CREATE INDEX job_category_assignments_category ON job_category_assignments (category_id);

CREATE TABLE job_skills (
  job_id    text NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  skill_id  integer NOT NULL REFERENCES skills (id) ON DELETE RESTRICT,
  position  smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, skill_id)
);
CREATE INDEX job_skills_skill ON job_skills (skill_id);

-- Applications. job_ref is the job the person applied to ("general" for a
-- registration without a job); job_id links to the job while it exists.
CREATE TABLE applications (
  id              text PRIMARY KEY,
  job_ref         text NOT NULL,
  job_id          text REFERENCES jobs (id) ON DELETE SET NULL,
  candidate_hash  text NOT NULL CHECK (length(candidate_hash) = 64),
  status          text NOT NULL CHECK (status <> ''),
  source          text NOT NULL DEFAULT '',
  duplicate_of    text,                          -- an older duplicate kept for the record
  withdrawn_at    timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  source_hash     text NOT NULL
);
-- One live application per person per job, as in the app.
CREATE UNIQUE INDEX applications_one_live ON applications (job_ref, candidate_hash)
  WHERE withdrawn_at IS NULL AND duplicate_of IS NULL;
CREATE INDEX applications_job ON applications (job_id);
CREATE INDEX applications_candidate ON applications (candidate_hash);
CREATE INDEX applications_status ON applications (status);

CREATE TABLE saved_jobs (
  candidate_hash  text NOT NULL CHECK (length(candidate_hash) = 64),
  job_id          text NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  saved_at        timestamptz,
  PRIMARY KEY (candidate_hash, job_id)
);
CREATE INDEX saved_jobs_job ON saved_jobs (job_id);
