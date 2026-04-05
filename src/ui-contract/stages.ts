export const stageKeyValues = [
  "pre-screen",
  "m2-extract",
  "m3-classify",
  "m4-evidence",
  "m5-adjudicate",
  "m6-llm-judge",
] as const;

type StageKey = (typeof stageKeyValues)[number];

export type StageDefinition = {
  key: StageKey;
  order: number;
  slug: string;
  title: string;
  directoryName: string;
  command: string;
  artifactGlobs: {
    primarySuffix: string;
    reportSuffix: string;
    extraSuffixes: string[];
  };
};

export const stageDefinitions: readonly StageDefinition[] = [
  {
    key: "pre-screen",
    order: 1,
    slug: "01-pre-screen",
    title: "Pre-screen",
    directoryName: "01-pre-screen",
    command: "pre-screen",
    artifactGlobs: {
      primarySuffix: "_pre-screen-results.json",
      reportSuffix: "_pre-screen-report.md",
      extraSuffixes: [],
    },
  },
  {
    key: "m2-extract",
    order: 2,
    slug: "02-m2-extract",
    title: "M2 Extract",
    directoryName: "02-m2-extract",
    command: "m2-extract",
    artifactGlobs: {
      primarySuffix: "_m2-extraction-results.json",
      reportSuffix: "_m2-extraction-report.md",
      extraSuffixes: ["_m2-inspection.md"],
    },
  },
  {
    key: "m3-classify",
    order: 3,
    slug: "03-m3-classify",
    title: "M3 Classify",
    directoryName: "03-m3-classify",
    command: "m3-classify",
    artifactGlobs: {
      primarySuffix: "_classification-results.json",
      reportSuffix: "_classification-report.md",
      extraSuffixes: [],
    },
  },
  {
    key: "m4-evidence",
    order: 4,
    slug: "04-m4-evidence",
    title: "M4 Evidence",
    directoryName: "04-m4-evidence",
    command: "m4-evidence",
    artifactGlobs: {
      primarySuffix: "_evidence-results.json",
      reportSuffix: "_evidence-report.md",
      extraSuffixes: [],
    },
  },
  {
    key: "m5-adjudicate",
    order: 5,
    slug: "05-m5-adjudicate",
    title: "M5 Adjudicate",
    directoryName: "05-m5-adjudicate",
    command: "m5-adjudicate",
    artifactGlobs: {
      primarySuffix: "_calibration-set.json",
      reportSuffix: "_calibration-worksheet.md",
      extraSuffixes: [],
    },
  },
  {
    key: "m6-llm-judge",
    order: 6,
    slug: "06-m6-llm-judge",
    title: "M6 LLM Judge",
    directoryName: "06-m6-llm-judge",
    command: "m6-llm-judge",
    artifactGlobs: {
      primarySuffix: "_llm-calibration.json",
      reportSuffix: "_llm-summary.md",
      extraSuffixes: ["_agreement-report.md"],
    },
  },
] as const;

export const stageDefinitionByKey: Record<StageKey, StageDefinition> =
  Object.fromEntries(stageDefinitions.map((stage) => [stage.key, stage])) as Record<
    StageKey,
    StageDefinition
  >;

export function getStageDefinition(stageKey: StageKey): StageDefinition {
  return stageDefinitionByKey[stageKey];
}

export function compareStageKeys(left: StageKey, right: StageKey): number {
  return getStageDefinition(left).order - getStageDefinition(right).order;
}

export function getPreviousStageKey(stageKey: StageKey): StageKey | undefined {
  const previous = stageDefinitions
    .filter((stage) => compareStageKeys(stage.key, stageKey) < 0)
    .sort((left, right) => left.order - right.order)
    .at(-1);

  return previous?.key;
}
