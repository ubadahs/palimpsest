import { z } from "zod";

import {
  fidelityTopLabelSchema,
  mutationKindSchema,
  mutationKindValues,
} from "../domain/taxonomy.js";
import {
  leanArtifactIdSchema,
  sha256DigestSchema,
} from "./lean-artifact-primitives.js";

/** Re-exported so the review form and the adjudicator cannot drift apart. */
export { mutationKindValues };

export const humanReviewStatusValues = ["draft", "final"] as const;
export const humanReviewStatusSchema = z.enum(humanReviewStatusValues);
export type HumanReviewStatus = z.infer<typeof humanReviewStatusSchema>;

export const humanYesNoSchema = z.enum(["yes", "no"]);
export type HumanYesNo = z.infer<typeof humanYesNoSchema>;

export const humanYesNoNaSchema = z.enum(["yes", "no", "not_applicable"]);
export type HumanYesNoNa = z.infer<typeof humanYesNoNaSchema>;

/**
 * The reviewer's own label. `not_adjudicable` is the human counterpart of an
 * operational non-verdict: the record should not have been judged at all. It
 * is never a fidelity outcome, so it stays out of `FidelityTopLabel`.
 */
export const humanVerdictSchema = z.enum([
  ...fidelityTopLabelSchema.options,
  "not_adjudicable",
]);
export type HumanVerdict = z.infer<typeof humanVerdictSchema>;

export const humanEvidenceSufficiencySchema = z.enum(["sufficient", "limited"]);
export type HumanEvidenceSufficiency = z.infer<
  typeof humanEvidenceSufficiencySchema
>;

export const correctedCitingSpanSchema = z
  .object({
    text: z.string().min(1),
    charOffsetStart: z.number().int().nonnegative(),
    charOffsetEnd: z.number().int().positive(),
  })
  .strict()
  .superRefine((span, context) => {
    if (span.charOffsetEnd <= span.charOffsetStart) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetEnd"],
        message: "charOffsetEnd must be greater than charOffsetStart",
      });
    }
    if (span.charOffsetEnd - span.charOffsetStart !== span.text.length) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "text length must equal charOffsetEnd - charOffsetStart",
      });
    }
  });
export type CorrectedCitingSpan = z.infer<typeof correctedCitingSpanSchema>;

export const humanAssessmentSchema = z
  .object({
    eligibleForAdjudication: humanYesNoSchema,
    inScope: humanYesNoSchema,
    citingSpanValid: humanYesNoSchema,
    correctedCitingSpan: correctedCitingSpanSchema.optional(),
    citedEvidenceValid: humanYesNoSchema,
    correctedCitedChunkIds: z.array(z.string().min(1)).optional(),
    evidenceSufficiency: humanEvidenceSufficiencySchema,
    /**
     * The reviewer's label, given without being told the model's. Agreement is
     * derived from this at export time, never typed by the reviewer: a form
     * that asks "do you agree?" cannot produce a calibration label.
     */
    humanVerdict: humanVerdictSchema,
    /**
     * True when the model's verdict was hidden for the whole of this review.
     * A single reveal makes the label unusable for calibration, so the flag is
     * recorded rather than assumed.
     */
    blinded: z.boolean(),
    /** Dimensions the reviewer saw move; same vocabulary as the adjudicator. */
    mutationKinds: z.array(mutationKindSchema).max(3),

    notes: z.string(),
  })
  .strict()
  .superRefine((assessment, context) => {
    if (assessment.citingSpanValid === "no") {
      if (assessment.correctedCitingSpan == null) {
        context.addIssue({
          code: "custom",
          path: ["correctedCitingSpan"],
          message: "Corrected citing span is required when citingSpanValid=no",
        });
      }
    } else if (assessment.correctedCitingSpan != null) {
      context.addIssue({
        code: "custom",
        path: ["correctedCitingSpan"],
        message:
          "Corrected citing span is only allowed when citingSpanValid=no",
      });
    }

    if (assessment.citedEvidenceValid === "no") {
      if (
        assessment.correctedCitedChunkIds == null ||
        assessment.correctedCitedChunkIds.length === 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["correctedCitedChunkIds"],
          message:
            "At least one corrected cited chunk id is required when citedEvidenceValid=no",
        });
      }
    } else if (assessment.correctedCitedChunkIds != null) {
      context.addIssue({
        code: "custom",
        path: ["correctedCitedChunkIds"],
        message:
          "Corrected cited chunk ids are only allowed when citedEvidenceValid=no",
      });
    }

    // Mutation kinds name how a distortion moved, so they only mean something
    // on a D. The adjudicator is held to the same rule.
    if (
      assessment.humanVerdict !== "D" &&
      assessment.mutationKinds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["mutationKinds"],
        message: "mutationKinds are only allowed when humanVerdict=D",
      });
    }
  });
export type HumanAssessment = z.infer<typeof humanAssessmentSchema>;

export const humanReviewEventIdSchema = z
  .string()
  .regex(/^hrevent_[a-f0-9]{32}$/, "Expected hrevent_<32 hex chars>");

export const humanReviewEventSchema = z
  .object({
    eventId: humanReviewEventIdSchema,
    recordId: z.string().min(1),
    familyId: z.string().min(1),
    reviewer: z.string().min(1),
    createdAt: z.string().datetime(),
    status: humanReviewStatusSchema,
    supersedesEventId: humanReviewEventIdSchema.optional(),
    assessment: humanAssessmentSchema,
  })
  .strict();
export type HumanReviewEvent = z.infer<typeof humanReviewEventSchema>;

export const humanReviewLineageSchema = z
  .object({
    runId: z.string().min(1),
    reportArtifactId: leanArtifactIdSchema,
    reportContentHash: sha256DigestSchema,
  })
  .strict();
export type HumanReviewLineage = z.infer<typeof humanReviewLineageSchema>;

export const humanReviewEventLogSchema = z
  .object({
    schemaVersion: z.literal("human-review-events-v2"),
    lineage: humanReviewLineageSchema,
    events: z.array(humanReviewEventSchema),
  })
  .strict()
  .superRefine((log, context) => {
    const seen = new Set<string>();
    const familyByRecord = new Map<string, string>();
    const latestEventByRecord = new Map<string, string>();
    for (const [index, event] of log.events.entries()) {
      if (seen.has(event.eventId)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "eventId"],
          message: `Duplicate eventId ${event.eventId}`,
        });
      }
      if (
        event.supersedesEventId != null &&
        !seen.has(event.supersedesEventId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "supersedesEventId"],
          message: "supersedesEventId must reference an earlier event",
        });
      }
      if (
        event.supersedesEventId != null &&
        latestEventByRecord.get(event.recordId) !== event.supersedesEventId
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "supersedesEventId"],
          message:
            "supersedesEventId must reference the latest earlier event for this record",
        });
      }
      const priorFamilyId = familyByRecord.get(event.recordId);
      if (priorFamilyId != null && priorFamilyId !== event.familyId) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "familyId"],
          message: "A record cannot change family across review revisions",
        });
      }
      seen.add(event.eventId);
      familyByRecord.set(event.recordId, event.familyId);
      latestEventByRecord.set(event.recordId, event.eventId);
    }
  });
export type HumanReviewEventLog = z.infer<typeof humanReviewEventLogSchema>;

export const humanReviewRecordStateSchema = z
  .object({
    recordId: z.string().min(1),
    familyId: z.string().min(1),
    status: humanReviewStatusSchema,
    reviewer: z.string().min(1),
    updatedAt: z.string().datetime(),
    eventId: humanReviewEventIdSchema,
    revisionCount: z.number().int().positive(),
    assessment: humanAssessmentSchema,
  })
  .strict();
export type HumanReviewRecordState = z.infer<
  typeof humanReviewRecordStateSchema
>;

export const humanReviewProgressSchema = z
  .object({
    totalRecords: z.number().int().nonnegative(),
    unreviewed: z.number().int().nonnegative(),
    draft: z.number().int().nonnegative(),
    final: z.number().int().nonnegative(),
  })
  .strict();
export type HumanReviewProgress = z.infer<typeof humanReviewProgressSchema>;

export const humanReviewStateSchema = z
  .object({
    lineage: humanReviewLineageSchema,
    headEventId: humanReviewEventIdSchema.nullable(),
    progress: humanReviewProgressSchema,
    records: z.array(humanReviewRecordStateSchema),
    staleReport: z.boolean(),
  })
  .strict();
export type HumanReviewState = z.infer<typeof humanReviewStateSchema>;

/**
 * Client → API append payload. Server assigns eventId/createdAt and resolves
 * the canonical citation context and Evidence chunks by recordId.
 */
export const appendHumanReviewRequestSchema = z
  .object({
    reportArtifactId: leanArtifactIdSchema,
    reportContentHash: sha256DigestSchema,
    expectedHeadEventId: humanReviewEventIdSchema.nullable(),
    recordId: z.string().min(1),
    familyId: z.string().min(1),
    reviewer: z.string().min(1),
    status: humanReviewStatusSchema,
    supersedesEventId: humanReviewEventIdSchema.optional(),
    assessment: humanAssessmentSchema,
  })
  .strict();
export type AppendHumanReviewRequest = z.infer<
  typeof appendHumanReviewRequestSchema
>;

export type HumanReviewConflictCode =
  | "stale_head"
  | "stale_report_lineage"
  | "record_identity_mismatch"
  | "invalid_supersession"
  | "invalid_citing_span"
  | "unknown_cited_chunk";

export class HumanReviewConflictError extends Error {
  readonly code: HumanReviewConflictCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: HumanReviewConflictCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HumanReviewConflictError";
    this.code = code;
    if (details) {
      this.details = details;
    }
  }
}

export function assertCorrectedCitingSpanInContext(
  span: CorrectedCitingSpan,
  citationContext: string,
): void {
  const slice = citationContext.slice(span.charOffsetStart, span.charOffsetEnd);
  if (slice !== span.text) {
    throw new HumanReviewConflictError(
      "invalid_citing_span",
      "Corrected citing span must be an exact substring of the citation context at the given offsets",
      {
        expectedSlice: slice,
        providedText: span.text,
        charOffsetStart: span.charOffsetStart,
        charOffsetEnd: span.charOffsetEnd,
      },
    );
  }
}

export function assertCorrectedCitedChunksKnown(
  chunkIds: readonly string[],
  knownCitedChunkIds: readonly string[],
): void {
  const known = new Set(knownCitedChunkIds);
  const unknown = chunkIds.filter((chunkId) => !known.has(chunkId));
  if (unknown.length > 0) {
    throw new HumanReviewConflictError(
      "unknown_cited_chunk",
      "Corrected cited chunk ids must reference known Evidence chunk ids",
      { unknownChunkIds: unknown },
    );
  }
}

export function projectHumanReviewRecords(
  events: readonly HumanReviewEvent[],
): HumanReviewRecordState[] {
  const latestByRecord = new Map<
    string,
    { state: HumanReviewRecordState; revisionCount: number }
  >();

  for (const event of events) {
    const prior = latestByRecord.get(event.recordId);
    const revisionCount = (prior?.revisionCount ?? 0) + 1;
    latestByRecord.set(event.recordId, {
      revisionCount,
      state: {
        recordId: event.recordId,
        familyId: event.familyId,
        status: event.status,
        reviewer: event.reviewer,
        updatedAt: event.createdAt,
        eventId: event.eventId,
        revisionCount,
        assessment: event.assessment,
      },
    });
  }

  return [...latestByRecord.values()]
    .map((entry) => entry.state)
    .sort((left, right) =>
      left.recordId < right.recordId
        ? -1
        : left.recordId > right.recordId
          ? 1
          : 0,
    );
}

/**
 * Agreement is a comparison, not an opinion: the reviewer supplies a label and
 * this derives whether it matches. `not_applicable` covers the cases where
 * there is nothing to compare — the machine returned an operational
 * non-verdict, or the human judged the record not adjudicable.
 */
export function deriveVerdictAgreement(input: {
  humanVerdict: HumanVerdict;
  machineVerdict?: string | undefined;
}): HumanYesNo | "not_applicable" {
  const machine = input.machineVerdict;
  if (machine == null || machine.length === 0) return "not_applicable";
  if (input.humanVerdict === "not_adjudicable") return "not_applicable";
  return input.humanVerdict === machine ? "yes" : "no";
}

export function computeHumanReviewProgress(input: {
  totalRecords: number;
  records: readonly HumanReviewRecordState[];
}): HumanReviewProgress {
  let draft = 0;
  let final = 0;
  for (const record of input.records) {
    if (record.status === "draft") {
      draft += 1;
    } else {
      final += 1;
    }
  }
  return {
    totalRecords: input.totalRecords,
    unreviewed: Math.max(0, input.totalRecords - draft - final),
    draft,
    final,
  };
}
