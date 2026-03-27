CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  title TEXT,
  authors_json TEXT,
  abstract TEXT,
  full_text TEXT,
  full_text_status TEXT,
  source TEXT,
  fetch_status TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citing_paper_id TEXT NOT NULL,
  cited_paper_id TEXT,
  citation_key TEXT,
  context_passage TEXT,
  citing_span TEXT,
  attributed_claim TEXT,
  auditability_status TEXT,
  auditability_reason TEXT,
  cited_span TEXT,
  cited_span_section TEXT,
  citation_function TEXT,
  fidelity_top TEXT,
  fidelity_subtype TEXT,
  fidelity_rationale TEXT,
  evidence_vs_interpretation TEXT,
  confidence TEXT,
  eligibility_status TEXT,
  review_status TEXT,
  FOREIGN KEY (citing_paper_id) REFERENCES papers (id),
  FOREIGN KEY (cited_paper_id) REFERENCES papers (id)
);

CREATE INDEX IF NOT EXISTS idx_citations_citing_paper_id
  ON citations (citing_paper_id);

CREATE INDEX IF NOT EXISTS idx_citations_cited_paper_id
  ON citations (cited_paper_id);

CREATE INDEX IF NOT EXISTS idx_citations_auditability_status
  ON citations (auditability_status);
