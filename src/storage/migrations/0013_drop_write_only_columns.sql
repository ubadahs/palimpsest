-- Drop tables and columns nothing reads back.
--
-- Every column removed here was written on each run and never selected. They
-- are all recoverable from the run's on-disk artifacts if ever needed again,
-- so nothing scientific is lost.
--
-- `analysis_run_stages.family_index` deliberately stays: it is part of an
-- immutable primary key, and dropping it would rewrite the table's identity.

-- The provisional derived-artifact table predates the canonical artifact chain
-- and has had no writer since.
DROP INDEX IF EXISTS idx_derived_artifacts_paper;
DROP TABLE IF EXISTS derived_artifacts;

-- Canonical runs are DOI-first; a run-level tracked claim has no writer.
ALTER TABLE analysis_runs DROP COLUMN tracked_claim;

-- The stage's input is its predecessor's primary artifact, which the registry
-- already records. `exit_code` duplicated `status`.
ALTER TABLE analysis_run_stages DROP COLUMN input_artifact_path;
ALTER TABLE analysis_run_stages DROP COLUMN exit_code;

-- Paper metadata is re-resolved from the provider on every run; only the raw
-- text, its format, the content hash, and the acquisition provenance are read.
DROP INDEX IF EXISTS idx_paper_cache_doi;
ALTER TABLE paper_cache DROP COLUMN metadata_json;
ALTER TABLE paper_cache DROP COLUMN doi;
ALTER TABLE paper_cache DROP COLUMN openalex_id;
ALTER TABLE paper_cache DROP COLUMN pmcid;
ALTER TABLE paper_cache DROP COLUMN title;
ALTER TABLE paper_cache DROP COLUMN authors_json;
ALTER TABLE paper_cache DROP COLUMN access_status;
ALTER TABLE paper_cache DROP COLUMN fetch_source_url;
ALTER TABLE paper_cache DROP COLUMN fetch_status;
ALTER TABLE paper_cache DROP COLUMN fetched_at;

-- Section titles are carried on the parsed blocks themselves.
ALTER TABLE paper_parsed DROP COLUMN sections_json;

-- The cache is addressed only by its key; the key already binds purpose,
-- model, and key version.
DROP INDEX IF EXISTS idx_llm_result_cache_purpose;
ALTER TABLE llm_result_cache DROP COLUMN purpose;
ALTER TABLE llm_result_cache DROP COLUMN model;
ALTER TABLE llm_result_cache DROP COLUMN key_version;
