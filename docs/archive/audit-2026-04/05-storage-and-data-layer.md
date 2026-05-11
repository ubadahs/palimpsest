# Storage & Data Layer Audit

## Overall Assessment: GOOD fundamentals, needs retention policy and cleanup

SQLite with WAL mode, parameterized queries (zero SQL injection risk), and transactional migration runner. Main gaps are unbounded growth and orphaned tables.

---

## High Priority

### 1. Unbounded database growth — no retention policy
- **Files:** All storage modules
- **Severity:** HIGH
- No DELETE statements in any repository code
- `analysis_runs`, `paper_cache`, `llm_result_cache` grow indefinitely
- **Fix:** Implement retention policy: archive completed runs >90 days, evict stale paper cache >1 year, add LRU eviction for LLM cache based on `last_hit_at`

### 2. LLM result cache never evicts
- **File:** `src/storage/llm-result-cache.ts`
- `last_hit_at` column exists but no eviction logic
- **Fix:** Add `evictStaleCache(db, daysOld = 90)` function based on `last_hit_at`

### 3. Orphaned `papers` and `citations` tables
- **File:** `src/storage/migrations/0001_init.sql`
- Created in initial migration but never referenced by any repository code
- Application uses `paper_cache` and `paper_parsed` instead
- **Fix:** Remove via cleanup migration, or document why retained

---

## Medium Priority

### 4. Migration error handling lacks context
- **File:** `src/storage/migration-service.ts:68-75`
- If a migration fails, raw exception propagates without identifying which migration
- **Fix:** Wrap in try-catch: `throw new Error(\`Migration ${migration.name} failed: ${err.message}\`)`

### 5. Missing covering indexes for common query patterns
- **File:** `src/storage/analysis-runs.ts`
- `WHERE status = 'running' ORDER BY updated_at DESC` — no covering index
- `WHERE status = 'running' ORDER BY started_at ASC` — no covering index
- **Fix:** Add `CREATE INDEX idx_..._status_updated_at ON analysis_runs(status, updated_at DESC)` etc.

### 6. `listAnalysisRuns()` has no pagination
- **File:** `src/storage/analysis-runs.ts:209`
- Returns ALL runs; doesn't scale to thousands
- **Fix:** Add `LIMIT ? OFFSET ?` parameters

### 7. `getCachedLLMResult` performs write during read
- **File:** `src/storage/llm-result-cache.ts:62-87`
- Updates `last_hit_at` on every read — side effect during read operation
- **Fix:** Separate touch operation or batch deferred updates

### 8. Query results cast without validation
- **Files:** `paper-cache.ts`, `llm-result-cache.ts`
- Results from `.get()` cast to `Record<string, unknown>` without type validation
- **Fix:** Define explicit row types (like `RunRow`/`StageRow` in analysis-runs.ts) for all tables

### 9. Duplicate index definitions across migrations
- **Files:** Migrations 0004, 0006, 0007, 0009
- Same indexes (`idx_analysis_runs_updated_at`, etc.) defined multiple times
- **Fix:** Cosmetic cleanup; use `CREATE INDEX IF NOT EXISTS` in later migrations

---

## Low Priority

### 10. `updateStageStatus` + `updateRunTimestamp` not in transaction
- **File:** `src/storage/analysis-runs.ts:272-331`
- Two separate statements; brief inconsistency window possible
- **Fix:** Wrap both in a transaction (low risk for CLI tool)

### 11. Nullable foreign key undocumented
- **File:** `src/storage/migrations/0001_init.sql:16`
- `citations.cited_paper_id` is nullable FK with no cascading delete
- **Fix:** Document whether intentional

---

## Strengths (no action needed)

- **Zero SQL injection:** All queries use parameterized statements with `?` placeholders
- **WAL mode:** Concurrent reads during writes; proper for CLI concurrency
- **Transactional migrations:** Each migration wrapped in DB transaction with rollback on failure
- **Foreign keys enforced:** `PRAGMA foreign_keys = ON` in `database.ts:12`
- **CASCADE deletes:** `analysis_run_stages` cascade on parent run deletion
- **`createAnalysisRun` transactional:** Run + all stage rows created atomically
- **`markRunInterrupted` transactional:** Status updates are atomic
- **Migration idempotency:** `schema_migrations` table tracks applied migrations
- **Sequential numbering:** 0001-0010 applied in lexicographic order
