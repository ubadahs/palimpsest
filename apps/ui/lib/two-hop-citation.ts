import type { TwoHopCase, TwoHopEvidence } from "./two-hop-review-types";

// The bibliography match and the marked groups use reference IDs from the same paper version.
export function originalCitationAtPassage(
  item: TwoHopEvidence,
  reviewCase: TwoHopCase,
  original: string,
): string {
  const bibliography = reviewCase.originalBibliography;
  if (!bibliography || bibliography.entriesChecked === 0) {
    return "Citation coverage is unknown for this version.";
  }
  if (!bibliography.referenceIds.length) {
    return bibliography.coverage === "complete"
      ? `The full reference list (${bibliography.entriesChecked} entries) contains no match for ${original}.`
      : `No match for ${original} in the ${bibliography.entriesChecked} references recovered from this version.`;
  }

  const referenceIds = new Set(bibliography.referenceIds);
  const sameGroup =
    referenceIds.has(item.targetReference.refId) ||
    item.citationGroupReferences.some(([id]) => referenceIds.has(id));
  if (sameGroup)
    return `The authors cite ${original} alongside the middle paper in this passage.`;

  const elsewhere = reviewCase.originalCitationGroup?.some(
    (group) => group.locator !== item.locator,
  );
  if (elsewhere) return `The authors cite ${original} elsewhere in this paper.`;
  return `${original} is in the bibliography. The available markers do not show where it was cited.`;
}
