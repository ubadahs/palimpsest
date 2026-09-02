import { z } from "zod";

/**
 * Canonical vocabulary, order, and on-disk layout for the six-stage pipeline.
 * This is the only stage vocabulary: there are no legacy stage keys and no
 * alias layer over these names.
 */
export const stageKeyValues = [
  "discover",
  "scope",
  "prepare",
  "evidence",
  "adjudicate",
  "report",
] as const;

export const stageKeySchema = z.enum(stageKeyValues);
export type StageKey = z.infer<typeof stageKeySchema>;

export type StageArtifactRole = "primary" | "report" | "diagnostic";

export type StageDefinition = {
  key: StageKey;
  order: number;
  slug: string;
  title: string;
  directoryName: string;
  command: string;
  responsibility: string;
  artifactGlobs: {
    primarySuffix: string;
    reportSuffix?: string;
    extraSuffixes: string[];
    extraRoles: StageArtifactRole[];
  };
};

const stageOutlines = [
  {
    key: "discover",
    directoryName: "00-discover",
    title: "Discover",
    responsibility:
      "Write a lossless ledger of seed papers, citation occurrences, and claim candidates.",
  },
  {
    key: "scope",
    directoryName: "01-scope",
    title: "Scope",
    responsibility:
      "Freeze claim-family identities, grounding, and included citation occurrences.",
  },
  {
    key: "prepare",
    directoryName: "02-prepare",
    title: "Prepare",
    responsibility:
      "Materialize one stable record per citation instance and attach its classification; sampling is excluded.",
  },
  {
    key: "evidence",
    directoryName: "03-evidence",
    title: "Evidence",
    responsibility:
      "Attach cited-paper evidence to prepared citation-instance records.",
  },
  {
    key: "adjudicate",
    directoryName: "04-adjudicate",
    title: "Adjudicate",
    responsibility:
      "Produce uncalibrated record-level F/D/E/U or gated non-verdict outcomes from Evidence and Prepare.",
  },
  {
    key: "report",
    directoryName: "05-report",
    title: "Report",
    responsibility:
      "Emit a deterministic JSON audit report plus Markdown rendering from the complete canonical artifact chain; JSON is authoritative and Markdown must not derive independent counts or rates.",
  },
] as const satisfies readonly {
  key: StageKey;
  directoryName: string;
  title: string;
  responsibility: string;
}[];

export const stageDefinitions: readonly StageDefinition[] = stageOutlines.map(
  (stage, order) => ({
    ...stage,
    order,
    slug: stage.directoryName,
    command: stage.key,
    artifactGlobs: {
      primarySuffix: `_canonical-${stage.key}.json`,
      extraSuffixes: [],
      extraRoles: [],
      ...(stage.key === "report"
        ? { reportSuffix: "_canonical-report.md" }
        : {}),
    },
  }),
);

export const stageDefinitionByKey: Record<StageKey, StageDefinition> =
  Object.fromEntries(
    stageDefinitions.map((stage) => [stage.key, stage]),
  ) as Record<StageKey, StageDefinition>;

export function getStageDefinition(stageKey: StageKey): StageDefinition {
  return stageDefinitionByKey[stageKey];
}

export function compareStageKeys(left: StageKey, right: StageKey): number {
  return stageDefinitionByKey[left].order - stageDefinitionByKey[right].order;
}

export function getPreviousStageKey(stageKey: StageKey): StageKey | undefined {
  return stageDefinitions[stageDefinitionByKey[stageKey].order - 1]?.key;
}

export function getNextStageKey(stageKey: StageKey): StageKey | undefined {
  return stageDefinitions[stageDefinitionByKey[stageKey].order + 1]?.key;
}
