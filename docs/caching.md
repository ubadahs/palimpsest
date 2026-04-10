# Caching

Anthropic prompt caching is always enabled for eligible LLM purposes.

## What is cached today

- `seed-grounding` is the main cached workflow.
- It uses a **cached prefix** for the long, shared manuscript context and an **uncached suffix** for the claim-specific question.
- This is intentional: the manuscript is reused across many grounding calls for the same seed paper, while the tracked claim changes per call.
- `attributed-claim-extraction` and `claim-family-filter` still use the simpler prompt-level cache policy.

## What is not cached today

- `evidence-rerank`
- `adjudication`

Those stages are currently left uncached because their prompts are dominated by request-specific context. In earlier experiments, they produced cache creation overhead without enough cache reads to become a cost win.

## How it works

For regular prompt-level caching, the shared LLM client applies Anthropic `cache_control` only when:

- the purpose has a default cache policy, and
- the cacheable text is long enough for Anthropic's minimum cacheable-token threshold.

For `seed-grounding`, the client sends the request as two user text parts:

1. cached prefix: instructions + seed metadata + full manuscript
2. uncached suffix: the tracked claim to evaluate

This layout is more cache-friendly than a single monolithic prompt because the repeated manuscript stays in the prefix and the varying claim stays in the tail.

## Reading telemetry

Anthropic usage is surfaced in run artifacts and telemetry as:

- `cacheWriteTokens`: tokens used to create a cache entry
- `cacheReadTokens`: tokens served from an existing cache entry

The goal is to see reuse-heavy stages produce meaningful `cacheReadTokens`, not just `cacheWriteTokens`.
