import {
  BIBLIOGRAPHY_SIGNALS,
  METHODS_SECTION_PATTERNS,
} from "../domain/section-patterns.js";
import type {
  CitationMention,
  Confidence,
  ContextType,
  MarkerStyle,
} from "../domain/types.js";

// --- Marker style classification ---

const AUTHOR_YEAR_RE = /[A-Z][a-z]+.*(?:et\s+al\.?|and\s+[A-Z]).*\d{4}/;
const NUMERIC_RE = /^\d{1,3}$/;
const YEAR_ONLY_RE = /^\d{4}$/;

export function classifyMarkerStyle(marker: string): MarkerStyle {
  if (AUTHOR_YEAR_RE.test(marker)) return "author_year";
  if (NUMERIC_RE.test(marker.trim())) return "numeric";
  if (YEAR_ONLY_RE.test(marker.trim())) return "year_only";
  return "unknown";
}

// --- Context type classification ---

const BIBLIO_DENSITY_THRESHOLD = 3;

function countDoiLikePatterns(text: string): number {
  return (text.match(/\b10\.\d{4,}\//g) ?? []).length;
}

function countParenthesizedYears(text: string): number {
  return (text.match(/\(\d{4}\)/g) ?? []).length;
}

export function classifyContextType(
  rawContext: string,
  sectionTitle: string | undefined,
): ContextType {
  const doiCount = countDoiLikePatterns(rawContext);
  const yearCount = countParenthesizedYears(rawContext);
  const biblioSignalHits = BIBLIOGRAPHY_SIGNALS.filter((re) =>
    re.test(rawContext),
  ).length;

  if (
    doiCount >= 3 ||
    (biblioSignalHits >= 2 && yearCount >= BIBLIO_DENSITY_THRESHOLD)
  ) {
    return "bibliography_like";
  }

  const sectionLower = sectionTitle?.toLowerCase() ?? "";
  if (METHODS_SECTION_PATTERNS.some((re) => re.test(sectionLower))) {
    return "methods_like";
  }
  if (
    METHODS_SECTION_PATTERNS.some((re) => re.test(rawContext)) &&
    rawContext.length < 600
  ) {
    return "methods_like";
  }

  if (rawContext.length >= 80) {
    return "narrative_like";
  }

  return "unknown";
}

// --- Confidence scoring ---

export function assessConfidence(
  markerStyle: MarkerStyle,
  contextType: ContextType,
  contextLength: number,
): Confidence {
  if (contextType === "bibliography_like") return "low";

  if (
    markerStyle === "author_year" &&
    contextType === "narrative_like" &&
    contextLength >= 100
  ) {
    return "high";
  }

  if (
    (markerStyle === "author_year" || markerStyle === "numeric") &&
    contextLength >= 80
  ) {
    return "medium";
  }

  return "low";
}

// --- Mention deduplication ---

type MentionKey = string;

function mentionKey(m: CitationMention): MentionKey {
  const refPart = m.provenance.refId ?? "no-ref";
  const ctxHash = m.rawContext.substring(0, 200);
  const offsetPart =
    m.provenance.charOffsetStart != null
      ? `${String(m.provenance.charOffsetStart)}`
      : "no-offset";
  return `${refPart}|${ctxHash}|${offsetPart}`;
}

export function deduplicateMentions(mentions: CitationMention[]): {
  unique: CitationMention[];
  rawCount: number;
} {
  const rawCount = mentions.length;
  const seen = new Map<MentionKey, CitationMention>();

  for (const m of mentions) {
    const key = mentionKey(m);
    if (!seen.has(key)) {
      seen.set(key, { ...m, isDuplicate: false });
    }
  }

  const unique = [...seen.values()];
  for (let i = 0; i < unique.length; i++) {
    unique[i] = { ...unique[i]!, mentionIndex: i };
  }

  return { unique, rawCount };
}

// --- Annotate all quality fields on raw mentions ---

export function annotateMention(m: CitationMention): CitationMention {
  const markerStyle = classifyMarkerStyle(m.citationMarker);
  const contextType = classifyContextType(m.rawContext, m.sectionTitle);
  const contextLength = m.rawContext.length;
  const confidence = assessConfidence(markerStyle, contextType, contextLength);

  return {
    ...m,
    markerStyle,
    contextType,
    contextLength,
    confidence,
    isDuplicate: false,
  };
}

// --- Usability assessment for an edge ---

export function assessUsability(
  mentions: CitationMention[],
): boolean | "unknown" {
  if (mentions.length === 0) return false;

  const hasNarrative = mentions.some(
    (m) => m.contextType === "narrative_like" && m.confidence !== "low",
  );
  if (hasNarrative) return true;

  const allBiblio = mentions.every(
    (m) => m.contextType === "bibliography_like",
  );
  if (allBiblio) return false;

  const allMethods = mentions.every((m) => m.contextType === "methods_like");
  if (allMethods) return "unknown";

  return "unknown";
}
