import { z } from "zod";

/** Canonical vocabulary and order for the lean scientific pipeline. */
export const canonicalStageKeyValues = [
  "discover",
  "scope",
  "prepare",
  "evidence",
  "adjudicate",
  "report",
] as const;

export const canonicalStageKeySchema = z.enum(canonicalStageKeyValues);
export type CanonicalStageKey = z.infer<typeof canonicalStageKeySchema>;

export type CanonicalStageDefinition = {
  key: CanonicalStageKey;
  order: number;
  responsibility: string;
};

export const canonicalStageDefinitions = [
  {
    key: "discover",
    order: 0,
    responsibility:
      "Write a lossless ledger of seed papers, citation occurrences, and claim candidates.",
  },
  {
    key: "scope",
    order: 1,
    responsibility:
      "Freeze claim-family identities, grounding, and included citation occurrences.",
  },
  {
    key: "prepare",
    order: 2,
    responsibility:
      "Materialize one stable record per citation instance and attach its classification; sampling is excluded.",
  },
  {
    key: "evidence",
    order: 3,
    responsibility:
      "Attach cited-paper evidence to prepared citation-instance records.",
  },
  {
    key: "adjudicate",
    order: 4,
    responsibility:
      "Produce record-level fidelity decisions from prepared records and evidence.",
  },
  {
    key: "report",
    order: 5,
    responsibility:
      "Render machine-readable and human-readable reports from adjudication artifacts.",
  },
] as const satisfies readonly CanonicalStageDefinition[];

export const canonicalStageDefinitionByKey: Record<
  CanonicalStageKey,
  CanonicalStageDefinition
> = {
  discover: canonicalStageDefinitions[0],
  scope: canonicalStageDefinitions[1],
  prepare: canonicalStageDefinitions[2],
  evidence: canonicalStageDefinitions[3],
  adjudicate: canonicalStageDefinitions[4],
  report: canonicalStageDefinitions[5],
};
