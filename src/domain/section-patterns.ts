/**
 * Shared regex patterns for classifying sections and context by type.
 * Used by both the M2 mention-analysis layer and the M2.5 triage classifier.
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

export const BIBLIOGRAPHY_SIGNALS: RegExp[] = [
  /\breferences\b/i,
  /\bbibliography\b/i,
  /^\s*\d+\.\s+[A-Z][a-z]+\s+[A-Z]/m,
  /(?:Lancet|Nature|Science|Cell|PNAS|eLife|PLoS|J\s+Cell\s+Biol)\b.*\d{4}/,
];

export const BACKGROUND_SECTION_RE =
  /\b(?:introduction|background|overview|context|related\s+work|literature)\b/i;
