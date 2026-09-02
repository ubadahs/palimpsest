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
  /** Seed-claim grounding via full-document LLM call (canonical Scope). */
  grounding: "grounding-2026-09-02-v2",
  /** Attributed claim extraction from citing-paper mentions. */
  extraction: "extraction-2026-09-02-v4",
  /** Cross-citer claim equivalence clustering per seed. */
  canonicalization: "canonicalization-2026-09-02-v2",
  /** Citation-role fallback for occurrences the regex pass leaves unclear. */
  roleClassification: "role-classification-2026-09-02-v1",
  /** LLM-based evidence reranking. */
  rerank: "rerank-2026-09-02-v2",
  /** Citation fidelity adjudication. */
  adjudication: "adjudication-2026-09-02-v10",
} as const;

export const LLM_PROMPT_VERSIONS = {
  /** Seed-claim grounding prompt template (canonical Scope). */
  grounding: "2026-09-02-v2",
  /** Attributed claim extraction prompt template. */
  extraction: "2026-09-02-v3",
  /** Claim equivalence clustering prompt template. */
  canonicalization: "2026-09-02-v2",
  /** Citation-role fallback prompt template. */
  roleClassification: "2026-09-02-v1",
  /** Categorical adjudication prompt template. */
  adjudication: "v4",
} as const;
