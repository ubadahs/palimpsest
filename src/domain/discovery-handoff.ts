/**
 * In-memory rich handoff produced by attribution-first discovery and consumed
 * by downstream stages (screen, extract) to avoid redundant I/O and LLM calls.
 *
 * This type is never serialized as an artifact contract — it exists only within
 * a single pipeline run. Sidecar JSON artifacts remain the canonical, inspectable
 * record of discovery work.
 *
 * Structure:
 *   - One `DiscoveryHandoff` per seed DOI.
 *   - All families from the same DOI share the same `resolvedPaper`,
 *     `citingPapersRaw`, and `mentionsByPaperId`.
 *   - Per-family grounding is looked up via `groundingByFamilyId`.
 */

import type { HarvestedSeedMention, ResolvedPaper } from "./types.js";
import type { FamilyGroundingTrace } from "./family-grounding-trace.js";

export type DiscoveryHandoff = {
  doi: string;

  /** Resolved seed paper metadata. */
  resolvedPaper: ResolvedPaper;

  /**
   * All citing papers from OpenAlex at discovery time (up to the discovery
   * fetch limit, typically 200). This is larger than the screen fetch limit (50)
   * and allows the thin screen path to skip its own OpenAlex call while covering
   * more of the neighborhood.
   *
   * The list is ordered as returned by OpenAlex (newest first within availability
   * tier). Pre-dedup count equals `citingPapersRaw.length`.
   */
  citingPapersRaw: ResolvedPaper[];

  /**
   * Mentions pre-harvested during discovery, keyed by citing-paper ID.
   * Only papers that were selected for probing are present.
   * Papers outside the probe set (e.g. beyond probeBudget or lacking full text)
   * will not have an entry — the extract stage must fall back to full harvest
   * for those.
   */
  mentionsByPaperId: Map<string, HarvestedSeedMention[]>;

  /**
   * Per-family grounding traces, keyed by familyId.
   * Thin screen uses these instead of re-running LLM grounding.
   */
  groundingByFamilyId: Map<string, FamilyGroundingTrace>;
};

/** Map from seed DOI → DiscoveryHandoff. One entry per discovered DOI. */
export type DiscoveryHandoffMap = Map<string, DiscoveryHandoff>;
