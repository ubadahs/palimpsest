-- Requests sent through the Message Batches API (`pipeline --batch`).
-- A submitted batch is billed whether or not this process lives to read it,
-- so each request's custom_id (a hash of its exact body and headers) is kept
-- with its batch id. A later run that sends the same request takes that
-- batch's result instead of paying for it again. `result_json` holds a result
-- that arrived after its caller was gone; NULL means the batch had not ended
-- when last seen. A row is deleted once its result is handed to a caller.

CREATE TABLE llm_batch_requests (
  custom_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  result_json TEXT
);

CREATE INDEX idx_llm_batch_requests_batch ON llm_batch_requests(batch_id);
