import {
  BACKGROUND_SECTION_RE,
  METHODS_SECTION_PATTERNS,
} from "../domain/section-patterns.js";
import type {
  CitationRole,
  Confidence,
  TransmissionModifiers,
} from "../domain/classification.js";

// --- Phrase-level cues ---

const METHODS_PHRASES: RegExp[] = [
  /\bas\s+(?:described|reported)\s+(?:in|by|previously)\b/i,
  /\bfollowing\s+(?:the\s+)?protocol\b/i,
  /\bwas\s+performed\s+as\s+(?:described|in)\b/i,
  /\busing\s+(?:the\s+)?(?:method|protocol|approach|procedure|data|software|tool)\b/i,
  /\baccording\s+to\b/i,
  /\bmodified\s+from\b/i,
  /\bpreviously\s+described\b/i,
  /\bwere?\s+(?:cultured|isolated|extracted|prepared|stained|fixed|imaged|analyzed|quantified)\b/i,
];

const ATTRIBUTION_VERBS: RegExp[] = [
  /\b(?:showed?|shown)\b/i,
  /\b(?:found|finding)\b/i,
  /\brevealed\b/i,
  /\bdemonstrated\b/i,
  /\bidentified\b/i,
  /\breported\s+that\b/i,
  /\bdiscovered\b/i,
  /\buncovered\b/i,
  /\bconfirmed\b/i,
  /\bprovided\s+evidence\b/i,
  /\bsuggested\s+that\b/i,
  /\bproposed\s+that\b/i,
  /\bimplicated\b/i,
];

const BACKGROUND_PHRASES: RegExp[] = [
  /\b(?:is|are)\s+(?:known|thought|believed|considered|essential|important|critical|key|involved|implicated)\b/i,
  /\bhas\s+been\s+(?:well[-\s])?(?:characterized|established|studied|documented|recognized)\b/i,
  /\bplay(?:s|ed)?\s+(?:a\s+)?(?:key|critical|important|essential|central|major)?\s*role\b/i,
  /\breviewed?\s+(?:in|by)\b/i,
  /\bfor\s+(?:a\s+)?review\b/i,
  /\bwidely\s+(?:used|studied|reported)\b/i,
];

/** Author–year / "et al." markers get a slightly wider local window. */
const AUTHOR_YEAR_MARKER_RE = /\bet\s+al\.|,?\s*(?:19|20)\d{2}\b/i;

const RESULTS_DISCUSSION_SECTION_RE =
  /\b(?:results?|discussion|conclusions?)\b/i;

/** Light narrative frames near author–year markers (not bare "see also"). */
const NARRATIVE_ATTRIBUTION_FRAMES: RegExp[] = [
  /\b(?:reported|showed|shown|found|finding|observed)\b/i,
  /\baccording\s+to\b/i,
];

function extractLocalWindow(
  rawContext: string,
  marker: string,
  radius: number,
): string {
  const idx = rawContext.indexOf(marker);
  if (idx < 0) return rawContext;
  const start = Math.max(0, idx - radius);
  const end = Math.min(rawContext.length, idx + marker.length + radius);
  return rawContext.substring(start, end);
}

function isAuthorYearMarker(marker: string): boolean {
  return AUTHOR_YEAR_MARKER_RE.test(marker);
}

type Signal = { role: CitationRole; source: string };

export type CitationFunctionInput = {
  rawContext: string;
  citationMarker: string;
  sectionTitle?: string | undefined;
  contextLength: number;
  confidence: Confidence;
  isBundledCitation: boolean;
  bundleSize: number;
  /**
   * Exact-verified occurrence-local support span text. When present, phrase and
   * verb signals are collected primarily from this bound claim text.
   */
  claimSupportText?: string | undefined;
};

export type CitationFunctionClassification = {
  citationRole: CitationRole;
  modifiers: TransmissionModifiers;
  classificationSignals: string[];
};

function collectSignals(mention: CitationFunctionInput): Signal[] {
  const hits: Signal[] = [];
  const section = mention.sectionTitle ?? "";
  const authorYear = isAuthorYearMarker(mention.citationMarker);
  const markerWindow = extractLocalWindow(
    mention.rawContext,
    mention.citationMarker,
    authorYear ? 320 : 200,
  );
  const claimSupport = mention.claimSupportText?.trim() ?? "";
  const phraseWindow = claimSupport.length > 0 ? claimSupport : markerWindow;

  if (METHODS_SECTION_PATTERNS.some((re) => re.test(section))) {
    hits.push({ role: "methods_materials", source: `section:${section}` });
  }
  if (BACKGROUND_SECTION_RE.test(section)) {
    hits.push({ role: "background_context", source: `section:${section}` });
  }

  for (const re of METHODS_PHRASES) {
    if (re.test(phraseWindow)) {
      hits.push({
        role: "methods_materials",
        source:
          claimSupport.length > 0
            ? `span-phrase:${re.source}`
            : `phrase:${re.source}`,
      });
    }
  }
  for (const re of ATTRIBUTION_VERBS) {
    if (re.test(phraseWindow)) {
      hits.push({
        role: "substantive_attribution",
        source:
          claimSupport.length > 0
            ? `span-verb:${re.source}`
            : `verb:${re.source}`,
      });
    }
  }
  for (const re of BACKGROUND_PHRASES) {
    if (re.test(phraseWindow)) {
      hits.push({
        role: "background_context",
        source:
          claimSupport.length > 0
            ? `span-phrase:${re.source}`
            : `phrase:${re.source}`,
      });
    }
  }

  if (authorYear) {
    if (RESULTS_DISCUSSION_SECTION_RE.test(section)) {
      hits.push({
        role: "substantive_attribution",
        source: `narrative:section:${section}`,
      });
    }
    for (const re of NARRATIVE_ATTRIBUTION_FRAMES) {
      if (re.test(phraseWindow)) {
        hits.push({
          role: "substantive_attribution",
          source:
            claimSupport.length > 0
              ? `span-narrative:${re.source}`
              : `narrative:${re.source}`,
        });
      }
    }
  }

  return hits;
}
function resolveRole(
  mention: CitationFunctionInput,
  signals: Signal[],
): CitationRole {
  if (signals.length === 0) {
    if (mention.contextLength < 100 && mention.confidence === "low") {
      return "acknowledgment_or_low_information";
    }
    return "unclear";
  }

  const counts: Record<CitationRole, number> = {
    substantive_attribution: 0,
    background_context: 0,
    methods_materials: 0,
    acknowledgment_or_low_information: 0,
    unclear: 0,
  };
  for (const s of signals) counts[s.role]++;

  const hasMethodsSection = signals.some(
    (s) => s.role === "methods_materials" && s.source.startsWith("section:"),
  );

  if (hasMethodsSection && counts.substantive_attribution <= 1) {
    return "methods_materials";
  }

  if (
    counts.substantive_attribution >= 2 ||
    (counts.substantive_attribution >= 1 &&
      counts.background_context === 0 &&
      counts.methods_materials === 0)
  ) {
    return "substantive_attribution";
  }

  if (counts.background_context >= 1 && counts.substantive_attribution === 0) {
    return "background_context";
  }

  if (counts.substantive_attribution >= 1 && counts.background_context >= 1) {
    return "substantive_attribution";
  }

  if (counts.methods_materials >= 1) {
    return "methods_materials";
  }

  if (mention.contextLength < 100 && mention.confidence === "low") {
    return "acknowledgment_or_low_information";
  }

  return "unclear";
}

export function classifyCitationFunction(
  mention: CitationFunctionInput,
  isReviewPaper: boolean,
): CitationFunctionClassification {
  const signals = collectSignals(mention);
  const citationRole = resolveRole(mention, signals);

  const modifiers: TransmissionModifiers = {
    isBundled: mention.isBundledCitation,
    isReviewMediated: isReviewPaper,
    ...(mention.bundleSize > 1 ? { bundleSize: mention.bundleSize } : {}),
  };

  return {
    citationRole,
    modifiers,
    classificationSignals: signals.map((s) => `${s.role}:${s.source}`),
  };
}
