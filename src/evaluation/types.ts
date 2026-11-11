/** Browser-safe contracts for frozen cases and blind annotation. */
import { z } from "zod";
import { mutationKindSchema } from "../domain/taxonomy.js";

export const evaluationTaskSchema = z.enum([
  "role",
  "rerank",
  "span",
  "adjudication",
]);
export type EvaluationTask = z.infer<typeof evaluationTaskSchema>;

export const evaluationRoleSchema = z.enum([
  "substantive_attribution",
  "background_context",
  "methods_materials",
  "acknowledgment_or_low_information",
  "unclear",
]);
export const evaluationVerdictSchema = z.enum(["F", "D", "E", "U"]);
export const relevanceGradeSchema = z.enum([
  "irrelevant",
  "contextual",
  "direct",
  "cannot_judge",
]);

const caseBase = {
  caseId: z.string().min(1),
  runId: z.string().min(1),
  seedDoi: z.string().min(1),
  recordId: z.string().min(1),
  sourceArtifactHashes: z.record(z.string(), z.string().min(1)),
};

export const roleCaseSchema = z.object({
  ...caseBase,
  task: z.literal("role"),
  occurrenceId: z.string().min(1),
  context: z.string().min(1),
  claims: z.array(z.string().min(1)).min(1),
  sectionTitle: z.string().optional(),
  seedRefLabel: z.string().optional(),
  deterministicRole: evaluationRoleSchema,
  deterministicUnclear: z.boolean(),
  anthropicPrompt: z.string().min(1),
  /** Frozen scientific input for the Jev role-v2 request; absent in v1. */
  roleInput: z
    .object({
      markedContext: z.string().min(1),
      citationMarker: z.string().min(1),
      supportSpans: z.array(z.string().min(1)).min(1),
      sectionTitle: z.string().nullable(),
      seedRefLabel: z.string().nullable(),
      isBundledCitation: z.boolean(),
      bundleSize: z.number().int().positive(),
    })
    .optional(),
});
export const rerankCaseSchema = z.object({
  ...caseBase,
  task: z.literal("rerank"),
  query: z.string().min(1),
  candidates: z
    .array(
      z.object({
        chunkId: z.string().min(1),
        text: z.string().min(1),
        sourceBlockKind: z.string().min(1),
        sectionTitle: z.string().optional(),
        sectionRole: z.string().optional(),
        citesOtherWork: z.boolean().optional(),
      }),
    )
    .min(1),
  pinnedPassages: z.array(
    z.object({ chunkId: z.string().min(1), text: z.string().min(1) }),
  ),
  bm25Order: z.array(z.string().min(1)).min(1),
  pinnedChunkIds: z.array(z.string().min(1)),
  selectionLimit: z.number().int().positive(),
});
export const spanCaseSchema = z.object({
  ...caseBase,
  task: z.literal("span"),
  claimRecordId: z.string().min(1),
  claim: z.string().min(1),
  context: z.string().min(1),
});
/**
 * What an edit of a faithful restatement should earn. A distortion moves the
 * meaning in one named way; a control changes only the wording, so anything
 * but `F` on it is a false alarm.
 */
export const distortionExpectation = {
  expectedVerdict: z.enum(["D", "E"]),
  mutationKind: mutationKindSchema,
  direction: z.enum(["strengthened", "weakened", "shifted"]),
};
export const controlExpectation = { expectedVerdict: z.literal("F") };

const constructedProvenance = {
  sourceCaseId: z.string().min(1),
  /** Why the edit does, or does not, change what is attributed to the seed. */
  rationale: z.string().min(1),
  /**
   * True when grounding pins fill the source's evidence packet, so the
   * pipeline would select the same chunks whatever the citing wording. Only
   * these cases compare chunk evidence with whole-paper evidence fairly.
   */
  evidencePinned: z.boolean(),
};

/**
 * Marks a case made by editing a restatement a human labelled faithful, so
 * the right verdict is known by construction. It is never shown to a blind
 * reviewer or a provider.
 */
export const constructedLabelSchema = z.discriminatedUnion("expectedVerdict", [
  z.object({ ...constructedProvenance, ...distortionExpectation }),
  z.object({ ...constructedProvenance, ...controlExpectation }),
]);
export type ConstructedLabel = z.infer<typeof constructedLabelSchema>;

export const adjudicationCaseSchema = z.object({
  ...caseBase,
  task: z.literal("adjudication"),
  unitKey: z.string().min(1),
  anthropicPrompt: z.string().min(1),
  constructed: constructedLabelSchema.optional(),
  packet: z
    .object({
      citationRole: z.string(),
      evaluationMode: z.string(),
      markedCitingContext: z.string(),
      familyTrackedClaim: z.string(),
      citingPaperTitle: z.string(),
      citedPaperTitle: z.string(),
      occurrenceClaims: z.array(
        z
          .object({
            claimRecordId: z.string(),
            claimText: z.string(),
            supportSpanText: z.string().optional(),
          })
          .passthrough(),
      ),
      selectedChunks: z.array(
        z.object({ chunkId: z.string(), text: z.string() }).passthrough(),
      ),
    })
    .passthrough(),
});
export const evaluationCaseSchema = z.discriminatedUnion("task", [
  roleCaseSchema,
  rerankCaseSchema,
  spanCaseSchema,
  adjudicationCaseSchema,
]);
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

type BlindCaseBase = Pick<
  EvaluationCase,
  "caseId" | "runId" | "seedDoi" | "recordId"
>;
export type BlindEvaluationCase = BlindCaseBase &
  (
    | {
        task: "role";
        context: string;
        claims: string[];
        sectionTitle?: string;
        seedRefLabel?: string;
      }
    | {
        task: "rerank";
        query: string;
        candidates: { chunkId: string; text: string }[];
      }
    | { task: "span"; claim: string; context: string }
    | {
        task: "adjudication";
        packet: {
          markedCitingContext: string;
          familyTrackedClaim: string;
          citingPaperTitle: string;
          citedPaperTitle: string;
          occurrenceClaims: {
            claimRecordId: string;
            claimText: string;
            /** The exact citing text the claim was extracted from. */
            supportSpanText?: string;
          }[];
          selectedChunks: { chunkId: string; text: string }[];
        };
      }
  );

/** The seed paper's full text, stored once per seed for whole-paper adjudication. */
export const seedDocumentSchema = z.object({
  seedDoi: z.string().min(1),
  title: z.string().min(1),
  blocks: z
    .array(
      z.object({
        blockId: z.string().min(1),
        text: z.string().min(1),
        blockKind: z.string().min(1),
        sectionTitle: z.string().optional(),
        sectionRole: z.string().optional(),
        citesOtherWork: z.boolean(),
      }),
    )
    .min(1),
});
export type SeedDocument = z.infer<typeof seedDocumentSchema>;

export const datasetSchema = z.object({
  schemaVersion: z.enum([
    "evaluation-dataset-v1",
    "evaluation-dataset-v2",
    "evaluation-dataset-v3",
  ]),
  builderVersion: z.enum([
    "evaluation-build-v1",
    "evaluation-build-v2",
    "evaluation-build-v3",
  ]),
  datasetId: z.string().min(1),
  name: z.string().min(1),
  sources: z
    .array(
      z.object({
        runId: z.string(),
        reportArtifactId: z.string(),
        reportContentHash: z.string(),
      }),
    )
    .min(1),
  cases: z.array(evaluationCaseSchema),
  /** Present from v3 on. */
  seedDocuments: z.array(seedDocumentSchema).optional(),
});
export type EvaluationDataset = z.infer<typeof datasetSchema>;

/**
 * Asks a reviewer for labels on a chosen set of cases and says why. It adds
 * nothing to the dataset: the cases are already in it, and the labels land in
 * its annotation log like any others.
 */
export const gradingRequestSchema = z.object({
  schemaVersion: z.literal("evaluation-grading-request-v1"),
  requestId: z.string().min(1),
  datasetId: z.string().min(1),
  title: z.string().min(1),
  /** What the labels will decide. The reviewer reads it, so it must not hint at an answer. */
  purpose: z.string().min(1),
  /** Cases of one task, in the order the reviewer sees them. */
  caseIds: z.array(z.string().min(1)).min(1),
  createdAt: z.string().datetime(),
});
export type GradingRequest = z.infer<typeof gradingRequestSchema>;

export const annotationValueSchema = z.discriminatedUnion("task", [
  z.object({ task: z.literal("role"), role: evaluationRoleSchema }),
  z.object({
    task: z.literal("rerank"),
    grades: z.record(z.string(), relevanceGradeSchema),
  }),
  z.object({
    task: z.literal("span"),
    spans: z.array(
      z.object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      }),
    ),
    noValidSpan: z.boolean(),
  }),
  z.object({
    task: z.literal("adjudication"),
    verdict: z.union([evaluationVerdictSchema, z.literal("not_adjudicable")]),
    packetQuality: z.enum(["valid", "invalid", "unclear"]),
    evidenceSufficiency: z.enum(["sufficient", "limited"]),
  }),
]);
export type AnnotationValue = z.infer<typeof annotationValueSchema>;
export const annotationEventSchema = z.object({
  eventId: z.string(),
  caseId: z.string(),
  reviewer: z.string().min(1),
  createdAt: z.string().datetime(),
  status: z.enum(["draft", "final"]),
  expectedHeadEventId: z.string().nullable(),
  supersedesEventId: z.string().optional(),
  exposed: z.boolean(),
  notes: z.string(),
  value: annotationValueSchema,
  resolvesConflict: z.boolean().optional(),
});
export type AnnotationEvent = z.infer<typeof annotationEventSchema>;
export const revealEventSchema = z.object({
  eventId: z.string(),
  caseId: z.string(),
  reviewer: z.string().min(1),
  createdAt: z.string().datetime(),
});
export const annotationLogSchema = z.object({
  schemaVersion: z.literal("evaluation-annotations-v1"),
  datasetId: z.string(),
  events: z.array(z.union([annotationEventSchema, revealEventSchema])),
});
export type AnnotationLog = z.infer<typeof annotationLogSchema>;
