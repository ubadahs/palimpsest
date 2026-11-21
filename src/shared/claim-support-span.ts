/**
 * Exact-verify an extracted claim support span against citation occurrence text.
 * Offsets are relative to the occurrence rawContext string.
 */

export type VerifiedClaimSupportSpan = {
  text: string;
  charOffsetStart: number;
  charOffsetEnd: number;
  verificationStatus: "verified_exact";
};

type HighlightedCitation = {
  citationMarker: string;
  markerSpan?: { charOffsetStart: number; charOffsetEnd: number } | undefined;
};

export function highlightCitationMarker(marker: string): string {
  return `▶${marker}◀`;
}

export function verifyClaimSupportSpan(
  rawContext: string,
  proposed: string | undefined,
  target?: HighlightedCitation,
): VerifiedClaimSupportSpan | undefined {
  if (proposed == null) return undefined;
  const trimmed = proposed.trim();
  if (trimmed.length === 0) return undefined;

  const exact = rawContext.indexOf(proposed);
  if (exact >= 0) {
    return {
      text: proposed,
      charOffsetStart: exact,
      charOffsetEnd: exact + proposed.length,
      verificationStatus: "verified_exact",
    };
  }

  const trimmedExact = rawContext.indexOf(trimmed);
  if (trimmedExact >= 0) {
    return {
      text: trimmed,
      charOffsetStart: trimmedExact,
      charOffsetEnd: trimmedExact + trimmed.length,
      verificationStatus: "verified_exact",
    };
  }

  const match =
    findCollapsedWhitespaceMatch(rawContext, trimmed) ??
    matchPromptHighlight(rawContext, trimmed, target);
  if (!match) return undefined;
  return {
    text: rawContext.slice(match.start, match.end),
    charOffsetStart: match.start,
    charOffsetEnd: match.end,
    verificationStatus: "verified_exact",
  };
}

/** Remove only the decoration the prompt added at this exact occurrence.
 * Every other character must match a unique, literal source passage. */
function matchPromptHighlight(
  rawContext: string,
  quote: string,
  target: HighlightedCitation | undefined,
): { start: number; end: number } | undefined {
  if (!target?.markerSpan || !target.citationMarker) return undefined;
  const { citationMarker, markerSpan } = target;
  if (
    markerSpan.charOffsetStart < 0 ||
    markerSpan.charOffsetEnd > rawContext.length ||
    rawContext.slice(markerSpan.charOffsetStart, markerSpan.charOffsetEnd) !==
      citationMarker
  ) {
    return undefined;
  }
  const variants = [
    highlightCitationMarker(citationMarker),
    `▶${citationMarker}`,
    `${citationMarker}◀`,
  ];
  for (const decorated of variants) {
    const index = quote.indexOf(decorated);
    if (index < 0) continue;
    const text =
      quote.slice(0, index) +
      citationMarker +
      quote.slice(index + decorated.length);
    const start = markerSpan.charOffsetStart - index;
    if (
      start >= 0 &&
      rawContext.indexOf(text) === start &&
      rawContext.indexOf(text, start + 1) < 0
    ) {
      return { start, end: start + text.length };
    }
  }
  return undefined;
}

function findCollapsedWhitespaceMatch(
  haystack: string,
  needle: string,
): { start: number; end: number } | undefined {
  const collapsedNeedle = needle.replace(/\s+/g, " ").trim();
  if (collapsedNeedle.length === 0) return undefined;
  const parts = collapsedNeedle.split(" ").filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  const pattern = parts.map(escapeRegExp).join("\\s+");
  const match = new RegExp(pattern).exec(haystack);
  if (!match) return undefined;
  return { start: match.index, end: match.index + match[0].length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
