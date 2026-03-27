import {
  BACKGROUND_SECTION_RE,
  METHODS_SECTION_PATTERNS,
} from "../domain/section-patterns.js";
import type {
  CitationMention,
  CitationRole,
  ClassifiedMention,
  TransmissionModifiers,
} from "../domain/types.js";

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

type Signal = { role: CitationRole; source: string };

function collectSignals(mention: CitationMention): Signal[] {
  const hits: Signal[] = [];
  const section = mention.sectionTitle ?? "";
  const window = extractLocalWindow(
    mention.rawContext,
    mention.citationMarker,
    200,
  );

  if (METHODS_SECTION_PATTERNS.some((re) => re.test(section))) {
    hits.push({ role: "methods_materials", source: `section:${section}` });
  }
  if (BACKGROUND_SECTION_RE.test(section)) {
    hits.push({ role: "background_context", source: `section:${section}` });
  }

  for (const re of METHODS_PHRASES) {
    if (re.test(window)) {
      hits.push({ role: "methods_materials", source: `phrase:${re.source}` });
    }
  }
  for (const re of ATTRIBUTION_VERBS) {
    if (re.test(window)) {
      hits.push({
        role: "substantive_attribution",
        source: `verb:${re.source}`,
      });
    }
  }
  for (const re of BACKGROUND_PHRASES) {
    if (re.test(window)) {
      hits.push({ role: "background_context", source: `phrase:${re.source}` });
    }
  }

  return hits;
}

function resolveRole(
  mention: CitationMention,
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

export function classifyMention(
  mention: CitationMention,
  isReviewPaper: boolean,
): ClassifiedMention {
  const signals = collectSignals(mention);
  const citationRole = resolveRole(mention, signals);

  const modifiers: TransmissionModifiers = {
    isBundled: mention.isBundledCitation,
    isReviewMediated: isReviewPaper,
  };

  return {
    ...mention,
    citationRole,
    modifiers,
    classificationSignals: signals.map((s) => `${s.role}:${s.source}`),
  };
}
