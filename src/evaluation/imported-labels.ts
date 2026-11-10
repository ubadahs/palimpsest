/** Human verdicts carried into a dataset from a report's review sidecar. */
import { z } from "zod";
import {
  humanReviewEventLogSchema,
  projectHumanReviewRecords,
} from "../contract/human-review.js";

export const importedReviewsSchema = z.array(
  z.object({
    lineage: z.object({
      runId: z.string(),
      reportArtifactId: z.string(),
      reportContentHash: z.string(),
    }),
    events: z.array(z.unknown()),
    recordUnitKeys: z.record(z.string(), z.string()),
  }),
);
export type ImportedReviews = z.infer<typeof importedReviewsSchema>;

export type ImportedUnitVerdict = {
  verdict: "F" | "D" | "E" | "U";
  /** True when any review of the unit was made with the machine verdict shown. */
  exposed: boolean;
};

const VERDICTS = ["F", "D", "E", "U"] as const;

/**
 * One verdict per claim unit. Only final reviews that found the record
 * eligible, in scope, correctly extracted, and sufficiently evidenced count,
 * and a unit whose reviews disagree gets no verdict.
 */
export function importedUnitVerdicts(
  imported: ImportedReviews,
): Map<string, ImportedUnitVerdict> {
  const byUnit = new Map<string, ImportedUnitVerdict[]>();
  for (const item of imported) {
    const log = humanReviewEventLogSchema.parse({
      schemaVersion: "human-review-events-v2",
      lineage: item.lineage,
      events: item.events,
    });
    for (const record of projectHumanReviewRecords(log.events)) {
      const { assessment } = record;
      const verdict = VERDICTS.find((name) => name === assessment.humanVerdict);
      if (
        record.status !== "final" ||
        assessment.eligibleForAdjudication !== "yes" ||
        assessment.inScope !== "yes" ||
        assessment.citingSpanValid !== "yes" ||
        assessment.citedEvidenceValid !== "yes" ||
        assessment.evidenceSufficiency !== "sufficient" ||
        !verdict
      )
        continue;
      const unitKey = item.recordUnitKeys[record.recordId];
      if (!unitKey)
        throw new Error(
          `Imported review references unknown record ${record.recordId}`,
        );
      const labels = byUnit.get(unitKey) ?? [];
      labels.push({ verdict, exposed: !assessment.blinded });
      byUnit.set(unitKey, labels);
    }
  }
  const verdicts = new Map<string, ImportedUnitVerdict>();
  for (const [unitKey, labels] of byUnit) {
    if (new Set(labels.map((label) => label.verdict)).size !== 1) continue;
    verdicts.set(unitKey, {
      verdict: labels[0]!.verdict,
      exposed: labels.some((label) => label.exposed),
    });
  }
  return verdicts;
}
