-- Undoes 001_jobs: every jobs table. Postgres only holds a copy of the jobs
-- data kept in SQLite, so nothing is lost; migrating again rebuilds it.
DROP TABLE IF EXISTS saved_jobs, applications, job_skills, job_category_assignments, job_locations, jobs, skills, job_categories CASCADE;
