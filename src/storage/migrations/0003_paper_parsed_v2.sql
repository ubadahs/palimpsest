ALTER TABLE paper_parsed
  ADD COLUMN parser_kind TEXT;

ALTER TABLE paper_parsed
  ADD COLUMN content_hash TEXT;

ALTER TABLE paper_parsed
  ADD COLUMN mentions_json TEXT;
