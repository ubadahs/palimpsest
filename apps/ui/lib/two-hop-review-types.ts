import { z } from "zod";

const text = z.string().min(1);
const sourceUrl = z.url({ protocol: /^https?$/ });
const caseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

const references = z.array(z.tuple([text, text]));
const source = z
  .object({
    title: text,
    citationLabel: text.optional(),
    version: text,
    url: sourceUrl,
    publicationUrl: sourceUrl.optional(),
    textKind: z.enum(["full_text", "excerpts"]).default("full_text"),
    text,
    findings: z.array(z.object({ locator: text, quote: text })).optional(),
  })
  .refine(
    (s) => s.findings?.every((f) => s.text.includes(f.quote)) ?? true,
    "Every finding must quote the supplied original text.",
  );
const relay = z
  .object({
    original: text,
    intermediate: text,
    block: text,
    passage: text,
    excerpt: text,
    citationGroupReferences: references.optional(),
  })
  .refine(
    (r) => r.passage.includes(r.excerpt) && /【[^】]+】/.test(r.excerpt),
    "The excerpt must contain the marked citation and occur in its passage.",
  );
const citation = z.object({
  locator: text,
  paragraphWithTargetMarker: text,
  citationGroupReferences: references,
});
const evidence = citation
  .extend({
    supportSpan: text,
    focus: text,
    markerInsideSpan: z.boolean(),
    targetReference: z.object({ refId: text, title: text }),
  })
  .refine(
    (e) =>
      e.supportSpan.includes(e.focus) &&
      e.paragraphWithTargetMarker
        .replace(/[【】]/g, "")
        .includes(e.supportSpan),
    "The focus and its supporting span must occur in the supplied paragraph.",
  );
const reviewCase = z.object({
  caseId,
  equivalentCaseIds: z.array(caseId).optional(),
  citingTitle: text,
  citingLabel: text.optional(),
  citingVersion: text,
  citingUrl: sourceUrl,
  citingPublicationUrl: sourceUrl.optional(),
  citingText: text.optional(),
  study: text,
  originalSource: text,
  originalBibliography: z
    .object({
      referenceIds: z.array(text),
      entriesChecked: z.number().int().nonnegative(),
      coverage: z.enum(["parsed", "complete"]),
    })
    .optional(),
  originalCitationGroup: z.array(citation).optional(),
  immediateSource: text,
  extractedClaimToCheck: text,
  evidence: z.array(evidence).min(1),
});

export const twoHopStudySchema = z
  .object({
    cases: z.array(reviewCase).min(1),
    relays: z.array(relay),
    sources: z.record(text, source),
  })
  .refine(({ cases, sources, relays }) => {
    const ids = cases.flatMap((c) => [
      c.caseId,
      ...(c.equivalentCaseIds ?? []),
    ]);
    return (
      new Set(ids).size === ids.length &&
      cases.every(
        (c) =>
          Object.hasOwn(sources, c.originalSource) &&
          Object.hasOwn(sources, c.immediateSource),
      ) &&
      relays.every(
        (r) =>
          Object.hasOwn(sources, r.intermediate) &&
          Object.hasOwn(sources, r.original) &&
          sources[r.intermediate]!.text.replace(/[【】]/g, "").includes(
            r.passage.replace(/[【】]/g, ""),
          ),
      )
    );
  }, "Review cases must have unique IDs and their citation passages must occur in the named papers.");

export const chainAssessments = [
  "faithful",
  "changed",
  "no_chain",
  "uncertain",
] as const;
const twoHopAnswerSchema = z.strictObject({
  chainAssessment: z.enum(chainAssessments),
  notes: z.string().max(20000).default(""),
});

export const saveTwoHopReviewSchema = z.strictObject({
  caseId,
  studyRevision: z.hash("sha256"),
  expectedRevision: z
    .string()
    .regex(/^[1-9]\d{0,8}$/)
    .nullable(),
  answer: twoHopAnswerSchema,
});

export type TwoHopSource = z.infer<typeof source>;
export type TwoHopEvidence = z.infer<typeof evidence>;
export type TwoHopCase = z.infer<typeof reviewCase>;
export type TwoHopAnswer = z.infer<typeof twoHopAnswerSchema>;
export type ChainAssessment = TwoHopAnswer["chainAssessment"];
export const priorReviewSchema = z.strictObject({
  sourceStudyRevision: z.hash("sha256"),
  sourceRevision: z.string().regex(/^[1-9]\d{0,8}$/),
  scope: z.enum(["previous_chain_question", "later_hop_only"]),
  reason: text,
});
type PriorTwoHopReview = z.infer<typeof priorReviewSchema> & {
  answer: TwoHopAnswer;
};
export type TwoHopReviewData = z.infer<typeof twoHopStudySchema> & {
  studyRevision: string;
  answers: Record<string, TwoHopAnswer>;
  revisions: Record<string, string>;
  priorReviews: Record<string, PriorTwoHopReview>;
};
