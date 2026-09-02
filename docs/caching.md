# Caching

Caching supports the DOI-first canonical pipeline:

```text
discover → scope → prepare → evidence → adjudicate → report
```

It does not provide a compatibility bridge for old shortlist or seven-stage-executor artifacts.

## Persistent exact-result cache

The `llm_result_cache` SQLite table stores successful LLM responses keyed by a SHA-256 hash of canonical request data.

- Call sites opt in with an `exactCache` key version.
- The key includes purpose, resolved model, complete prompt text, thinking configuration, and key version.
- Only successful responses are stored.
- `--force-refresh` bypasses cache reads and writes.
- Changing a key version invalidates stale entries after a prompt or schema change.

Exact caching is request equality, not semantic equivalence. Different model settings produce separate keys.

## Paper materialization cache

The acquisition layer reuses raw and parsed paper materialization when valid. `--force-refresh` requests new materialization. Canonical Evidence still retrieves only over the immutable Scope seed-text blocks referenced by its input artifact; a cache does not permit substituted text.

## Provider prompt caching

Provider prompt caching is prefix-based and charges a write premium, so it is enabled only where a large prefix is genuinely shared: Scope grounding sends the seed text as a cached prefix and the per-family tracked claim as the suffix, so the seed paper is read from cache for every family after the first. Extraction, reranking, and adjudication prompts are unique per record and are not cached. This is distinct from the persistent exact-result cache and is subject to provider behavior.

## Provenance and cutover

Cache hits and misses remain visible in run telemetry and artifact provenance. `cost-summary.json` records `cacheReadTokens` and `cacheWriteTokens` per stage and per purpose, so a prompt-caching claim can be checked from the artifacts rather than inferred from a total; a resumed run adds its attempt to the summary already on disk instead of replacing it. Every model execution in a stage artifact also carries `servedModel` (the snapshot that answered), `exactCacheHit`, and the `thinking` configuration in force. None of the three enters result identity. Paper-cache reuse requires stored acquisition provenance and a supported full-text format (`jats_xml` or `grobid_tei_xml`); pre-provenance or unsupported-format rows are treated as cache misses and re-acquired. Old local database rows or run directories from the seven-stage executor are unsupported and may be deleted/recreated; do not rely on them as reusable canonical stage state.

`db:gc` can evict stale `llm_result_cache` rows and aged analysis-run registry rows. It does not delete paper-cache rows or on-disk artifact directories. `runs:gc` handles the on-disk side: it deletes the stage attempts a `--rerun-from` superseded and the provenance blobs only those attempts referenced, leaving the current attempt of every stage, the run inputs, logs, cost summary, and human review sidecar in place.
