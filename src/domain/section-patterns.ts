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
