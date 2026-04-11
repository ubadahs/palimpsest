-- Persistent exact-result cache for LLM calls.
-- Keyed by SHA-256 of canonical request data (purpose, model, prompt, thinking config,
-- schema version). Only successful responses are stored. forceRefresh bypasses reads/writes.

CREATE TABLE llm_result_cache (
  cache_key TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  key_version TEXT NOT NULL,
  response_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_hit_at TEXT
);

CREATE INDEX idx_llm_result_cache_purpose ON llm_result_cache(purpose);
