import { z } from "zod";

import { normalizeDiscoverClaimText } from "../contract/claim-unit.js";
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

const citingPaperSchema = z
  .object({ title: z.string(), year: z.number().int().optional() })
  .strict();

const authorReviewItemSchema = z
  .object({
    /** A hash of the sentence, so the same sentence keeps its id across runs. */
    itemId: z.string().min(1),
    /** Every record the sentence produced, each with the tool's verdict. */
    records: z
      .array(
        z
          .object({ recordId: z.string().min(1), verdict: verdictSchema })
          .strict(),
      )
      .min(1),
    citingPaperTitle: z.string(),
    citingPaperYear: z.number().int().optional(),
    /** Other papers that print the same sentence word for word. */
    alsoIn: z.array(citingPaperSchema).optional(),
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

/** The report a review file was made from. */
const lineageSchema = z
  .object({
    runId: z.string().min(1),
    reportArtifactId: z.string().min(1),
    reportContentHash: z.string().min(1),
  })
  .strict();

const authorReviewDataSchema = z
  .object({
    schemaVersion: z.literal("author-review-v1"),
    lineage: lineageSchema,
    seedTitle: z.string(),
    readerName: z.string().optional(),
    /** Distinct citing sentences in the report, of which `items` is a sample. */
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
const authorItemAnswerSchema = z
  .object({
    first: authorAnswerSchema,
    final: authorAnswerSchema,
    note: z.string(),
  })
  .strict();
type AuthorItemAnswer = z.infer<typeof authorItemAnswerSchema>;
const authorAnswersSchema = z.record(z.string(), authorItemAnswerSchema);
export type AuthorAnswers = z.infer<typeof authorAnswersSchema>;

/**
 * A returned file as `author-review:import` stores it, beside the report it
 * was made from: each item's records with the verdict the tool gave them, the
 * verdict the reader was shown, and their answer.
 */
export const storedAuthorReviewSchema = z
  .object({
    schemaVersion: z.literal("author-review-answers-v1"),
    lineage: lineageSchema,
    reader: z.string().optional(),
    importedAt: z.string().datetime(),
    items: z.array(
      z
        .object({
          itemId: z.string().min(1),
          records: z
            .array(
              z
                .object({ recordId: z.string().min(1), verdict: verdictSchema })
                .strict(),
            )
            .min(1),
          shownVerdict: verdictSchema,
          answer: authorItemAnswerSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type StoredAuthorReview = z.infer<typeof storedAuthorReviewSchema>;

/**
 * The label an author's answer gives: where they left it, `exposed` when that
 * moved after the tool's verdict was shown (the first answer alone was
 * blind). "Not sure" gives none: it says the reader could not judge, not the
 * rubric's U, which is an ambiguity in the evidence.
 */
export function authorAnswerLabel(
  answer: AuthorItemAnswer,
): { verdict: "F" | "D" | "E"; exposed: boolean } | undefined {
  if (answer.final === "unsure") return undefined;
  return {
    verdict: AUTHOR_ANSWER_VERDICT[answer.final] as "F" | "D" | "E",
    exposed: answer.final !== answer.first,
  };
}

const FLAGGED = new Set(["D", "E", "U"]);
/** Most to least severe, so an item shows its most serious machine outcome. */
const SEVERITY = ["E", "D", "U", "F"] as const;

/**
 * Pick what to show: one item per distinct citing sentence, since that is what
 * the reader judges. An item carries every record its sentence produced,
 * whether one paper restates several findings in it or a second paper reprints
 * it word for word, so one answer covers them all and nothing is dropped.
 *
 * Every flagged sentence (D, E, U) is shown, plus `faithfulSample` of those
 * judged faithful, so the set does not look pre-sorted. The sample and the
 * order are fixed by `sampleKey`, so rebuilding gives the same file.
 * `excludeItemIds` leaves out items a person found broken, before sampling, so
 * a dropped faithful item is replaced by the next one; the file records them,
 * and `unknownExclusions` names any that matched nothing.
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
  const bySentence = new Map<string, ReportInspectorRecordRow[]>();
  for (const row of input.rows) {
    // Adjudication requires a verified support span, so every verdict has one.
    const span = row.occurrenceClaims.find(
      (claim) => claim.supportSpan,
    )?.supportSpan;
    if (row.adjudicationStatus !== "adjudicated" || !row.verdict || !span)
      continue;
    const key = normalizeDiscoverClaimText(span.text);
    bySentence.set(key, [...(bySentence.get(key) ?? []), row]);
  }

  const rank = (key: string, salt: string) =>
    sha256Text(`${salt}:${input.sampleKey}:${key}`);
  const candidates = [...bySentence.entries()].map(([sentenceKey, rows]) => {
    const ordered = [...rows].sort(
      (left, right) =>
        SEVERITY.indexOf(left.verdict!) - SEVERITY.indexOf(right.verdict!) ||
        compareCodeUnits(left.recordId, right.recordId),
    );
    return {
      sentenceKey,
      exemplar: ordered[0]!,
      item: toItem(sentenceKey, ordered),
    };
  });

  const excluded = new Set(input.excludeItemIds ?? []);
  const eligible = candidates
    .filter(({ item }) => !excluded.has(item.itemId))
    .sort((left, right) =>
      compareCodeUnits(
        rank(left.sentenceKey, "pick"),
        rank(right.sentenceKey, "pick"),
      ),
    );
  const flagged = eligible.filter(({ exemplar }) =>
    FLAGGED.has(exemplar.verdict!),
  );
  const faithful = spreadAcrossPapers(
    eligible.filter(({ exemplar }) => !FLAGGED.has(exemplar.verdict!)),
    new Set(flagged.map(({ exemplar }) => exemplar.citingPaperId)),
  ).slice(0, input.faithfulSample);
  const known = new Set(candidates.map(({ item }) => item.itemId));

  return {
    items: [...flagged, ...faithful]
      .sort((left, right) =>
        compareCodeUnits(
          rank(left.sentenceKey, "order"),
          rank(right.sentenceKey, "order"),
        ),
      )
      .map(({ item }) => item),
    restatementCount: candidates.length,
    unknownExclusions: [...excluded].filter((itemId) => !known.has(itemId)),
  };
}

/**
 * Candidates in their sampled order, but one per citing paper first, starting
 * with papers no flagged item already shows; repeats follow only if the sample
 * needs them. Two faithful restatements from one paper teach the reader
 * nothing the first did not.
 */
function spreadAcrossPapers<T extends { exemplar: ReportInspectorRecordRow }>(
  candidates: readonly T[],
  shownPapers: ReadonlySet<string>,
): T[] {
  const used = new Set(shownPapers);
  const first: T[] = [];
  const repeats: T[] = [];
  for (const candidate of candidates) {
    const paper = candidate.exemplar.citingPaperId;
    (used.has(paper) ? repeats : first).push(candidate);
    used.add(paper);
  }
  return [...first, ...repeats];
}

/**
 * `rows` share one citing sentence, most severe verdict first; that record's
 * paper, paragraph, quotes, and explanation are what the reader sees.
 */
function toItem(
  sentenceKey: string,
  rows: readonly ReportInspectorRecordRow[],
): AuthorReviewItem {
  const exemplar = rows[0]!;
  const span = exemplar.occurrenceClaims.find(
    (claim) => claim.supportSpan,
  )!.supportSpan!;
  const paragraph = exemplar.citationContext;
  const verified =
    paragraph.slice(span.charOffsetStart, span.charOffsetEnd) === span.text;
  const marker = exemplar.citationMarkerSpan;
  const seedQuotes = (exemplar.seedQuotes ?? [])
    .map((quote) => quote.quote)
    .slice(0, 2);
  const alsoIn = [
    ...new Map(
      rows
        .filter((row) => row.citingPaperId !== exemplar.citingPaperId)
        .map((row) => [
          row.citingPaperId,
          {
            title: row.citingPaperTitle,
            ...(row.citingPaperYear != null
              ? { year: row.citingPaperYear }
              : {}),
          },
        ]),
    ).values(),
  ];
  return {
    itemId: sha256Text(sentenceKey).slice(0, 16),
    records: rows
      .map((row) => ({ recordId: row.recordId, verdict: row.verdict! }))
      .sort((left, right) => compareCodeUnits(left.recordId, right.recordId)),
    citingPaperTitle: exemplar.citingPaperTitle,
    ...(exemplar.citingPaperYear != null
      ? { citingPaperYear: exemplar.citingPaperYear }
      : {}),
    ...(alsoIn.length > 0 ? { alsoIn } : {}),
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
 * The adjudication prompts call the author's paper "the cited paper" (the
 * rubric's plain-wording rule), and the rationales echo it; the author reads
 * "your paper".
 */
export function inAuthorTerms(text: string): string {
  return text.replace(
    /\b([Tt])he cited paper\b/g,
    (_match, t: string) => `${t === "T" ? "Your" : "your"} paper`,
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
