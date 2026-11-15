import type {
  DiscoverAttributedClaimRecord,
  DiscoverCitationOccurrence,
} from "../../contract/artifacts/index.js";

/** Only a unique exact marker in the verified passage can change attachment. */
export function resolveClaimCitation(
  claim: DiscoverAttributedClaimRecord,
  original: DiscoverCitationOccurrence,
  mentions: readonly DiscoverCitationOccurrence[],
): DiscoverCitationOccurrence {
  const span = claim.supportSpan;
  if (
    !span ||
    original.rawContext.slice(span.charOffsetStart, span.charOffsetEnd) !==
      span.text
  )
    return original;
  const candidates = mentions.filter((mention) => {
    const marker = mention.markerSpan;
    return (
      mention.seedId === original.seedId &&
      mention.citingPaperRecordId === original.citingPaperRecordId &&
      mention.rawContext === original.rawContext &&
      // Global paragraph offsets disambiguate repeated identical paragraphs.
      (original.charOffsetStart == null ||
        original.markerSpan == null ||
        mention.charOffsetStart == null ||
        marker == null ||
        mention.charOffsetStart - marker.charOffsetStart ===
          original.charOffsetStart - original.markerSpan.charOffsetStart) &&
      mention.locationQuality === "exact_dom" &&
      marker != null &&
      marker.charOffsetStart >= span.charOffsetStart &&
      marker.charOffsetEnd <= span.charOffsetEnd &&
      mention.rawContext.slice(marker.charOffsetStart, marker.charOffsetEnd) ===
        mention.citationMarker
    );
  });
  return candidates.length === 1 ? candidates[0]! : original;
}
