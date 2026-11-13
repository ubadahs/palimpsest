-- Verified seed codebooks, frozen once per seed text and procedure version.
-- Scope reuses a stored codebook whenever the key matches, so a codebook's
-- entries stay fixed across runs even as the citer list changes. This is not
-- a cache: db:gc never deletes it, and --force-refresh does not replace it.
-- Only `pipeline --regenerate-codebook` overwrites a row.

CREATE TABLE seed_codebooks (
  seed_id TEXT NOT NULL,
  seed_text_hash TEXT NOT NULL,
  procedure_version TEXT NOT NULL,
  codebook_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (seed_id, seed_text_hash, procedure_version)
);
