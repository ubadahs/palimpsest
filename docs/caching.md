# Caching

Caching supports the DOI-first pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

## Persistent exact-result cache

The `llm_result_cache` SQLite table stores successful LLM responses keyed by a SHA-256 hash of canonical request data.

- Call sites opt in with their prompt version (`PROMPT_VERSIONS` in `src/config/prompt-versions.ts`) as the key version.
- The key includes purpose, resolved model, complete prompt text, thinking effort, prompt version, a fingerprint of the response schema, and whether the call bypassed the cache.
- Only successful, complete responses are stored; a truncated reply is never cached.
- A hit is re-validated against the current response schema before use; a stale row that no longer parses is treated as a miss and overwritten.
- `--force-refresh` bypasses cache reads and writes.
- Bumping a prompt version invalidates stale entries after a prompt or schema change.

Exact caching is request equality, not semantic equivalence. Different model settings produce separate keys.

## Seed codebook store

The `seed_codebooks` table (migration 0015) holds each verified seed codebook, keyed by seed id, a content hash of the seed-text blocks, and the codebook procedure version (`SEED_CODEBOOK_PROCEDURE_VERSION`, which is `PROMPT_VERSIONS.seedCodebook`). It is scientific state, not a cache: Scope reuses a stored codebook whenever the key matches, so codebook entries, and the per-entry rows of every Report built on them, stay fixed across runs of the same seed even as the citer list changes. The exact-result cache could not do this job: `db:gc` evicts it, and a changed prompt would silently regroup every claim. So:

- `db:gc` never deletes a stored codebook.
- `--force-refresh` does not replace one: refreshing paper inputs is a different intent from regrouping every claim. Its codebook calls bypass the exact-result cache only if a codebook is actually generated.
- `pipeline --regenerate-codebook` is the only way to replace one. It asks the model again, skipping the exact-result cache read, and overwrites both the stored row and the cached replies. It needs Scope to run in that invocation (`--rerun-from scope` on a resume).
- A new seed text or procedure version is a new key, so it generates. A changed `scope.codebookModel` alone does not.

Codebook tagging uses the exact-result cache like any other call (`PROMPT_VERSIONS.codebookTagging`), and the stored codebook is part of its prompt, so the same claim text against the same codebook gets the same tags across runs.

## Paper materialization cache

The acquisition layer reuses raw and parsed paper materialization when valid. `--force-refresh` requests new materialization. Evidence still retrieves only over the immutable Scope seed-text blocks referenced by its input artifact; a cache does not permit substituted text.

## Provider prompt caching

Provider prompt caching is prefix-based and charges a write premium, so it is enabled only where a large prefix is genuinely shared, and only for a request that names that prefix. Scope grounding sends the seed text as a cached prefix and the family claim as the suffix, so the seed paper is read from cache for every family after the first. The three seed-codebook calls share one seed-text prefix and run in order, so the second and third read the cache the first wrote; codebook tagging sends the seed's codebook as the prefix and one claim as the suffix, its first request per seed alone. Whole-paper adjudication does the same with the per-record citing side as the suffix, and holds a seed's other records back until its first request has written the cache. Extraction, clustering, reranking, role classification, and chunk-based adjudication prompts are unique per record and are not cached. This is distinct from the persistent exact-result cache and is subject to provider behavior.

Under `pipeline --batch` shared prefixes carry the 1-hour TTL instead of 5 minutes, since a batch can start well after the seed's first request wrote the cache; the write costs twice the input price instead of 1.25 times and is paid once per seed. Cache tokens are billed at the batch discount, but batch items run in no fixed order and often at once, so cache hits within a batch are best-effort. Batch savings on whole-paper adjudication depend on them: a missed cache makes each record pay full input for the seed text and can leave a batched record costing about 2.4 times a direct one. `cacheReadTokens` in `cost-summary.json` shows whether the hits happened. The TTL is a transport detail like `transport` itself: artifact provenance keeps the purpose's configured policy (`ephemeral:5m`). The cache-writing first request per seed is still answered before the seed's other requests are queued. The `llm_batch_requests` table is not a cache: it keeps only results already paid for and not yet handed to a caller, and deletes each row once delivered, so it never replays an answer the exact-result cache would not.

## Provenance

Cache hits and misses remain visible in run telemetry and artifact provenance. `cost-summary.json` records `cacheReadTokens` and `cacheWriteTokens` per stage and per purpose, so a prompt-caching claim can be checked from the artifacts rather than inferred from a total; a resumed run adds its attempt to the summary already on disk instead of replacing it. Every model execution in a stage artifact also carries the thinking `effort` in force, plus `servedModel` (the snapshot that answered) and `exactCacheHit` when known. None of the three enters result identity. Paper-cache reuse requires stored acquisition provenance and a supported full-text format (`jats_xml` or `grobid_tei_xml`); pre-provenance or unsupported-format rows are treated as cache misses and re-acquired.

`db:gc` can evict stale `llm_result_cache` rows and aged analysis-run registry rows, and always deletes `llm_batch_requests` rows older than the Message Batches API's 29-day results retention, which could no longer be answered from their batch. It does not delete paper-cache rows, stored seed codebooks, or on-disk artifact directories. `runs:gc` handles the on-disk side: it deletes the stage attempts a `--rerun-from` superseded and the provenance blobs only those attempts referenced, leaving the current attempt of every stage, the run inputs, logs, cost summary, and human review sidecar in place.
