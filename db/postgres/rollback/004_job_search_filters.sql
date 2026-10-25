-- Undoes 004_job_search_filters: the two search indexes. No data is touched.
DROP INDEX IF EXISTS jobs_shift;
DROP INDEX IF EXISTS jobs_company;
