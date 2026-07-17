-- Clean break from the pre-canonical seven-stage executor.
-- Purge obsolete analysis_runs / analysis_run_stages rows that cannot be
-- resumed by the six-stage canonical pipeline. Paper/LLM caches and on-disk
-- run directories under data/runs/ are intentionally preserved.

DELETE FROM analysis_run_stages
WHERE run_id IN (
  SELECT DISTINCT run_id
  FROM analysis_run_stages
  WHERE stage_key NOT IN (
    'discover',
    'scope',
    'prepare',
    'evidence',
    'adjudicate',
    'report'
  )
);

DELETE FROM analysis_runs
WHERE id NOT IN (SELECT DISTINCT run_id FROM analysis_run_stages)
   OR target_stage NOT IN (
     'discover',
     'scope',
     'prepare',
     'evidence',
     'adjudicate',
     'report'
   )
   OR config_json LIKE '%"adjudicateAdvisor"%'
   OR config_json LIKE '%"adjudicationMode"%'
   OR config_json LIKE '%"shortlist"%'
   OR config_json LIKE '%"strategy"%'
   OR config_json LIKE '%"manualClaims"%'
   OR config_json LIKE '%"discoveryStrategy"%';
