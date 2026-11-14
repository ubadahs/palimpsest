import { z } from "zod";

import { buildClaimUnitKey } from "../contract/claim-unit.js";
import type { ReportInspectorRecordRow } from "../contract/inspector-payloads.js";
import { compareCodeUnits } from "../shared/order.js";
import { sha256Text } from "../shared/stable-identity.js";

/**
 * A short review a seed paper's author can do offline: a handful of citing
 * restatements of their paper, each judged with one click, in a single HTML
 * file they open, answer, save, and email back. It is a lighter instrument
 * than the report-bound human review: the author gives a verdict and a note,
 * not a packet audit, so the answers are stored on their own.
 */

const authorAnswerValues = ["accurate", "changed", "wrong", "unsure"] as const;
const authorAnswerSchema = z.enum(authorAnswerValues);
export type AuthorAnswer = z.infer<typeof authorAnswerSchema>;

/** The machine verdict each answer corresponds to. */
export const AUTHOR_ANSWER_VERDICT: Record<
  AuthorAnswer,
  "F" | "D" | "E" | "U"
> = { accurate: "F", changed: "D", wrong: "E", unsure: "U" };

const verdictSchema = z.enum(["F", "D", "E", "U"]);

const authorReviewItemSchema = z
  .object({
    itemId: z.string().min(1),
    recordIds: z.array(z.string().min(1)).min(1),
    citingPaperTitle: z.string(),
    citingPaperYear: z.number().int().optional(),
    /** Exact quotes from the author's paper the adjudicator relied on. */
    seedQuotes: z.array(z.string().min(1)),
    /** The adjudicator's summary, shown only when it quoted nothing. */
    seedSummary: z.string().optional(),
    citingSentence: z.string().min(1),
    paragraph: z.string(),
    /** Where `citingSentence` sits in `paragraph`, when it was verified there. */
    sentenceOffset: z.number().int().nonnegative().optional(),
    /** Where the author's citation marker sits in `paragraph`, to point it out. */
    markerSpan: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      })
      .strict()
      .optional(),
    ours: z
      .object({ verdict: verdictSchema, explanation: z.string() })
      .strict(),
  })
  .strict();
export type AuthorReviewItem = z.infer<typeof authorReviewItemSchema>;

const authorReviewDataSchema = z
  .object({
    schemaVersion: z.literal("author-review-v1"),
    lineage: z
      .object({
        runId: z.string().min(1),
        reportArtifactId: z.string().min(1),
        reportContentHash: z.string().min(1),
      })
      .strict(),
    seedTitle: z.string(),
    readerName: z.string().optional(),
    /** Distinct restatements in the report, of which `items` is a sample. */
    restatementCount: z.number().int().nonnegative(),
    /** Items left out by hand, recorded so the file says what was dropped. */
    excludedItemIds: z.array(z.string().min(1)).optional(),
    items: z.array(authorReviewItemSchema).min(1),
  })
  .strict();
export type AuthorReviewData = z.infer<typeof authorReviewDataSchema>;

/**
 * What the reader chose. `first` is their answer before our verdict was shown,
 * the blind label; `final` is where they left it, which may differ once they
 * have seen ours.
 */
const authorAnswersSchema = z.record(
  z.string(),
  z
    .object({
      first: authorAnswerSchema,
      final: authorAnswerSchema,
      note: z.string(),
    })
    .strict(),
);
export type AuthorAnswers = z.infer<typeof authorAnswersSchema>;

const FLAGGED = new Set(["D", "E", "U"]);
/** Most to least severe, so a unit shows its most serious machine outcome. */
const SEVERITY = ["E", "D", "U", "F"] as const;

/**
 * Pick the restatements to show: every flagged one (D, E, U) plus
 * `faithfulSample` of those judged faithful, so the set does not look
 * pre-sorted. A citing paper's restatement is one item however many records it
 * spans (the claim-unit rule Report counts with), and a citing sentence shown
 * once is not shown again for another of the seed's findings. The sample and
 * the order are fixed by `sampleKey`, so rebuilding gives the same file.
 * `excludeItemIds` drops items found broken on inspection before sampling, so
 * a dropped faithful item is replaced by the next one; `unknownExclusions`
 * names any that matched nothing.
 */
export function selectAuthorReviewItems(input: {
  rows: readonly ReportInspectorRecordRow[];
  faithfulSample: number;
  sampleKey: string;
  excludeItemIds?: readonly string[];
}): {
  items: AuthorReviewItem[];
  restatementCount: number;
  unknownExclusions: string[];
} {
  const units = new Map<string, ReportInspectorRecordRow[]>();
  for (const row of input.rows) {
    if (row.adjudicationStatus !== "adjudicated" || !row.verdict) continue;
    const unitKey = buildClaimUnitKey({
      familyId: row.familyId,
      citingPaperId: row.citingPaperId,
      claimTexts: row.occurrenceClaims.map((claim) => claim.extractedClaimText),
    });
    units.set(unitKey, [...(units.get(unitKey) ?? []), row]);
  }

  const rank = (key: string, salt: string) =>
    sha256Text(`${salt}:${input.sampleKey}:${key}`);
  const candidates = [...units.entries()]
    .map(([unitKey, rows]) => {
      const exemplar = [...rows].sort(
        (left, right) =>
          SEVERITY.indexOf(left.verdict!) - SEVERITY.indexOf(right.verdict!) ||
          compareCodeUnits(left.recordId, right.recordId),
      )[0]!;
      return { unitKey, rows, exemplar, item: toItem(unitKey, rows, exemplar) };
    })
    .filter((candidate) => candidate.item != null)
    // Flagged first, so a sentence shared with a faithful unit keeps the flag.
    .sort(
      (left, right) =>
        SEVERITY.indexOf(left.exemplar.verdict!) -
          SEVERITY.indexOf(right.exemplar.verdict!) ||
        compareCodeUnits(
          rank(left.unitKey, "pick"),
          rank(right.unitKey, "pick"),
        ),
    );

  const excluded = new Set(input.excludeItemIds ?? []);
  const seenSentences = new Set<string>();
  const distinct = candidates.filter(({ exemplar, item }) => {
    const key = `${exemplar.citingPaperId}\u0000${item!.citingSentence}`;
    if (seenSentences.has(key)) return false;
    seenSentences.add(key);
    return true;
  });
  const eligible = distinct.filter(({ item }) => !excluded.has(item!.itemId));
  const flagged = eligible.filter(({ exemplar }) =>
    FLAGGED.has(exemplar.verdict!),
  );
  const faithful = eligible
    .filter(({ exemplar }) => !FLAGGED.has(exemplar.verdict!))
    .slice(0, input.faithfulSample);
  const known = new Set(distinct.map(({ item }) => item!.itemId));

  return {
    items: [...flagged, ...faithful]
      .sort((left, right) =>
        compareCodeUnits(
          rank(left.unitKey, "order"),
          rank(right.unitKey, "order"),
        ),
      )
      .map(({ item }) => item!),
    restatementCount: distinct.length,
    unknownExclusions: [...excluded].filter((itemId) => !known.has(itemId)),
  };
}

function toItem(
  unitKey: string,
  rows: readonly ReportInspectorRecordRow[],
  exemplar: ReportInspectorRecordRow,
): AuthorReviewItem | undefined {
  const span = exemplar.occurrenceClaims.find(
    (claim) => claim.supportSpan,
  )?.supportSpan;
  if (!span) return undefined;
  const paragraph = exemplar.citationContext;
  const verified =
    paragraph.slice(span.charOffsetStart, span.charOffsetEnd) === span.text;
  const marker = exemplar.citationMarkerSpan;
  const seedQuotes = (exemplar.seedQuotes ?? [])
    .map((quote) => quote.quote)
    .slice(0, 2);
  return {
    itemId: sha256Text(unitKey).slice(0, 16),
    recordIds: rows.map((row) => row.recordId).sort(compareCodeUnits),
    citingPaperTitle: exemplar.citingPaperTitle,
    ...(exemplar.citingPaperYear != null
      ? { citingPaperYear: exemplar.citingPaperYear }
      : {}),
    seedQuotes,
    ...(seedQuotes.length === 0 && exemplar.sourceStatement
      ? { seedSummary: inAuthorTerms(exemplar.sourceStatement) }
      : {}),
    citingSentence: span.text,
    paragraph,
    ...(verified ? { sentenceOffset: span.charOffsetStart } : {}),
    ...(marker
      ? {
          markerSpan: {
            start: marker.charOffsetStart,
            end: marker.charOffsetEnd,
          },
        }
      : {}),
    ours: {
      verdict: exemplar.verdict!,
      explanation: inAuthorTerms(
        exemplar.rationale ?? exemplar.sourceStatement ?? "",
      ),
    },
  };
}

/**
 * The adjudicator writes for the pipeline: the author's paper is "the seed",
 * and the part of a claim it does support is the "kernel". Say both the way
 * the author would.
 */
export function inAuthorTerms(text: string): string {
  return text
    .replace(
      /\b([Tt])he seed(?: paper)?('s)?\b/g,
      (_match, t: string, possessive: string | undefined) =>
        `${t === "T" ? "Your" : "your"} paper${possessive ?? ""}`,
    )
    .replace(/\bkernels?\b/g, (word) =>
      word.endsWith("s") ? "core points" : "core point",
    );
}

const DATA_ELEMENT_ID = "author-review-data";
const ANSWERS_ELEMENT_ID = "author-review-answers";

/** JSON safe inside a `<script>` element: no `</script>` can close it early. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

export const AUTHOR_REVIEW_ELEMENT_IDS = {
  data: DATA_ELEMENT_ID,
  answers: ANSWERS_ELEMENT_ID,
} as const;

/** Read the review data and the reader's answers back out of a returned file. */
export function readAuthorReviewFile(
  html: string,
):
  | { ok: true; data: AuthorReviewData; answers: AuthorAnswers }
  | { ok: false; error: string } {
  const read = (id: string): unknown => {
    const match = new RegExp(
      `<script type="application/json" id="${id}">([\\s\\S]*?)</script>`,
    ).exec(html);
    if (!match) throw new Error(`The file has no ${id} block`);
    return JSON.parse(match[1]!);
  };
  try {
    const data = authorReviewDataSchema.safeParse(read(DATA_ELEMENT_ID));
    if (!data.success) return { ok: false, error: data.error.message };
    const answers = authorAnswersSchema.safeParse(read(ANSWERS_ELEMENT_ID));
    if (!answers.success) return { ok: false, error: answers.error.message };
    const itemIds = new Set(data.data.items.map((item) => item.itemId));
    const unknown = Object.keys(answers.data).find((id) => !itemIds.has(id));
    if (unknown)
      return { ok: false, error: `Answer for unknown item ${unknown}` };
    return { ok: true, data: data.data, answers: answers.data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
