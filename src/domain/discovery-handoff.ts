/**
 * Rich handoff produced by attribution-first discovery and consumed by
 * downstream stages (screen, extract) to avoid redundant I/O and LLM calls.
 *
 * During a fresh pipeline run this travels in memory. The pipeline also persists
 * it under `inputs/discovery-handoffs.json` so `--run-id` resume can recover the
 * thin screen path when that file is available. Stage primary JSON artifacts
 * remain the canonical downstream machine outputs; this bundle is a reusable
 * provenance and acceleration artifact.
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

// ---------------------------------------------------------------------------
// Serialization — used to persist handoffs to disk so that --run-id resume
// can recover the thin screen path without re-running expensive discovery.
// ---------------------------------------------------------------------------

type SerializedDiscoveryHandoff = Omit<
  DiscoveryHandoff,
  "mentionsByPaperId" | "groundingByFamilyId"
> & {
  mentionsByPaperId: Record<string, HarvestedSeedMention[]>;
  groundingByFamilyId: Record<string, FamilyGroundingTrace>;
};

export function serializeHandoffMap(
  map: DiscoveryHandoffMap,
): string {
  const plain: Record<string, SerializedDiscoveryHandoff> = {};
  for (const [doi, handoff] of map) {
    plain[doi] = {
      ...handoff,
      mentionsByPaperId: Object.fromEntries(handoff.mentionsByPaperId),
      groundingByFamilyId: Object.fromEntries(handoff.groundingByFamilyId),
    };
  }
  return JSON.stringify(plain, null, 2);
}

export function deserializeHandoffMap(
  json: string,
): DiscoveryHandoffMap {
  const plain = JSON.parse(json) as Record<string, SerializedDiscoveryHandoff>;
  const map: DiscoveryHandoffMap = new Map();
  for (const [doi, serialized] of Object.entries(plain)) {
    map.set(doi, {
      ...serialized,
      mentionsByPaperId: new Map(Object.entries(serialized.mentionsByPaperId)),
      groundingByFamilyId: new Map(
        Object.entries(serialized.groundingByFamilyId),
      ),
    });
  }
  return map;
}
