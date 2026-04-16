# Pipeline Orchestration Audit

## Overall Assessment: Well-engineered with critical handoff gap

The pipeline implements a sophisticated multi-stage flow with proper state tracking, per-family parallelization, and database-backed resume. However, handoff state loss on resume and missing artifact validation pose material risks.

---

## Critical Issues

### 1. Handoff state lost on `--run-id` resume
- **File:** `src/cli/commands/pipeline.ts:752-890`
- **Severity:** CRITICAL
- `discoveryHandoffs` (rich in-memory map from attribution-first discovery) is initialized as `undefined` on resume
- Screen stage checks `if (discoveryHandoffs && discoveryHandoffs.size > 0)` — always fails on resume
- Forces screen to take the **full path** instead of the optimized thin path, re-running DOI resolution, OpenAlex fetches, and LLM grounding
- **Fix:** Serialize `discoveryHandoffs` to disk when discover completes. Deserialize on resume before screen stage. Add warning log if handoff unavailable.

### 2. No artifact validation on resume
- **File:** `src/cli/commands/pipeline.ts:755-767`
- **Severity:** HIGH
- Loads `slFile` from disk without verifying file integrity or existence
- Corrupted or partially written JSON can propagate downstream
- **Fix:** Validate file existence + size before skipping stages. Add JSON parse check.

---

## High Priority

### 3. Excluded claim records not auditable
- **File:** `src/pipeline/attributed-claim-families.ts:33`
- Out-of-scope records silently dropped; no audit trail of excluded candidates
- **Fix:** Persist excluded records to `_excluded-candidates.json` sidecar artifact

### 4. Adjudication escalation thresholds undocumented
- **File:** `src/adjudication/llm-adjudicator.ts`
- Which confidence/verdict combinations trigger Opus escalation is not documented
- **Fix:** Document escalation logic, add unit tests for escalation decisions

---

## Medium Priority

### 5. Family consolidation can merge contradictory claims
- **File:** `src/pipeline/attributed-claim-families.ts:160-226`
- Exact normalized text match merges families regardless of support context
- e.g., "gene X regulates pathway Y" with support "X enhances Y" vs. "X inhibits Y"
- **Fix:** Validate that merged support spans are not directionally contradictory

### 6. Cost tracking: persistent cache hits not in ledger
- **File:** `src/integrations/llm-client.ts`
- Calls that hit persistent exact-result cache skip the API and are not recorded in cost ledger
- Cost summary understates efficiency gains
- **Fix:** Track skipped API calls separately; update cost summary

### 7. No schema version in artifacts
- Artifacts include `generatedAt` timestamps but no formal `schemaVersion` field
- Old artifacts fail with generic Zod parse errors after schema changes
- **Fix:** Add `schemaVersion` field to all artifact roots

---

## Strengths (no action needed)

- Stage status tracked in DB via `trackStageStart()`, `trackStageSuccess()`, `trackStageBlocked()`
- Per-family stage rows created upfront; fine-grained resume
- Concurrency safe: `pMap` with bounded workers, `nextIndex++` atomic in JS event loop
- Extraction/classification caches keyed deterministically; no collision risk
- Artifacts are immutable, stamped, and include manifest with SHA256 lineage
- Signal handler updates DB on SIGINT/SIGTERM for clean interruption
