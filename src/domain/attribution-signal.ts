import type { EdgeClassification, ResolvedPaper } from "./types.js";

const REVIEW_TYPES = new Set(["review", "literature-review"]);
const BOOK_CHAPTER_TYPES = new Set(["book-chapter", "book-section"]);
const LETTER_TYPES = new Set(["letter", "erratum", "correction"]);
const COMMENTARY_TYPES = new Set(["editorial", "paratext", "peer-review"]);
const PREPRINT_TYPES = new Set(["posted-content", "preprint"]);
const ARTICLE_TYPES = new Set(["article", "journal-article"]);

const HIGH_REFERENCE_COUNT_THRESHOLD = 100;

const COMMENTARY_TITLE_PATTERNS = [
  /\breview\b/i,
  /\bcommentary\b/i,
  /\beditorial\b/i,
  /\bperspective\b/i,
  /\bnews\b/i,
  /\binterview\b/i,
  /\bthe people behind the papers\b/i,
  /\bletter to the editor\b/i,
  /\bcorrigendum\b/i,
  /\berratum\b/i,
  /\bretraction\b/i,
  /\bin brief\b/i,
  /\bhighlights?\b/i,
  /\bposition statement\b/i,
  /\bguidance\b/i,
  /\bhow much does that matter\b/i,
  /\boverview\b/i,
];

function matchesCommentaryTitle(title: string): boolean {
  return COMMENTARY_TITLE_PATTERNS.some((p) => p.test(title));
}

export function classifyEdge(paper: ResolvedPaper): EdgeClassification {
  const ptype = paper.paperType?.toLowerCase() ?? "";

  const isReview = REVIEW_TYPES.has(ptype);
  const isBookChapter = BOOK_CHAPTER_TYPES.has(ptype);
  const isLetter = LETTER_TYPES.has(ptype);
  const isCommentary =
    COMMENTARY_TYPES.has(ptype) || matchesCommentaryTitle(paper.title);
  const isPreprint = PREPRINT_TYPES.has(ptype);
  const isJournalArticle = ARTICLE_TYPES.has(ptype);

  const highReferenceCount =
    paper.referencedWorksCount != null &&
    paper.referencedWorksCount > HIGH_REFERENCE_COUNT_THRESHOLD;

  // A paper is "primary-like" if it is not a review, commentary, letter, or
  // book chapter. This is a candidate for the empirical-attribution pipeline
  // in M2 -- it says nothing about the paper's importance or quality.
  const isPrimaryLike =
    !isReview && !isBookChapter && !isLetter && !isCommentary;

  return {
    isReview,
    isCommentary,
    isLetter,
    isBookChapter,
    isPreprint,
    isJournalArticle,
    isPrimaryLike,
    highReferenceCount,
  };
}
