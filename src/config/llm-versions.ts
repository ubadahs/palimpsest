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
  roleClassification: "role-classification-2026-09-23-v2",
  /** LLM-based evidence reranking. */
  rerank: "rerank-2026-09-02-v2",
  /** Citation fidelity adjudication. */
  adjudication: "adjudication-2026-09-23-v11",
  /** Seed codebook procedure calls (canonical Scope). */
  seedCodebook: "seed-codebook-2026-11-12-v2",
  /** One citing claim tagged against its seed codebook (canonical Scope). */
  codebookTagging: "codebook-tagging-2026-11-12-v1",
} as const;

export const LLM_PROMPT_VERSIONS = {
  /** Seed-claim grounding prompt template (canonical Scope). */
  grounding: "2026-09-02-v2",
  /** Attributed claim extraction prompt template. */
  extraction: "2026-09-02-v3",
  /** Claim equivalence clustering prompt template. */
  canonicalization: "2026-09-02-v2",
  /** Citation-role fallback prompt template. */
  roleClassification: "2026-09-23-v2",
  /** Categorical adjudication prompt template. */
  adjudication: "v5",
  /** Whole-seed-text adjudication prompt template. */
  seedTextAdjudication: "v1",
  /**
   * Seed codebook procedure prompts. The stored codebook is keyed by
   * `SEED_CODEBOOK_PROCEDURE_VERSION`, which must be bumped with this.
   */
  seedCodebook: "2026-11-12-v2",
  /** Codebook tagging prompt template. */
  codebookTagging: "2026-11-12-v1",
} as const;
