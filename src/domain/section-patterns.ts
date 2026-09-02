/**
 * Shared regex patterns for classifying sections and context by type.
 * Used by deterministic citation-function classification.
 */

export const METHODS_SECTION_PATTERNS: RegExp[] = [
  /\bmethods?\b/i,
  /\bmaterials?\s+and\s+methods?\b/i,
  /\bprotocol\b/i,
  /\bsupplemental\b/i,
  /\bexperimental\s+procedures?\b/i,
  /\bdata\s+analysis\b/i,
  /\bstatistical\b/i,
  /\bRNA-seq\b/i,
  /\bimmunofluorescence\b/i,
  /\bwestern\s+blot\b/i,
  /\bkey\s+resources?\s+table\b/i,
  /\bhepatoblast\s+isolation\b/i,
  /\bimage\s+analysis\b/i,
  /\bquantification\b/i,
  /\bcell\s+culture\b/i,
  /\banimal\b/i,
  /\bmicroscopy\b/i,
  /\bcloning\b/i,
];

export const BACKGROUND_SECTION_RE =
  /\b(?:introduction|background|overview|context|related\s+work|literature)\b/i;

export const RESULTS_SECTION_RE = /\b(?:results?|findings)\b/i;
export const DISCUSSION_SECTION_RE =
  /\b(?:discussion|conclusions?|perspectives?|outlook|limitations|summary)\b/i;

export type SectionRole =
  | "abstract"
  | "introduction"
  | "methods"
  | "results"
  | "discussion"
  | "figure"
  | "table"
  | "other";

/**
 * Coarse role of a seed-text block. Used so retrieval and adjudication can
 * tell the seed's own results from its background prose, which is where a
 * citer most often picks up someone else's claim as the seed's finding.
 */
export function classifySectionRole(
  blockKind: "abstract" | "body_paragraph" | "figure_caption" | "table_caption",
  sectionTitle: string | undefined,
): SectionRole {
  if (blockKind === "abstract") return "abstract";
  if (blockKind === "figure_caption") return "figure";
  if (blockKind === "table_caption") return "table";
  const title = sectionTitle ?? "";
  if (title.length === 0) return "other";
  // Methods is checked before results so "Results and Methods"-style headings
  // and methods subsections do not masquerade as findings.
  if (METHODS_SECTION_PATTERNS.some((re) => re.test(title))) return "methods";
  if (RESULTS_SECTION_RE.test(title)) return "results";
  if (DISCUSSION_SECTION_RE.test(title)) return "discussion";
  if (BACKGROUND_SECTION_RE.test(title)) return "introduction";
  return "other";
}
