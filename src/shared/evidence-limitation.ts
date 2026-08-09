/**
 * Deterministic evidence-sufficiency diagnostics for adjudicate packets.
 * Figure-only support is recorded as a limitation until image-aware retrieval
 * exists; it does not invent a new fidelity verdict mode.
 */

const FIGURE_REF_RE =
  /\b(?:fig(?:ure)?s?\.?\s*\d+[a-z]?|figures?\s+\d+[a-z]?)\b/i;

type EvidenceLimitation = "figure_only_support";
type EvidenceSufficiency = "sufficient" | "limited";

export type EvidenceLimitationAssessment = {
  evidenceSufficiency: EvidenceSufficiency;
  evidenceLimitation?: EvidenceLimitation;
};

export function assessEvidenceLimitation(input: {
  claimTexts: readonly string[];
  citingContext: string;
  selectedChunkTexts: readonly string[];
}): EvidenceLimitationAssessment {
  const claimSide = [...input.claimTexts, input.citingContext].join("\n");
  const figureRefs = claimSide.match(
    /\b(?:fig(?:ure)?s?\.?\s*\d+[a-z]?|figures?\s+\d+[a-z]?)\b/gi,
  );
  if (figureRefs == null || figureRefs.length === 0) {
    return { evidenceSufficiency: "sufficient" };
  }

  const chunkSide = input.selectedChunkTexts.join("\n");
  const normalizedRefs = [
    ...new Set(figureRefs.map((ref) => ref.replace(/\s+/g, " ").toLowerCase())),
  ];
  const chunkCoversRef = normalizedRefs.some((ref) => {
    const compact = ref.replace(/\s+/g, "\\s*");
    return new RegExp(compact, "i").test(chunkSide);
  });
  if (chunkCoversRef || FIGURE_REF_RE.test(chunkSide)) {
    return { evidenceSufficiency: "sufficient" };
  }

  return {
    evidenceSufficiency: "limited",
    evidenceLimitation: "figure_only_support",
  };
}
