-- Per-family stage tracking: extract→adjudicate runs once per claim family.
-- Discover and screen remain family_index = 0 (whole-run stages).

CREATE TABLE analysis_run_stages_new (
  run_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  stage_order INTEGER NOT NULL,
  family_index INTEGER NOT NULL DEFAULT 0,
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
  PRIMARY KEY (run_id, stage_key, family_index),
  FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
);

INSERT INTO analysis_run_stages_new SELECT
  run_id, stage_key, stage_order, 0, status,
  input_artifact_path, primary_artifact_path, report_artifact_path,
  manifest_path, log_path, summary_json, error_message,
  started_at, finished_at, exit_code, process_id
FROM analysis_run_stages;

DROP TABLE analysis_run_stages;
ALTER TABLE analysis_run_stages_new RENAME TO analysis_run_stages;

CREATE INDEX idx_analysis_run_stages_run_order ON analysis_run_stages(run_id, stage_order);
CREATE INDEX idx_analysis_run_stages_status ON analysis_run_stages(status);
