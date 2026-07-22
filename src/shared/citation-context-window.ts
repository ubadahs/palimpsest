/**
 * Extracts a focused window of text around a citation marker.
 *
 * Used by the reranker (to build a tight query) and the adjudicator
 * (to show the judge the relevant sentence instead of a truncated paragraph).
 */

/** Common abbreviations whose internal periods must not end a sentence. */
const ABBREVIATION_RE =
  /\b(?:et\s+al|e\.g|i\.e|vs|cf|fig|figs|eq|eqs|no|nos|dr|mr|mrs|ms|prof|approx|ca|ed|eds|vol|vols|pp)\./gi;

/**
 * Annotates the citing context by wrapping the sentence(s) that contain the
 * citation marker with ▶ / ◀ delimiters. The full context is preserved —
 * surrounding sentences remain for the adjudicator to reason about — but the
 * attributed sentence(s) are visually marked.
 *
 * If the context is short enough that the marker position is unambiguous,
 * or if the marker can't be found, returns the text unchanged.
 */
/**
 * @param rawContext      Full paragraph or context window.
 * @param citationMarker  The raw marker text (e.g. "2009", "[59]").
 * @param seedRefLabel    Author-year label from the matched bibliography entry
 *   (e.g. "Mets and Meyer, 2009"). When provided, used as the primary match
 *   pattern — this is the ground truth from reference resolution, not a guess.
 */
export function annotateCitingContext(
  rawContext: string,
  citationMarker: string,
  seedRefLabel?: string,
): string {
  const sentences = splitSentences(rawContext);

  if (sentences.length <= 1) {
    return rawContext;
  }

  // Primary pattern: the seed paper's author-year label (ground truth from
  // reference resolution). Falls back to the raw citation marker.
  const primaryPattern = seedRefLabel ?? citationMarker;
  const patterns: string[] = [];
  if (primaryPattern.length > 0) {
    patterns.push(primaryPattern);
    const normalized = primaryPattern
      .replace(/\s+/g, " ")
      .replace(/[,;:]+$/, "")
      .trim();
    if (normalized !== primaryPattern) patterns.push(normalized);
  }
  // Also try the raw marker as fallback if seedRefLabel was used as primary.
  if (
    seedRefLabel &&
    citationMarker.length > 0 &&
    citationMarker !== seedRefLabel
  ) {
    patterns.push(citationMarker);
  }

  // Find sentences that contain any of our patterns (prefer earlier patterns).
  const markerSentences = new Set<number>();
  for (const pat of patterns) {
    for (let i = 0; i < sentences.length; i++) {
      if (sentences[i]!.text.includes(pat)) {
        markerSentences.add(i);
      }
    }
    // If the primary pattern (seedRefLabel) matched, don't fall back to the
    // raw marker — the label is more specific and avoids false matches.
    if (markerSentences.size > 0 && pat === (seedRefLabel ?? citationMarker)) {
      break;
    }
  }

  if (markerSentences.size === 0 || markerSentences.size === sentences.length) {
    return rawContext;
  }

  // Rebuild with ▶ / ◀ around attributed sentences.
  const parts: string[] = [];
  let inMarked = false;
  for (let i = 0; i < sentences.length; i++) {
    const isMarked = markerSentences.has(i);
    if (isMarked && !inMarked) {
      parts.push("▶ ");
      inMarked = true;
    } else if (!isMarked && inMarked) {
      // Trim trailing space before closing marker.
      const last = parts.length - 1;
      if (last >= 0) parts[last] = parts[last]!.trimEnd();
      parts.push(" ◀ ");
      inMarked = false;
    }
    parts.push(sentences[i]!.text);
  }
  if (inMarked) {
    const last = parts.length - 1;
    if (last >= 0) parts[last] = parts[last]!.trimEnd();
    parts.push(" ◀");
  }

  return parts.join("");
}

/**
 * Fail-closed check for adjudicate packet citing-context annotation.
 * Markers must wrap claim-bearing text; unmarked multi-sentence windows are
 * rejected because the attributed sentence could not be disambiguated.
 */
export function assessCitationScopeAnnotation(markedCitingContext: string): {
  ok: boolean;
  reason: string;
} {
  const inners = [...markedCitingContext.matchAll(/▶\s*([\s\S]*?)\s*◀/g)].map(
    (match) => match[1] ?? "",
  );
  if (inners.length > 0) {
    if (inners.some((inner) => hasClaimBearingText(inner))) {
      return {
        ok: true,
        reason: "Citation scope markers wrap claim-bearing text",
      };
    }
    return {
      ok: false,
      reason:
        "Citation scope markers wrap non-substantive text and are reserved for manual review",
    };
  }

  const sentences = splitSentences(markedCitingContext);
  if (sentences.length <= 1 && hasClaimBearingText(markedCitingContext)) {
    return {
      ok: true,
      reason: "Single-sentence citing context needs no scope markers",
    };
  }
  return {
    ok: false,
    reason:
      "Citation scope could not be disambiguated in multi-sentence citing context",
  };
}

function hasClaimBearingText(text: string): boolean {
  const withoutCitations = text
    .replace(/\((?:[^()]*\d{4}[^()]*)\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = withoutCitations
    .split(" ")
    .filter((token) => token.length > 0 && !/^\d+$/.test(token));
  // Need at least a few alphabetic tokens beyond citation debris.
  const alphaTokens = tokens.filter((token) => /\p{L}{2,}/u.test(token));
  return alphaTokens.length >= 3;
}

/**
 * Returns ~1-3 sentences surrounding the citation marker within rawContext.
 * Falls back to a character-based window if sentence splitting fails.
 */
export function extractCitingWindow(
  rawContext: string,
  citationMarker: string,
  maxChars: number = 600,
): string {
  if (rawContext.length <= maxChars) {
    return rawContext;
  }

  const markerPos = findMarkerPosition(rawContext, citationMarker);

  // Try sentence-based extraction first.
  const sentences = splitSentences(rawContext);
  if (sentences.length > 1) {
    const window = selectSentencesAroundOffset(sentences, markerPos, maxChars);
    if (window.length > 0) {
      return window;
    }
  }

  // Fallback: character window centered on marker.
  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, markerPos - half);
  const end = Math.min(rawContext.length, start + maxChars);
  return rawContext.substring(start, end).trim();
}

function findMarkerPosition(text: string, marker: string): number {
  if (marker.length === 0) return Math.floor(text.length / 2);

  // Try exact match first.
  const exact = text.indexOf(marker);
  if (exact >= 0) return exact;

  // Try normalized match (collapse whitespace, strip trailing punctuation).
  const normalized = marker
    .replace(/\s+/g, " ")
    .replace(/[,;:]+$/, "")
    .trim();
  const pos = text.indexOf(normalized);
  if (pos >= 0) return pos;

  // Try matching just the author surname + year pattern.
  const authorYear = normalized.match(/\w+\s+et\s+al\.?,?\s*\d{4}/);
  if (authorYear) {
    const ayPos = text.indexOf(authorYear[0]);
    if (ayPos >= 0) return ayPos;
  }

  return Math.floor(text.length / 2);
}

type SentenceSpan = { text: string; start: number; end: number };

/**
 * Split on terminal punctuation, protecting abbreviation periods (et al., Fig.,
 * etc.) so author–year citations stay inside their sentence.
 */
export function splitSentences(text: string): SentenceSpan[] {
  if (text.length === 0) return [];

  const protectedText = text.replace(ABBREVIATION_RE, (match) =>
    match.replace(/\./g, "\u0000"),
  );

  const spans: SentenceSpan[] = [];
  const boundaryRe = /[.!?]+(?:["')\]]+)?(?:\s+|$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = boundaryRe.exec(protectedText)) !== null) {
    const end = match.index + match[0].length;
    const slice = text.slice(cursor, end);
    if (slice.trim().length > 0) {
      spans.push({ text: slice, start: cursor, end });
    }
    cursor = end;
  }
  if (cursor < text.length) {
    const remainder = text.slice(cursor);
    if (remainder.trim().length > 0) {
      spans.push({ text: remainder, start: cursor, end: text.length });
    }
  }
  if (spans.length === 0 && text.trim().length > 0) {
    spans.push({ text, start: 0, end: text.length });
  }
  return spans;
}

function selectSentencesAroundOffset(
  sentences: SentenceSpan[],
  offset: number,
  maxChars: number,
): string {
  // Find the sentence containing (or nearest to) the offset.
  let anchor = 0;
  let bestDist = Infinity;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!;
    const dist =
      offset < s.start ? s.start - offset : offset > s.end ? offset - s.end : 0;
    if (dist < bestDist) {
      bestDist = dist;
      anchor = i;
    }
  }

  // Expand outward from anchor until we hit maxChars.
  let lo = anchor;
  let hi = anchor;
  let len = sentences[anchor]!.text.length;

  while (true) {
    let grew = false;

    if (lo > 0) {
      const candidate = sentences[lo - 1]!.text.length;
      if (len + candidate <= maxChars) {
        lo--;
        len += candidate;
        grew = true;
      }
    }

    if (hi < sentences.length - 1) {
      const candidate = sentences[hi + 1]!.text.length;
      if (len + candidate <= maxChars) {
        hi++;
        len += candidate;
        grew = true;
      }
    }

    if (!grew) break;
  }

  return sentences
    .slice(lo, hi + 1)
    .map((s) => s.text)
    .join("")
    .trim();
}
