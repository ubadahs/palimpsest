import { z } from "zod";

import {
  adjudicationRecordSchema,
  adjudicationVerdictSchema,
  calibrationSetSchema,
  retrievalQualitySchema,
} from "../domain/adjudication.js";
import { undefinedable } from "../domain/common.js";

export const blindAdjudicationRecordSchema = adjudicationRecordSchema
  .omit({
    verdict: true,
    rationale: true,
    retrievalQuality: true,
    judgeConfidence: true,
    adjudicator: true,
    adjudicatedAt: true,
    telemetry: true,
  })
  .passthrough();
export type BlindAdjudicationRecord = z.infer<typeof blindAdjudicationRecordSchema>;

export const blindCalibrationSetSchema = calibrationSetSchema
  .extend({
    records: z.array(blindAdjudicationRecordSchema),
  })
  .passthrough();
export type BlindCalibrationSet = z.infer<typeof blindCalibrationSetSchema>;

export const adjudicationDeltaSchema = z
  .object({
    taskId: z.string().min(1),
    finalVerdict: adjudicationVerdictSchema,
    rationale: undefinedable(z.string()),
    retrievalQuality: undefinedable(retrievalQualitySchema),
    judgeConfidence: undefinedable(z.enum(["low", "medium", "high"])),
    note: undefinedable(z.string()),
    excluded: undefinedable(z.boolean()),
    excludeReason: undefinedable(z.string()),
    allowExcludedChange: undefinedable(z.boolean()),
  })
  .passthrough();
export type AdjudicationDelta = z.infer<typeof adjudicationDeltaSchema>;

export const adjudicationDeltaSetSchema = z
  .object({
    version: undefinedable(z.string()),
    revisionNote: undefinedable(z.string()),
    deltas: z.array(adjudicationDeltaSchema),
  })
  .passthrough();
export type AdjudicationDeltaSet = z.infer<typeof adjudicationDeltaSetSchema>;

export const benchmarkDiffEntrySchema = z
  .object({
    taskId: z.string().min(1),
    citingPaperTitle: z.string().min(1),
    recordOrder: z.number().int().nonnegative(),
    baseVerdict: undefinedable(adjudicationVerdictSchema),
    candidateVerdict: undefinedable(adjudicationVerdictSchema),
    verdictChanged: z.boolean(),
    rationaleChanged: z.boolean(),
    retrievalQualityChanged: z.boolean(),
    exclusionChanged: z.boolean(),
    missingInBase: z.boolean(),
    missingInCandidate: z.boolean(),
  })
  .passthrough();
export type BenchmarkDiffEntry = z.infer<typeof benchmarkDiffEntrySchema>;

export const benchmarkDiffResultSchema = z
  .object({
    summary: z
      .object({
        totalBaseRecords: z.number().int().nonnegative(),
        totalCandidateRecords: z.number().int().nonnegative(),
        changedVerdicts: z.number().int().nonnegative(),
        changedRationales: z.number().int().nonnegative(),
        changedExclusions: z.number().int().nonnegative(),
        missingInBase: z.number().int().nonnegative(),
        missingInCandidate: z.number().int().nonnegative(),
      })
      .passthrough(),
    entries: z.array(benchmarkDiffEntrySchema),
  })
  .passthrough();
export type BenchmarkDiffResult = z.infer<typeof benchmarkDiffResultSchema>;
