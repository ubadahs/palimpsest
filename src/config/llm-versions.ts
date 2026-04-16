/**
 * Central registry of LLM prompt and cache key versions.
 *
 * When you change a prompt template or output schema, bump the corresponding
 * cache key version here. This auto-invalidates stale exact-result cache
 * entries so that re-runs use the updated prompt.
 *
 * Each module still imports its version from this file — search for usages
 * to find all affected call sites.
 */
export const LLM_CACHE_VERSIONS = {
  /** Seed-claim grounding via full-document LLM call. */
  grounding: "grounding-2026-04-11-v1",
  /** Attributed claim extraction from citing-paper mentions. */
  extraction: "extraction-2026-04-11-v1",
  /** LLM-based evidence reranking. */
  rerank: "rerank-2026-04-11-v1",
  /** Citation fidelity adjudication. */
  adjudication: "adjudication-2026-04-14-v8",
} as const;

export const LLM_PROMPT_VERSIONS = {
  /** Claim discovery from seed paper sections. */
  discovery: "2026-04-07-v1",
  /** Seed-claim grounding prompt template. */
  grounding: "2026-04-06-v1",
  /** Attributed claim extraction prompt template. */
  extraction: "2026-04-08-v1",
} as const;
