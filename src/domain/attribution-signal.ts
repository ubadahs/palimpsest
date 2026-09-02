const REVIEW_TYPES = new Set(["review", "literature-review"]);

/**
 * Provider paper-type signal used by Prepare to mark a citation as
 * review-mediated. Coarse by design: it says what the index calls the paper,
 * not what the paper is.
 */
export function isReviewPaperType(paperType: string | undefined): boolean {
  return REVIEW_TYPES.has(paperType?.toLowerCase() ?? "");
}
