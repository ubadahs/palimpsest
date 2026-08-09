-- Drop unused papers/citations tables from the initial schema.
-- Production code stores papers in paper_cache / paper_parsed only.

DROP INDEX IF EXISTS idx_citations_citing_paper_id;
DROP INDEX IF EXISTS idx_citations_cited_paper_id;
DROP INDEX IF EXISTS idx_citations_auditability_status;
DROP TABLE IF EXISTS citations;
DROP TABLE IF EXISTS papers;
