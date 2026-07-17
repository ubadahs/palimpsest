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

Eligible Anthropic calls can use provider prompt caching to reduce repeated-input cost. This is distinct from the persistent exact-result cache and is subject to provider behavior.

## Provenance and cutover

Cache hits and misses remain visible in run telemetry and artifact provenance. Old local database rows or run directories from the seven-stage executor are unsupported and may be deleted/recreated; do not rely on them as reusable canonical stage state.
