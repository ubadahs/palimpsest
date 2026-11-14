/**
 * Marks and windows the citing sentences around a citation marker.
 *
 * Used by the reranker (to build a tight query) and the adjudicator
 * (to show the judge the relevant sentence instead of a truncated paragraph).
 */

/** Common abbreviations whose internal periods must not end a sentence. */
const ABBREVIATION_RE =
  /\b(?:et\s+al|e\.g|i\.e|vs|cf|fig|figs|eq|eqs|no|nos|dr|mr|mrs|ms|prof|approx|ca|ed|eds|vol|vols|pp)\./gi;

/** A citation as Discover recorded it, enough to find it in its paragraph. */
export type CitingOccurrenceText = {
  rawContext: string;
  citationMarker: string;
  /** Author-year label from the matched bibliography entry. */
  seedRefLabel?: string | undefined;
  /** Where `citationMarker` sits in `rawContext`, when the parser located it exactly. */
  markerSpan?: { charOffsetStart: number; charOffsetEnd: number } | undefined;
};

type VerifiedSupportSpan = {
  text: string;
  charOffsetStart: number;
  charOffsetEnd: number;
};

/**
 * Wraps the sentences a citation's claims rest on in ▶ / ◀, keeping the rest
 * of the paragraph for context. A verified support span is marked, across
 * every sentence it covers, when one of those sentences cites the seed at
 * this occurrence (see `citesSeedAt`). Spans that cannot be tied to this
 * citation stay unmarked, and the caller's manual-review gate holds them back.
 */
export function annotateCitingContext(
  occurrence: CitingOccurrenceText,
  verifiedSupportSpans: readonly VerifiedSupportSpan[],
): string {
  const { rawContext } = occurrence;
  const sentences = splitSentences(rawContext);
  const citesSeed = citesSeedAt(occurrence, sentences);
  const marked = new Set<number>();
  for (const span of verifiedSupportSpans) {
    if (
      rawContext.slice(span.charOffsetStart, span.charOffsetEnd) !==
        span.text ||
      span.charOffsetEnd <= span.charOffsetStart
    )
      continue;
    const covered = sentences.flatMap((sentence, index) =>
      span.charOffsetStart < sentence.end && span.charOffsetEnd > sentence.start
        ? [index]
        : [],
    );
    if (covered.some(citesSeed)) for (const index of covered) marked.add(index);
  }
  return marked.size === 0 ? rawContext : markSentences(sentences, marked);
}

/**
 * Which sentences cite the seed at this occurrence: the one holding the
 * occurrence's own marker, when the parser located it. Otherwise a sentence
 * must name the seed's author-year label, or hold a numeric marker that occurs
 * once in the paragraph; a bare year such as "2021" is never enough, since
 * another reference may share it.
 */
function citesSeedAt(
  occurrence: CitingOccurrenceText,
  sentences: readonly SentenceSpan[],
): (sentenceIndex: number) => boolean {
  const { markerSpan, rawContext, citationMarker } = occurrence;
  if (markerSpan) {
    return (index) => {
      const sentence = sentences[index]!;
      return (
        markerSpan.charOffsetStart >= sentence.start &&
        markerSpan.charOffsetStart < sentence.end
      );
    };
  }
  const label = occurrence.seedRefLabel
    ? normalizeReference(occurrence.seedRefLabel)
    : "";
  const position = rawContext.indexOf(citationMarker);
  const markerIsUnique =
    citationMarker.length > 0 &&
    position >= 0 &&
    position === rawContext.lastIndexOf(citationMarker);
  const markerIdentifiesSeed =
    markerIsUnique &&
    (label.length === 0 ||
      /^\[\s*\d+(?:[\s,;–-]*\d+)*\s*\]$/.test(citationMarker));
  return (index) => {
    const text = sentences[index]!.text;
    return (
      (label.length > 0 && normalizeReference(text).includes(label)) ||
      (markerIdentifiesSeed && text.includes(citationMarker))
    );
  };
}

function normalizeReference(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function markSentences(
  sentences: SentenceSpan[],
  markerSentences: ReadonlySet<number>,
): string {
  // When every sentence is attributed to the seed the whole window is wrapped.
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
  alternateMarkers: readonly string[] = [],
): string {
  if (rawContext.length <= maxChars) {
    return rawContext;
  }

  const markerPos = [citationMarker, ...alternateMarkers]
    .map((marker) => findMarkerPosition(rawContext, marker))
    .find((position) => position >= 0);
  if (markerPos == null) {
    // No marker located: return the full context rather than an arbitrary
    // midpoint window that may exclude the citing sentence entirely.
    return rawContext;
  }

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

/** Offset of the marker in `text`, or -1 when no pattern matches. */
function findMarkerPosition(text: string, marker: string): number {
  if (marker.length === 0) return -1;

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

  return -1;
}

type SentenceSpan = { text: string; start: number; end: number };

/**
 * Split on terminal punctuation, protecting abbreviation periods (et al., Fig.,
 * etc.) so author–year citations stay inside their sentence.
 */
function splitSentences(text: string): SentenceSpan[] {
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
