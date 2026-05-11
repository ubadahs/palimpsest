# External Integrations Audit

## Overall Assessment: Good security practices with validation and robustness gaps

Proper timeout handling, parameterized queries, and rate-limit awareness. Main concerns: `.passthrough()` on API schemas, no circuit breaker, GROBID has no retry/fallback, proxy URL construction is fragile.

---

## High Priority

### 1. GROBID has no retry logic or fallback
- **File:** `src/retrieval/fulltext-fetch.ts:1379-1421`
- Single attempt; no retry on transient failure; no circuit breaker
- If GROBID is down, all PDF extraction fails permanently
- **Fix:** Add retry with exponential backoff. Implement circuit breaker (fail fast after 10 consecutive failures). Consider fallback to alternative PDF parser.

### 2. Semantic Scholar API key potentially exposed in logs
- **Files:** `src/integrations/semantic-scholar.ts:172, 194, 218, 251`
- `x-api-key` header passed to `fetchJson()` via `options.headers`
- If headers are ever logged via middleware, key could leak
- **Fix:** Add `sensitiveHeaderKeys` parameter to `fetchJson()` that excludes them from any logging

### 3. No rate-limit header parsing
- **File:** `src/integrations/http-client.ts:40-80`
- Retries on 429 but ignores `Retry-After` header; uses blind exponential backoff
- Also ignores OpenAlex rate-limit headers (`X-ratelimit-remaining`)
- **Fix:** Parse `Retry-After` header from 429 responses; respect it instead of guessing

---

## Medium Priority

### 4. `.passthrough()` on all API response schemas
- **Files:** `openalex.ts:62`, `semantic-scholar.ts:36`, `fulltext-fetch.ts:119-135`
- Allows unknown fields from API responses into domain objects
- **Fix:** Replace with `.strict()` to reject unexpected fields, or explicitly whitelist extras

### 5. Proxy URL built via string concatenation
- **File:** `src/retrieval/fulltext-fetch.ts:1081-1135`
- `${prefix}${pageUrl}` — no URL parsing validation
- If `institutionalProxyUrl` is misconfigured, could create malformed URLs
- **Fix:** Validate proxy URL at configuration time using `new URL()`. Use URL API for construction.

### 6. bioRxiv response schema lacks URL validation
- **File:** `src/retrieval/fulltext-fetch.ts:119-135`
- `jatsxml` field accepted as `z.string().min(1)` but not validated as URL
- **Fix:** Use `z.string().url()` for URL fields

### 7. Proxy strategy hardcoded (EZproxy only)
- **File:** `src/retrieval/fulltext-fetch.ts:1221-1255`
- Different proxy services (EZproxy, WAM, custom) have different URL conventions
- **Fix:** Add `proxyStrategy` configuration or document expected format

### 8. No jitter in exponential backoff
- **File:** `src/integrations/http-client.ts:49, 70`
- `sleep(RETRY_BASE_MS * 2 ** attempt)` — simultaneous failures create thundering herd
- **Fix:** Add `Math.random() * 500` jitter

### 9. PMC ID regex prone to false positives
- **File:** `src/retrieval/fulltext-fetch.ts:144-150`
- `/\bPMC\d+\b/i` could match "PMC" in URLs, not just actual PMC IDs
- **Fix:** Require 6-7 digits: `/\bPMC(\d{6,7})\b/i`

---

## Low Priority

### 10. OpenAlex pagination hardcoded to 5-10 results
- **Files:** `openalex.ts:275, 343, 411`
- Metadata searches return only first 5-10; intended paper may not appear
- **Fix:** Consider `per_page=50` for initial metadata searches

### 11. Error messages lack detail for debugging
- **File:** `src/integrations/http-client.ts:55, 63, 78`
- Only URL included; no status code detail or response body snippet
- **Fix:** Include content-type and first 200 chars of response body

### 12. Timeout inconsistency (10s default vs. 30s for full-text)
- Default timeout 10s for API calls, 30s for full-text downloads
- Reasonable but undocumented
- **Fix:** Document timeout assumptions per endpoint type

### 13. User-Agent version hardcoded
- **File:** `src/integrations/http-client.ts:15`
- `palimpsest/0.1` — won't update as project evolves
- **Fix:** Read from `package.json` at runtime

### 14. Paper resolver fallback chain is sequential (latency)
- **File:** `src/integrations/paper-resolver.ts:12-105`
- OpenAlex first, then Semantic Scholar on failure
- **Fix:** Consider `Promise.all()` race strategy to avoid sequential latency

### 15. Cached JSON parsed without try-catch in LLM client
- **File:** `src/integrations/llm-client.ts:857`
- `JSON.parse(cached.responseText)` can crash on corrupted cache
- **Fix:** Wrap in try-catch; fall back to fresh API call on parse failure

---

## Strengths (no action needed)

- All external API responses Zod-validated before entering domain layer
- HTTP client has proper exponential backoff retry (500ms, 1s, 2s) for 429/5xx
- Default 10-second timeout with configurable override
- `User-Agent` header sent on all requests (required by academic APIs)
- Adapter interfaces clean for dependency injection
- OpenAlex email parameter properly URI-encoded
- Semantic Scholar API key passed via headers (not URL query)
- Full-text acquisition tracks all attempts in structured provenance
- Paper resolver provides `resolutionProvenance` for debugging
