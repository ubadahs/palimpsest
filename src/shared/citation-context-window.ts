/**
 * Extracts a focused window of text around a citation marker.
 *
 * Used by the reranker (to build a tight query) and the adjudicator
 * (to show the judge the relevant sentence instead of a truncated paragraph).
 */

const SENTENCE_RE = /[^.!?]*[.!?]+/g;

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
  const normalized = marker.replace(/\s+/g, " ").replace(/[,;:]+$/, "").trim();
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

function splitSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let match: RegExpExecArray | null;
  SENTENCE_RE.lastIndex = 0;

  while ((match = SENTENCE_RE.exec(text)) !== null) {
    spans.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  // Capture any trailing fragment without terminal punctuation.
  const lastEnd = spans.length > 0 ? spans[spans.length - 1]!.end : 0;
  const remainder = text.substring(lastEnd).trim();
  if (remainder.length > 20) {
    spans.push({ text: remainder, start: lastEnd, end: text.length });
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
      offset < s.start
        ? s.start - offset
        : offset > s.end
          ? offset - s.end
          : 0;
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
