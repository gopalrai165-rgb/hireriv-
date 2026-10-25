-- Step 53: job search by company and shift (skills already have job_skills,
-- indexed by skill). Keywords keep using the full-text search_vector; typing
-- slips are corrected by the app before searching, from the live jobs' words.
CREATE INDEX jobs_company ON jobs (lower(company_name));
CREATE INDEX jobs_shift ON jobs (shift) WHERE shift <> '';
