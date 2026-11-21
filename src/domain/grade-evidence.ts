/** A field can be populated and still contain only a model placeholder. */
export function hasExplanation(text: string): boolean {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return (
    new Set(words).size >= 2 &&
    !/^(?:n a|not (?:applicable|available|provided|specified)|no (?:explanation|rationale|reason)(?: (?:provided|given|available))?|to be (?:determined|completed|added)|lorem ipsum(?: .*)?|placeholder(?: text)?|todo(?: .*)?|tbd(?: .*)?)$/u.test(
      words.join(" "),
    )
  );
}

/** Citation punctuation and a marker alone cannot substantiate a distortion. */
export function hasQuotedWording(text: string, marker?: string): boolean {
  if (marker && marker.includes(text.trim())) return false;
  const wording = marker ? text.replace(marker, "") : text;
  return (wording.match(/\p{L}{2,}/gu) ?? []).length >= 2;
}
