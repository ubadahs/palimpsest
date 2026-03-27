import type { DuplicateGroup, ResolvedPaper } from "../domain/types.js";

export type DedupResult = {
  uniquePapers: ResolvedPaper[];
  duplicateGroups: DuplicateGroup[];
};

// --- Title normalization for comparison ---

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Similarity: Jaccard on word bigrams ---

function bigrams(s: string): Set<string> {
  const words = s.split(" ");
  const result = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    result.add(`${words[i]} ${words[i + 1]}`);
  }
  return result;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const TITLE_SIMILARITY_THRESHOLD = 0.7;
const YEAR_PROXIMITY_MAX = 2;

// --- Author overlap: first or last author surname matches ---

function extractSurname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? fullName).toLowerCase();
}

function hasAuthorOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;

  const firstA = extractSurname(a[0]!);
  const lastA = a.length > 1 ? extractSurname(a[a.length - 1]!) : firstA;
  const firstB = extractSurname(b[0]!);
  const lastB = b.length > 1 ? extractSurname(b[b.length - 1]!) : firstB;

  return (
    firstA === firstB || lastA === lastB || firstA === lastB || lastA === firstB
  );
}

function yearClose(a: number | undefined, b: number | undefined): boolean {
  if (a == null || b == null) return true;
  return Math.abs(a - b) <= YEAR_PROXIMITY_MAX;
}

// --- Prefer published article over preprint ---

const PREFERRED_TYPES = new Set(["article", "journal-article"]);

function pickRepresentative(papers: ResolvedPaper[]): ResolvedPaper {
  const published = papers.find(
    (p) => p.paperType != null && PREFERRED_TYPES.has(p.paperType),
  );
  return published ?? papers[0]!;
}

// --- Main dedup function ---

export function deduplicatePapers(papers: ResolvedPaper[]): DedupResult {
  if (papers.length === 0) {
    return { uniquePapers: [], duplicateGroups: [] };
  }

  const groups: ResolvedPaper[][] = [];
  const reasons: string[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < papers.length; i++) {
    if (assigned.has(i)) continue;

    const group = [papers[i]!];
    const groupReasons = ["original"];
    assigned.add(i);

    for (let j = i + 1; j < papers.length; j++) {
      if (assigned.has(j)) continue;

      const reason = findCollapseReason(papers[i]!, papers[j]!);
      if (reason) {
        group.push(papers[j]!);
        groupReasons.push(reason);
        assigned.add(j);
      }
    }

    groups.push(group);
    reasons.push(groupReasons);
  }

  const uniquePapers: ResolvedPaper[] = [];
  const duplicateGroups: DuplicateGroup[] = [];

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    const rep = pickRepresentative(group);
    uniquePapers.push(rep);

    if (group.length > 1) {
      const collapseReasons = reasons[g]!.filter((r) => r !== "original").join(
        "; ",
      );

      duplicateGroups.push({
        duplicateGroupId: `dedup-${String(g)}`,
        keptRepresentativePaperId: rep.id,
        collapsedFromPaperIds: group
          .map((p) => p.id)
          .filter((id) => id !== rep.id),
        collapseReason: collapseReasons,
      });
    }
  }

  return { uniquePapers, duplicateGroups };
}

function findCollapseReason(
  a: ResolvedPaper,
  b: ResolvedPaper,
): string | undefined {
  if (a.doi && b.doi && a.doi === b.doi) {
    return "doi-match";
  }

  const normA = normalizeTitle(a.title);
  const normB = normalizeTitle(b.title);

  if (normA === normB && hasAuthorOverlap(a.authors, b.authors)) {
    return "exact-title+author-overlap";
  }

  const simScore = jaccardSimilarity(bigrams(normA), bigrams(normB));
  if (
    simScore >= TITLE_SIMILARITY_THRESHOLD &&
    hasAuthorOverlap(a.authors, b.authors) &&
    yearClose(a.publicationYear, b.publicationYear)
  ) {
    return `title-similarity(${simScore.toFixed(2)})+author-overlap+year-proximity`;
  }

  return undefined;
}
