import type { CitationMention } from "../domain/types.js";

// --- Build author+year regex patterns for citation matching ---

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildAuthorPatterns(authorSurnames: string[], year: string): RegExp[] {
  const patterns: RegExp[] = [];

  for (const surname of authorSurnames.slice(0, 3)) {
    const escaped = escapeRegex(surname);
    patterns.push(
      new RegExp(`${escaped}[^.]*?et\\s+al\\.?[^.]*?${year}`, "i"),
      new RegExp(`${year}[^.]*?${escaped}`, "i"),
      new RegExp(`${escaped}[^.]*?${year}`, "i"),
    );
  }

  return patterns;
}

// --- Section splitting: separate body from bibliography ---

const BIBLIOGRAPHY_HEADER_RE =
  /^(?:references|bibliography|works cited|literature cited|cited literature)\s*$/im;

function splitBodyAndBibliography(text: string): {
  body: string;
  bibliography: string;
} {
  const match = BIBLIOGRAPHY_HEADER_RE.exec(text);
  if (!match) return { body: text, bibliography: "" };
  return {
    body: text.substring(0, match.index),
    bibliography: text.substring(match.index),
  };
}

// --- Split text into paragraphs ---

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 40);
}

// --- Find citation mentions in PDF-extracted text ---

export function findCitationMentionsByRegex(
  text: string,
  seedAuthors: string[],
  seedYear: string | undefined,
): CitationMention[] {
  if (!seedYear || seedAuthors.length === 0) return [];

  const surnames = seedAuthors.map((a) => {
    const parts = a.trim().split(/\s+/);
    return parts[parts.length - 1] ?? a;
  });

  const patterns = buildAuthorPatterns(surnames, seedYear);
  const { body, bibliography } = splitBodyAndBibliography(text);

  const bodyMentions = matchInText(body, patterns, false);

  if (bodyMentions.length > 0) return bodyMentions;

  return matchInText(bibliography, patterns, true);
}

const YEAR_PATTERN_RE = /\b\d{4}\b/g;

function estimateBundleInParagraph(
  para: string,
  matchIndex: number,
  matchLength: number,
): { isBundled: boolean; bundleSize: number } {
  const WINDOW = 60;
  const start = Math.max(0, matchIndex - WINDOW);
  const end = Math.min(para.length, matchIndex + matchLength + WINDOW);
  const window = para.substring(start, end);

  const yearHits = [...window.matchAll(YEAR_PATTERN_RE)];
  if (yearHits.length >= 3) {
    return { isBundled: true, bundleSize: yearHits.length };
  }
  return { isBundled: false, bundleSize: 1 };
}

function matchInText(
  text: string,
  patterns: RegExp[],
  isBibliographySection: boolean,
): CitationMention[] {
  const paragraphs = splitParagraphs(text);
  const mentions: CitationMention[] = [];
  let mentionIndex = 0;

  for (const para of paragraphs) {
    for (const pattern of patterns) {
      const match = pattern.exec(para);
      if (!match) continue;

      const bundle = estimateBundleInParagraph(
        para,
        match.index,
        match[0].length,
      );

      mentions.push({
        mentionIndex,
        rawContext: para,
        citationMarker: match[0],
        sectionTitle: isBibliographySection ? "References" : undefined,
        isDuplicate: false,
        contextLength: para.length,
        markerStyle: "unknown",
        contextType: "unknown",
        confidence: "low",
        isBundledCitation: bundle.isBundled,
        bundleSize: bundle.bundleSize,
        bundleRefIds: [],
        bundlePattern: bundle.isBundled ? "unknown" : "single",
        provenance: {
          sourceType: "pdf_text",
          parser: "pdf-regex",
          refId: undefined,
          charOffsetStart: match.index,
          charOffsetEnd: match.index + match[0].length,
        },
      });

      mentionIndex++;
      break;
    }
  }

  return mentions;
}
