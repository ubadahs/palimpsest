import { z } from "zod";

import {
  bibliographyMatchMethodSchema,
  contextMarkerSpanSchema,
  parsedBlockKindSchema,
} from "../../domain/parsing.js";
import { modelExecutionSchema } from "../model-execution.js";
import {
  citationSourceLocatorSchema,
  discoverClaimSupportSpanSchema,
} from "./discover.js";
import {
  artifactReferenceSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
} from "./primitives.js";

export const scopeVerifiedEvidenceSpanSchema = z
  .object({
    text: z.string().min(1),
    blockId: z.string().min(1),
    blockKind: parsedBlockKindSchema,
    sectionTitle: z.string().min(1).optional(),
    charOffsetStart: z.number().int().nonnegative(),
    charOffsetEnd: z.number().int().positive(),
    verificationStatus: z.literal("verified_exact"),
    sourceArtifact: artifactReferenceSchema,
  })
  .strict();
export type ScopeVerifiedEvidenceSpan = z.infer<
  typeof scopeVerifiedEvidenceSpanSchema
>;

export const scopeSeedFindingSchema = z
  .object({
    findingId: stableIdentifierSchema,
    statement: z.string().min(1),
    ownershipReason: z.string().min(1),
    evidenceSpans: z.array(scopeVerifiedEvidenceSpanSchema).min(1),
  })
  .strict();
export type ScopeSeedFinding = z.infer<typeof scopeSeedFindingSchema>;

export const scopeSeedInventorySchema = z
  .object({
    seedId: stableIdentifierSchema,
    seedDoi: z.string().min(1),
    seedTitle: z.string().min(1),
    seedPublicationYear: z.number().int().optional(),
    status: z.enum([
      "completed",
      "no_grounded_findings",
      "seed_text_unavailable",
      "acquisition_failed",
      "provider_failure",
      "invalid_output",
      "not_assessed",
    ]),
    seedTextArtifact: artifactReferenceSchema.optional(),
    findings: z.array(scopeSeedFindingSchema),
    rejectedFindingCount: z.number().int().nonnegative(),
    reason: z.string().min(1),
    modelExecution: modelExecutionSchema.optional(),
  })
  .strict()
  .superRefine((inventory, context) => {
    if (
      (inventory.status === "completed") !== inventory.findings.length > 0 ||
      (inventory.findings.length > 0 && !inventory.seedTextArtifact)
    ) {
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message:
          "A completed inventory requires source text and at least one verified finding",
      });
    }
  });
export type ScopeSeedInventory = z.infer<typeof scopeSeedInventorySchema>;

export const assessedStatementRelationshipSchema = z.enum([
  "full",
  "partial",
  "scope_changed",
  "distinct",
  "uncertain",
]);
export const statementRelationshipSchema = z.union([
  assessedStatementRelationshipSchema,
  z.literal("unassessed"),
]);
export type StatementRelationship = z.infer<typeof statementRelationshipSchema>;

export function retainedWordingIsExact(
  phrase: string,
  exactWording: string | undefined,
): boolean {
  return (
    /[\p{L}\p{N}]/u.test(phrase) && exactWording?.includes(phrase) === true
  );
}

export const scopeStatementAssessmentSchema = z
  .object({
    status: z.enum([
      "assessed",
      "exact_attribution_unverified",
      "inventory_unavailable",
      "no_grounded_findings",
      "provider_failure",
      "invalid_output",
      "not_assessed",
    ]),
    relationship: statementRelationshipSchema,
    findingIds: z.array(stableIdentifierSchema),
    retained: z.array(z.string().min(1)),
    changes: z.array(z.string().min(1)),
    reason: z.string().min(1),
    batchId: stableIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((assessment, context) => {
    const unassessed = assessment.relationship === "unassessed";
    const requiresFinding =
      assessment.relationship === "full" ||
      assessment.relationship === "partial" ||
      assessment.relationship === "scope_changed";
    if (
      unassessed !== (assessment.status !== "assessed") ||
      (requiresFinding && assessment.findingIds.length === 0) ||
      (requiresFinding && assessment.retained.length === 0) ||
      ((unassessed || assessment.relationship === "distinct") &&
        assessment.findingIds.length > 0) ||
      ((unassessed || assessment.relationship === "distinct") &&
        (assessment.retained.length > 0 || assessment.changes.length > 0)) ||
      ((assessment.relationship === "scope_changed" ||
        assessment.relationship === "partial") &&
        assessment.changes.length === 0) ||
      (assessment.status === "assessed" && assessment.batchId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Statement relationship, finding references, and assessment outcome are inconsistent",
      });
    }
  });
export type ScopeStatementAssessment = z.infer<
  typeof scopeStatementAssessmentSchema
>;

export const scopeCitationStatementSchema = z
  .object({
    statementId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    citingPaperId: z.string().min(1),
    citingPaperRecordId: stableIdentifierSchema,
    citingDoi: z.string().min(1).optional(),
    citingTitle: z.string().min(1),
    citingPublicationYear: z.number().int().optional(),
    occurrenceId: stableIdentifierSchema,
    claimRecordId: stableIdentifierSchema,
    extractedClaimText: z.string().min(1),
    textSpan: discoverClaimSupportSpanSchema.optional(),
    citationContext: z.string(),
    citationMarker: z.string(),
    markerSpan: contextMarkerSpanSchema.optional(),
    sourceLocator: citationSourceLocatorSchema.optional(),
    citationGroupOrdinal: z.number().int().nonnegative().optional(),
    sectionTitle: z.string().optional(),
    locationQuality: z.enum(["exact_dom", "approximate", "missing"]),
    targetRefIds: z.array(z.string().min(1)),
    bundleRefIds: z.array(z.string().min(1)),
    bibliographyMatchMethod: bibliographyMatchMethodSchema.optional(),
    credit: z.enum([
      "single_reference",
      "shared_reference_group",
      "unverified",
    ]),
    sourceVersion: z
      .object({
        sourceType: z.string().min(1),
        parser: z.string().min(1),
        parserVersion: z.string().min(1).optional(),
        sourceTextHash: sha256DigestSchema.optional(),
        artifacts: z.array(artifactReferenceSchema).min(1),
      })
      .strict(),
    assessment: scopeStatementAssessmentSchema,
  })
  .strict()
  .superRefine((statement, context) => {
    const { textSpan, citationContext, credit, markerSpan } = statement;
    if (
      textSpan &&
      (textSpan.charOffsetEnd <= textSpan.charOffsetStart ||
        citationContext.slice(
          textSpan.charOffsetStart,
          textSpan.charOffsetEnd,
        ) !== textSpan.text)
    ) {
      context.addIssue({
        code: "custom",
        path: ["textSpan"],
        message:
          "Citation statement wording must equal the citation-context slice",
      });
    }
    if (
      statement.assessment.retained.some(
        (phrase) => !retainedWordingIsExact(phrase, textSpan?.text),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["assessment", "retained"],
        message:
          "Retained wording must occur verbatim in the exact citation statement",
      });
    }
    if (
      (credit !== "unverified" &&
        (!textSpan ||
          !markerSpan ||
          markerSpan.charOffsetEnd <= markerSpan.charOffsetStart ||
          markerSpan.charOffsetEnd > citationContext.length ||
          citationContext.slice(
            markerSpan.charOffsetStart,
            markerSpan.charOffsetEnd,
          ) !== statement.citationMarker ||
          statement.locationQuality !== "exact_dom")) ||
      (credit === "unverified" && statement.assessment.status === "assessed")
    ) {
      context.addIssue({
        code: "custom",
        path: ["credit"],
        message:
          "An assessment requires a verified statement and an exact citation marker",
      });
    }
  });
export type ScopeCitationStatement = z.infer<
  typeof scopeCitationStatementSchema
>;

export const scopeStatementAssessmentBatchSchema = z
  .object({
    batchId: stableIdentifierSchema,
    seedId: stableIdentifierSchema,
    statementIds: z.array(stableIdentifierSchema).min(1),
    modelExecution: modelExecutionSchema,
  })
  .strict();
export type ScopeStatementAssessmentBatch = z.infer<
  typeof scopeStatementAssessmentBatchSchema
>;
