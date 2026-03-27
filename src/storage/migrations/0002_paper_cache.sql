-- Raw fetched content
CREATE TABLE IF NOT EXISTS paper_cache (
  paper_id TEXT PRIMARY KEY,
  doi TEXT,
  openalex_id TEXT,
  pmcid TEXT,
  title TEXT NOT NULL,
  authors_json TEXT,
  access_status TEXT NOT NULL,
  raw_full_text TEXT,
  full_text_format TEXT,
  fetch_source_url TEXT,
  fetch_status TEXT NOT NULL,
  content_hash TEXT,
  fetched_at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_paper_cache_doi ON paper_cache (doi);

-- Parsed structure (derived from raw text, versioned)
CREATE TABLE IF NOT EXISTS paper_parsed (
  paper_id TEXT PRIMARY KEY,
  parser_version TEXT NOT NULL,
  sections_json TEXT,
  refs_json TEXT,
  chunks_json TEXT,
  parsed_at TEXT NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES paper_cache (paper_id)
);

-- Provisional derived artifacts (never treated as authoritative truth)
CREATE TABLE IF NOT EXISTS derived_artifacts (
  artifact_id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  generator TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_span_ids_json TEXT,
  confidence TEXT,
  status TEXT NOT NULL DEFAULT 'provisional',
  content TEXT NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES paper_cache (paper_id)
);

CREATE INDEX IF NOT EXISTS idx_derived_artifacts_paper
  ON derived_artifacts (paper_id);
