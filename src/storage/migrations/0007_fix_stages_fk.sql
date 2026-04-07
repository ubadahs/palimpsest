-- Fix analysis_run_stages FK that SQLite 3.26+ rewrote to reference
-- "analysis_runs_old" during the 0006 table-rebuild migration.
-- Rebuild the table with the correct FK target.

PRAGMA legacy_alter_table = ON;

CREATE TABLE analysis_run_stages_v2 (
  run_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  stage_order INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_artifact_path TEXT,
  primary_artifact_path TEXT,
  report_artifact_path TEXT,
  manifest_path TEXT,
  log_path TEXT,
  summary_json TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  process_id INTEGER,
  PRIMARY KEY (run_id, stage_key),
  FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
);

INSERT INTO analysis_run_stages_v2 SELECT * FROM analysis_run_stages;
DROP TABLE analysis_run_stages;
ALTER TABLE analysis_run_stages_v2 RENAME TO analysis_run_stages;

CREATE INDEX idx_analysis_run_stages_run_order
  ON analysis_run_stages(run_id, stage_order);

CREATE INDEX idx_analysis_run_stages_status
  ON analysis_run_stages(status);

PRAGMA legacy_alter_table = OFF;
