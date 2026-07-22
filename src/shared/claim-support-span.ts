/**
 * Exact-verify an extracted claim support span against citation occurrence text.
 * Offsets are relative to the occurrence rawContext string.
 */

export type VerifiedClaimSupportSpan = {
  text: string;
  charOffsetStart: number;
  charOffsetEnd: number;
  verificationStatus: "verified_exact";
};

export function verifyClaimSupportSpan(
  rawContext: string,
  proposed: string | undefined,
): VerifiedClaimSupportSpan | undefined {
  if (proposed == null) return undefined;
  const trimmed = proposed.trim();
  if (trimmed.length === 0) return undefined;

  const exact = rawContext.indexOf(proposed);
  if (exact >= 0) {
    return {
      text: proposed,
      charOffsetStart: exact,
      charOffsetEnd: exact + proposed.length,
      verificationStatus: "verified_exact",
    };
  }

  const trimmedExact = rawContext.indexOf(trimmed);
  if (trimmedExact >= 0) {
    return {
      text: trimmed,
      charOffsetStart: trimmedExact,
      charOffsetEnd: trimmedExact + trimmed.length,
      verificationStatus: "verified_exact",
    };
  }

  const collapsed = findCollapsedWhitespaceMatch(rawContext, trimmed);
  if (!collapsed) return undefined;
  const text = rawContext.slice(collapsed.start, collapsed.end);
  return {
    text,
    charOffsetStart: collapsed.start,
    charOffsetEnd: collapsed.end,
    verificationStatus: "verified_exact",
  };
}

function findCollapsedWhitespaceMatch(
  haystack: string,
  needle: string,
): { start: number; end: number } | undefined {
  const collapsedNeedle = needle.replace(/\s+/g, " ").trim();
  if (collapsedNeedle.length === 0) return undefined;
  const parts = collapsedNeedle.split(" ").filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  const pattern = parts.map(escapeRegExp).join("\\s+");
  const match = new RegExp(pattern).exec(haystack);
  if (!match) return undefined;
  return { start: match.index, end: match.index + match[0].length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
