# LLM Integration & Prompts Audit

## Overall Assessment: Strong centralized design with cache safety and cost tracking gaps

The centralized LLM client is well-designed with comprehensive telemetry and purpose-based cost attribution. However, cache key safety, missing retry logic, and prompt quality issues need attention.

---

## Critical Issues

### 1. Cache key does not include output schema
- **File:** `src/storage/llm-result-cache.ts:36-46`
- **Severity:** CRITICAL
- Key computed from (purpose, model, prompt, thinkingConfig, keyVersion) — but NOT the Zod output schema
- For `generateObject()`, same prompt + different schema = same cache key = wrong data served
- **Fix:** Include schema serialization (`JSON.stringify(schema._def)`) in cache key computation

### 2. Adjudication prompts risk context window overflow
- **File:** `src/adjudication/llm-adjudicator.ts:63-189`
- **Severity:** CRITICAL
- No prompt size check before calling LLM. Evidence spans + rubric + context + claim text concatenated without limit
- If user misconfigures to Haiku (100K context) for advisor mode, large evidence records will fail
- **Fix:** Add prompt size assertion; truncate evidence spans more aggressively if needed

### 3. Full document manuscripts can exceed context limits
- **File:** `src/pipeline/seed-claim-grounding-llm.ts:52-56`
- **Severity:** HIGH
- `buildSeedFullTextForLlm()` concatenates ALL blocks without truncation
- 50-page PDF = 100KB+ = 250K+ tokens, exceeding model limits
- **Fix:** Add document truncation with `MAX_DOCUMENT_CHARS = 150_000` and feedback logging

---

## High Priority

### 4. No retry logic for transient LLM failures
- **File:** `src/integrations/llm-client.ts` (entire client)
- On rate limit (429) or network error, immediately throws `LLMProviderError`
- Classification is correct (fatal vs. non-fatal) but not used for retry
- **Fix:** Implement exponential backoff for non-fatal errors, or document that callers must implement retry

### 5. Prompt caching not enabled for adjudication stage
- **File:** `src/integrations/llm-client.ts:333-348`
- `DEFAULT_PROMPT_CACHE_POLICIES` only covers seed-grounding, extraction, family-filter
- Adjudication (Opus, large evidence blocks, high cost) not cached
- **Fix:** Enable ephemeral 5m cache for adjudication (5KB+ prompts). Potential 20-40% cost savings.

### 6. Prompt injection risk in grounding suffix
- **File:** `src/pipeline/seed-claim-grounding-llm.ts:180-188`
- Analyst claim interpolated directly into prompt without escaping
- Adversarial claim text could manipulate LLM behavior
- **Fix:** Wrap claims in XML-style delimiters or escape brackets

### 7. Cost double-counting in advisor adjudication
- **File:** `src/adjudication/llm-adjudicator.ts:471-559`
- Two-pass telemetry (first pass + escalation) sums both costs; escalated records counted twice
- Reported cost inflated by 25-75% on escalation-heavy runs
- **Fix:** Track first-pass and escalation costs separately; subtract escalated records from first-pass total

---

## Medium Priority

### 8. Claim discovery model undersized (Haiku default)
- **File:** `src/pipeline/claim-discovery.ts:202`
- Complex extraction task (reading entire sections, distinguishing own claims vs. citations) defaults to Haiku
- Higher error rates lead to downstream cascading failures
- **Fix:** Change default to Sonnet. Keep Haiku as CLI override for prototyping.

### 9. Greedy JSON extraction captures trailing noise
- **File:** `src/shared/extract-json-from-text.ts`
- Regex `/\{[\s\S]*\}/` matches first `{` to last `}` — captures multiple JSON objects if LLM includes examples
- **Fix:** Prefer fenced code blocks; fall back to first complete object only

### 10. Zod validation inconsistently uses safeParse vs parse
- `claim-discovery.ts` uses `safeParse()` (correct), but `family-consolidation.ts` uses `.parse()` directly without try-catch
- **Fix:** Use `safeParse()` consistently; handle errors gracefully

### 11. Manual cache invalidation fragile
- Version strings like `"adjudication-2026-04-14-v8"` must be manually bumped when prompts change
- **Fix:** Add content-addressable hashing of prompt text into cache key, or at minimum add prominent comments warning to bump version

### 12. No cost budget enforcement
- No mechanism to cap or warn on runaway LLM costs
- **Fix:** Add optional `costBudgetUsd` parameter to LLM client options

---

## Model Selection Assessment

| Purpose | Current Model | Assessment |
|---------|--------------|------------|
| claim-discovery | Haiku 4.5 | **Undersized** — complex extraction, use Sonnet |
| seed-grounding | Sonnet 4.6 | Appropriate |
| claim-family-filter | Haiku 4.5 | Appropriate |
| evidence-rerank | Haiku 4.5 | Appropriate |
| attributed-claim-extraction | Haiku 4.5 | Borderline — complex scoping, consider Sonnet |
| adjudication | Opus 4.6 + thinking | Appropriate |
| family-consolidation | Opus 4.6 + thinking | Appropriate |

---

## Strengths (no action needed)

- Centralized `createLLMClient()` factory with consistent configuration
- Comprehensive `LLMCallRecord` telemetry (purpose, model, tokens, cache, latency, cost)
- Purpose-based cost attribution enables per-stage tracking via `getLedger()`
- `classifyProviderError()` distinguishes fatal (auth, billing) from retryable (rate limit, network)
- Ephemeral prompt caching with mode-specific policies (5m/1h TTL)
- Exact-result cache with SHA-256 keying and version-based invalidation
