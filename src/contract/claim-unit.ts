/**
 * The unit of analysis: one seed finding, as restated by one citing paper,
 * about one set of attributed claims.
 *
 * Several `family × citation occurrence` records can describe the same unit —
 * a citer that mentions the seed twice in one paragraph produces two packets
 * for one restatement. Report rates and human calibration must count units,
 * not packets, and must count them the same way, so the rule lives here once.
 */
export function normalizeDiscoverClaimText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export function buildClaimUnitKey(input: {
  familyId: string;
  citingPaperId: string;
  claimTexts: readonly string[];
}): string {
  const claimKey = input.claimTexts
    .map(normalizeDiscoverClaimText)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .join("\u0001");
  return [input.familyId, input.citingPaperId, claimKey].join("\u0000");
}
