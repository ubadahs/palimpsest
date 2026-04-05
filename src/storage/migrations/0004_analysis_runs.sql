CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY,
  seed_doi TEXT NOT NULL,
  tracked_claim TEXT NOT NULL,
  target_stage TEXT NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT,
  run_root TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE analysis_run_stages (
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

CREATE INDEX idx_analysis_runs_updated_at
  ON analysis_runs(updated_at DESC);

CREATE INDEX idx_analysis_runs_status
  ON analysis_runs(status);

CREATE INDEX idx_analysis_run_stages_run_order
  ON analysis_run_stages(run_id, stage_order);

CREATE INDEX idx_analysis_run_stages_status
  ON analysis_run_stages(status);
