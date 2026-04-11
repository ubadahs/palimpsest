# Caching

There are two independent caching layers. They serve different purposes and work together.

## 1. Anthropic prompt caching (provider-level)

Anthropic prompt caching is always enabled for eligible LLM purposes. It reduces input token costs within a short TTL window when the same prompt prefix is sent repeatedly.

### What is cached

- `seed-grounding` uses a **cached prefix** (instructions + seed metadata + full manuscript) and an **uncached suffix** (the tracked claim). The manuscript is reused across many grounding calls for the same seed paper.
- `attributed-claim-extraction` and `claim-family-filter` use the simpler prompt-level cache policy.

### What is not prompt-cached

- `evidence-rerank` and `adjudication` — their prompts are dominated by request-specific context, so cache creation overhead exceeds reads.

### How it works

The shared LLM client applies Anthropic `cache_control` only when:

- the purpose has a default cache policy, and
- the cacheable text is long enough for Anthropic's minimum cacheable-token threshold.

For `seed-grounding`, the client sends the request as two user text parts:

1. cached prefix: instructions + seed metadata + full manuscript
2. uncached suffix: the tracked claim to evaluate

## 2. Persistent exact-result cache (SQLite)

A dedicated `llm_result_cache` table stores successful LLM responses keyed by SHA-256 over the canonical request data. Identical reruns return the same response without hitting the provider at all.

### How it works

- Each call site opts in by passing `exactCache: { keyVersion }` to `generateText` / `generateObject`.
- The cache key is computed from: `purpose`, resolved model id, full prompt text, thinking config, and a purpose-specific `keyVersion` string.
- Only successful responses are cached. Failures, partial parses, and results from mismatched prompt/schema versions are never stored.
- `forceRefresh` / `--force-refresh` bypasses both reads and writes.
- Bumping a call site's `keyVersion` constant auto-invalidates stale entries when prompt templates or output schemas change.

### Enabled call sites

| Purpose | Module | Status |
|---------|--------|--------|
| `evidence-rerank` | `src/retrieval/llm-reranker.ts` | Enabled |
| `adjudication` | `src/adjudication/llm-adjudicator.ts` | Enabled |
| `seed-grounding` | `src/pipeline/seed-claim-grounding-llm.ts` | Enabled |
| `attributed-claim-extraction` | `src/pipeline/attributed-claim-extraction.ts` | Enabled |

### Non-goals for this layer

- No semantic equivalence reuse — reuse is exact-request only.
- No cross-model cache sharing — a different model produces a different cache key.
- No TTL or eviction — entries persist until the database is cleared or key versions are bumped.

## Reading telemetry

Anthropic prompt caching usage:

- `cacheWriteTokens`: tokens used to create a provider cache entry
- `cacheReadTokens`: tokens served from an existing provider cache entry

Exact-result cache usage:

- `exactCacheHit`: boolean on each `LLMCallRecord` when the response came from the persistent cache
- `totalExactCacheHits`: run-level aggregate in `LLMRunLedger` and `*_run-cost.json`
- `byPurpose[purpose].exactCacheHits`: per-purpose aggregate
