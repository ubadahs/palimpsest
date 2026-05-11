# Error Handling & Resilience Audit

## Overall Assessment: Solid Result<T> pattern with critical gaps in JSON parsing and degradation

The `Result<T>` type is well-defined and widely used. However, fragile JSON extraction, missing circuit breakers, and transient failures being treated as permanent are high-risk issues.

---

## Critical Issues

### 1. Fragile JSON extraction from LLM output
- **File:** `src/shared/extract-json-from-text.ts`
- **Severity:** CRITICAL
- If LLM returns non-JSON text without braces, the entire text is returned to `JSON.parse()` — guaranteed failure
- Affects all LLM-dependent pipelines (claim-discovery, adjudication, reranking)
- **Fix:** Return `Result<string>` instead of raw string. Validate extracted JSON before returning. Return error if no JSON delimiters found.

### 2. Transient failures permanently deprioritize families
- **File:** `src/pipeline/pre-screen.ts:175-187`
- **Severity:** CRITICAL
- If seed paper full-text is temporarily unavailable (transient network error), family is permanently marked `"deprioritize"`
- **Fix:** Distinguish transient (network, timeout) from permanent (404, auth) failures. Mark transient as `"retry"`. Implement retry loop at run level.

---

## High Priority

### 3. No handling for LLM token overflow (`finish_reason === "length"`)
- **File:** `src/integrations/llm-client.ts:627-699`
- `finishReason` captured but not classified; truncated responses parsed as if complete
- **Fix:** Check `finishReason`, flag truncated responses, retry with higher token budget or summarized input

### 4. No circuit breaker for external APIs
- **Files:** `src/integrations/openalex.ts`, `semantic-scholar.ts`
- If service is down, every record retries individually (3 attempts x N records)
- 1000 papers against a down service = 3000 wasted requests
- **Fix:** Implement circuit breaker: after 10 consecutive failures, skip service for 5 minutes

### 5. Generic Zod validation errors (only first issue reported)
- **Files:** `claim-discovery.ts:162`, `attributed-claim-extraction.ts:129`, `llm-adjudicator.ts:268`
- Only `result.error.issues[0]` reported; subsequent validation errors lost
- **Fix:** Return all validation errors joined: `issues.map(i => \`${i.path.join(".")}: ${i.message}\`).join("; ")`

### 6. `loadJsonArtifact` throws instead of returning Result
- **File:** `src/shared/artifact-io.ts:73-102`
- Breaks the Result pattern; call sites must handle exceptions
- File-not-found produces raw Node.js ENOENT error
- **Fix:** Return `Result<T>`. Catch ENOENT specifically with helpful message.

---

## Medium Priority

### 7. LLM exceptions break Result pattern
- **File:** `src/integrations/llm-client.ts:783-837`
- LLM calls throw `LLMProviderError` instead of returning Result
- Inconsistent with HTTP client's Result pattern
- **Fix:** Document intentional difference, or unify error handling pattern

### 8. Overly broad catch blocks
- **Files:** `seed-claim-grounding-llm.ts:264`, `claim-discovery.ts:158`, `attributed-claim-extraction.ts:128`
- Bare `catch (err)` catches all exception types without discrimination
- **Fix:** Catch specific types (`SyntaxError` for JSON parsing). Re-throw unexpected types.

### 9. Adjudication failures return fallback without retry
- **File:** `src/adjudication/llm-adjudicator.ts:409-427`
- LLM error → immediate `cannot_determine` verdict with no retry or escalation
- **Fix:** Distinguish retryable vs. fatal errors. Implement exponential backoff for transient failures.

### 10. GROBID errors not distinguished from PDF fetch errors
- **File:** `src/retrieval/fulltext-fetch.ts:1415-1420`
- "GROBID service down" vs. "invalid PDF" treated identically
- **Fix:** Return structured error with `errorKind` field

### 11. Silent error swallowing in cache writes
- **File:** `src/retrieval/fulltext-fetch.ts:1328-1330`
- Bare `catch {}` — no logging even for debugging
- **Fix:** Log cache write failures even if non-fatal

### 12. No centralized error telemetry
- Across all files: errors captured per-record but no centralized error log
- Failed runs require parsing artifact JSON to diagnose
- **Fix:** Create structured `ErrorLog` class that collects entries with stage, kind, message, retryable flag. Write to `{runDir}/error-log.json`.

---

## Low Priority

### 13. Error messages lack remediation guidance
- "HTTP 429" doesn't suggest waiting; "Schema validation failed" doesn't show expected format
- **Fix:** Add context: "Service rate-limited. Retry in 60s or reduce --probe-budget"

### 14. No path traversal validation on CLI inputs
- User can pass `--input ../../etc/passwd`
- **Fix:** Validate paths are within expected working directory (low risk for local CLI)

### 15. Bundled citation proximity detection can be inaccurate
- 80-character window may incorrectly bundle unrelated citations
- **Fix:** Tune proximity threshold based on paragraph length

---

## Strengths (no action needed)

- `Result<T>` well-defined in `src/domain/common.ts` and used across 20+ files
- HTTP client (`http-client.ts`) has proper retry logic with exponential backoff (500ms, 1s, 2s)
- Full-text acquisition has multi-strategy fallback chain (bioRxiv → PMC → PDF → landing page → proxy)
- Evidence retrieval degrades gracefully to BM25 when LLM reranking fails
- `LLMProviderError` classifies errors (fatal vs. retryable) correctly
- Empty inputs, missing DOIs, papers with no full text all handled with appropriate status codes
