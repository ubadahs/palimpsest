/** Browser-safe contracts for frozen cases and blind annotation. */
import { z } from "zod";

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
export const adjudicationCaseSchema = z.object({
  ...caseBase,
  task: z.literal("adjudication"),
  unitKey: z.string().min(1),
  anthropicPrompt: z.string().min(1),
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
          .object({ claimRecordId: z.string(), claimText: z.string() })
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
          occurrenceClaims: { claimRecordId: string; claimText: string }[];
          selectedChunks: { chunkId: string; text: string }[];
        };
      }
  );

export const datasetSchema = z.object({
  schemaVersion: z.enum(["evaluation-dataset-v1", "evaluation-dataset-v2"]),
  builderVersion: z.enum(["evaluation-build-v1", "evaluation-build-v2"]),
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
});
export type EvaluationDataset = z.infer<typeof datasetSchema>;

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
