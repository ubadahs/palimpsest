-- Allow tracked_claim to be NULL for auto-discover runs (DOI-only input).
-- SQLite does not support ALTER COLUMN, so we recreate the table.
--
-- We use the "create-new, copy, drop-old, rename-new" pattern instead of
-- "rename-old, create, copy, drop-old" because SQLite 3.26+ rewrites FK
-- references in child tables when a parent is renamed. If we renamed
-- analysis_runs → analysis_runs_old, analysis_run_stages would end up
-- referencing the temporary name, breaking after drop. By only renaming
-- the NEW table (which nothing references), FK metadata stays clean.

CREATE TABLE analysis_runs_new (
  id TEXT PRIMARY KEY,
  seed_doi TEXT NOT NULL,
  tracked_claim TEXT,
  target_stage TEXT NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT,
  run_root TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO analysis_runs_new SELECT * FROM analysis_runs;
DROP TABLE analysis_runs;
ALTER TABLE analysis_runs_new RENAME TO analysis_runs;

CREATE INDEX idx_analysis_runs_updated_at ON analysis_runs(updated_at DESC);
CREATE INDEX idx_analysis_runs_status ON analysis_runs(status);
