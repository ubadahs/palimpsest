-- Rename stage keys from milestone-prefixed to descriptive names.

UPDATE analysis_run_stages SET stage_key = 'screen'     WHERE stage_key = 'pre-screen';
UPDATE analysis_run_stages SET stage_key = 'extract'    WHERE stage_key = 'm2-extract';
UPDATE analysis_run_stages SET stage_key = 'classify'   WHERE stage_key = 'm3-classify';
UPDATE analysis_run_stages SET stage_key = 'evidence'   WHERE stage_key = 'm4-evidence';
UPDATE analysis_run_stages SET stage_key = 'curate'     WHERE stage_key = 'm5-adjudicate';
UPDATE analysis_run_stages SET stage_key = 'adjudicate' WHERE stage_key = 'm6-llm-judge';

UPDATE analysis_runs SET target_stage = 'screen'     WHERE target_stage = 'pre-screen';
UPDATE analysis_runs SET target_stage = 'extract'    WHERE target_stage = 'm2-extract';
UPDATE analysis_runs SET target_stage = 'classify'   WHERE target_stage = 'm3-classify';
UPDATE analysis_runs SET target_stage = 'evidence'   WHERE target_stage = 'm4-evidence';
UPDATE analysis_runs SET target_stage = 'curate'     WHERE target_stage = 'm5-adjudicate';
UPDATE analysis_runs SET target_stage = 'adjudicate' WHERE target_stage = 'm6-llm-judge';

UPDATE analysis_runs SET current_stage = 'screen'     WHERE current_stage = 'pre-screen';
UPDATE analysis_runs SET current_stage = 'extract'    WHERE current_stage = 'm2-extract';
UPDATE analysis_runs SET current_stage = 'classify'   WHERE current_stage = 'm3-classify';
UPDATE analysis_runs SET current_stage = 'evidence'   WHERE current_stage = 'm4-evidence';
UPDATE analysis_runs SET current_stage = 'curate'     WHERE current_stage = 'm5-adjudicate';
UPDATE analysis_runs SET current_stage = 'adjudicate' WHERE current_stage = 'm6-llm-judge';

UPDATE analysis_run_stages SET log_path = REPLACE(log_path, '01-pre-screen.log',   '01-screen.log')     WHERE log_path LIKE '%01-pre-screen.log';
UPDATE analysis_run_stages SET log_path = REPLACE(log_path, '02-m2-extract.log',   '02-extract.log')    WHERE log_path LIKE '%02-m2-extract.log';
UPDATE analysis_run_stages SET log_path = REPLACE(log_path, '03-m3-classify.log',  '03-classify.log')   WHERE log_path LIKE '%03-m3-classify.log';
UPDATE analysis_run_stages SET log_path = REPLACE(log_path, '04-m4-evidence.log',  '04-evidence.log')   WHERE log_path LIKE '%04-m4-evidence.log';
UPDATE analysis_run_stages SET log_path = REPLACE(log_path, '05-m5-adjudicate.log','05-curate.log')     WHERE log_path LIKE '%05-m5-adjudicate.log';
UPDATE analysis_run_stages SET log_path = REPLACE(log_path, '06-m6-llm-judge.log', '06-adjudicate.log') WHERE log_path LIKE '%06-m6-llm-judge.log';
