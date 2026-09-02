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
  /\bstatistic(?:s|al)\b/i,
  /\bRNA-seq\b/i,
  /\bimmunofluorescence\b/i,
  /\bwestern\s+blot\b/i,
  /\bkey\s+resources?\s+table\b/i,
  /\bhepatoblast\s+isolation\b/i,
  /\bimage\s+analysis\b/i,
  /\bquantification\b/i,
  /\bcell\s+culture\b/i,
  /\banimals?\b/i,
  /\bin\s+situ\s+hybridi[sz]ation\b/i,
  /\briboprobe\b/i,
  /\bslice\s+preparation\b/i,
  /\bantibod(?:y|ies)\b/i,
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

/**
 * Assign roles to a document's blocks in reading order. Titles that match a
 * known heading set the current role; unrecognized subsection titles (the
 * usual case for results subsections, which carry descriptive headings under
 * a parent "Results" the parser does not preserve) inherit it. An
 * unrecognized section that follows the abstract or introduction opens the
 * results. Captions keep their own role and do not move the cursor.
 */
export function inferSectionRoles(
  blocks: ReadonlyArray<{
    blockKind:
      | "abstract"
      | "body_paragraph"
      | "figure_caption"
      | "table_caption";
    sectionTitle?: string | undefined;
  }>,
): SectionRole[] {
  let current: SectionRole = "other";
  let previousTitle: string | undefined;
  return blocks.map((block) => {
    const own = classifySectionRole(block.blockKind, block.sectionTitle);
    if (block.blockKind !== "body_paragraph") {
      if (own === "abstract") current = "abstract";
      return own;
    }
    const title = block.sectionTitle ?? "";
    const newSection = title !== previousTitle;
    previousTitle = title;
    if (own !== "other") {
      current = own;
      return own;
    }
    if (title.length === 0) return current === "other" ? "other" : current;
    if (
      newSection &&
      (current === "abstract" ||
        current === "introduction" ||
        current === "other")
    ) {
      current = "results";
    }
    return current;
  });
}
