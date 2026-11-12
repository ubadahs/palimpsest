# Caching

Caching supports the DOI-first canonical pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

It does not provide a compatibility bridge for old shortlist or seven-stage-executor artifacts.

## Persistent exact-result cache

The `llm_result_cache` SQLite table stores successful LLM responses keyed by a SHA-256 hash of canonical request data.

- Call sites opt in with an `exactCache` key version.
- The key includes purpose, resolved model, complete prompt text, thinking configuration, key version, a fingerprint of the response schema, and whether the call bypassed the cache.
- Only successful, complete responses are stored; a truncated reply is never cached.
- A hit is re-validated against the current response schema before use; a stale row that no longer parses is treated as a miss and overwritten.
- `--force-refresh` bypasses cache reads and writes.
- Changing a key version invalidates stale entries after a prompt or schema change.

Exact caching is request equality, not semantic equivalence. Different model settings produce separate keys.

## Paper materialization cache

The acquisition layer reuses raw and parsed paper materialization when valid. `--force-refresh` requests new materialization. Canonical Evidence still retrieves only over the immutable Scope seed-text blocks referenced by its input artifact; a cache does not permit substituted text.

## Provider prompt caching

Provider prompt caching is prefix-based and charges a write premium, so it is enabled only where a large prefix is genuinely shared, and only for a request that names that prefix. Scope grounding sends the seed text as a cached prefix and the per-family tracked claim as the suffix, so the seed paper is read from cache for every family after the first. Whole-paper adjudication does the same with the per-record citing side as the suffix, and holds a seed's other records back until its first request has written the cache. Extraction, canonicalization, reranking, role classification, and chunk-based adjudication prompts are unique per record and are not cached. This is distinct from the persistent exact-result cache and is subject to provider behavior.

Under `pipeline --batch` shared prefixes carry the 1-hour TTL instead of 5 minutes, since a batch can start well after the seed's first request wrote the cache; the write costs twice the input price instead of 1.25 times and is paid once per seed. Cache tokens are billed at the batch discount, but batch items run in no fixed order and often at once, so cache hits within a batch are best-effort. Batch savings on whole-paper adjudication depend on them: a missed cache makes each record pay full input for the seed text and can leave a batched record costing about 2.4 times a direct one. `cacheReadTokens` in `cost-summary.json` shows whether the hits happened. The TTL is a transport detail like `transport` itself: artifact provenance keeps the purpose's configured policy (`ephemeral:5m`). The cache-writing first request per seed is still answered before the seed's other requests are queued. The `llm_batch_requests` table is not a cache: it keeps only results already paid for and not yet handed to a caller, and deletes each row once delivered, so it never replays an answer the exact-result cache would not.

## Provenance and cutover

Cache hits and misses remain visible in run telemetry and artifact provenance. `cost-summary.json` records `cacheReadTokens` and `cacheWriteTokens` per stage and per purpose, so a prompt-caching claim can be checked from the artifacts rather than inferred from a total; a resumed run adds its attempt to the summary already on disk instead of replacing it. Every model execution in a stage artifact also carries the `thinking` configuration in force, plus `servedModel` (the snapshot that answered) and `exactCacheHit` when known. None of the three enters result identity. Migration 0013 dropped the `purpose`, `model`, and `key_version` columns from `llm_result_cache`; the key already binds all three. Paper-cache reuse requires stored acquisition provenance and a supported full-text format (`jats_xml` or `grobid_tei_xml`); pre-provenance or unsupported-format rows are treated as cache misses and re-acquired. Old local database rows or run directories from the seven-stage executor are unsupported and may be deleted/recreated; do not rely on them as reusable canonical stage state.

`db:gc` can evict stale `llm_result_cache` rows and aged analysis-run registry rows, and always deletes `llm_batch_requests` rows older than the Message Batches API's 29-day results retention, which could no longer be answered from their batch. It does not delete paper-cache rows or on-disk artifact directories. `runs:gc` handles the on-disk side: it deletes the stage attempts a `--rerun-from` superseded and the provenance blobs only those attempts referenced, leaving the current attempt of every stage, the run inputs, logs, cost summary, and human review sidecar in place.
