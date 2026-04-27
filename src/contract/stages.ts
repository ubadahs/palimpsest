export const stageKeyValues = [
  "discover",
  "screen",
  "extract",
  "classify",
  "evidence",
  "curate",
  "adjudicate",
] as const;

type StageKey = (typeof stageKeyValues)[number];

export type StageArtifactRole = "primary" | "report" | "diagnostic";

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
    /**
     * Role metadata for extra suffixes, in the same order as `extraSuffixes`.
     * This does not affect artifact discovery; it documents whether a companion
     * file is part of the machine handoff or only diagnostic/reporting material.
     */
    extraRoles: StageArtifactRole[];
  };
};

export const stageDefinitions: readonly StageDefinition[] = [
  {
    key: "discover",
    order: 0,
    slug: "00-discover",
    title: "Discover",
    directoryName: "00-discover",
    command: "discover",
    artifactGlobs: {
      primarySuffix: "_discovery-results.json",
      reportSuffix: "_discovery-report.md",
      extraSuffixes: [
        "_discovery-shortlist.json",
        "_discovery-neighborhood.json",
        "_discovery-probe.json",
        "_discovery-mentions.json",
        "_discovery-attributed-claims.json",
        "_discovery-family-candidates.json",
        "_discovery-grounding-trace.json",
      ],
      extraRoles: [
        "primary",
        "diagnostic",
        "diagnostic",
        "diagnostic",
        "diagnostic",
        "diagnostic",
        "diagnostic",
      ],
    },
  },
  {
    key: "screen",
    order: 1,
    slug: "01-screen",
    title: "Screen",
    directoryName: "01-screen",
    command: "screen",
    artifactGlobs: {
      primarySuffix: "_pre-screen-results.json",
      reportSuffix: "_pre-screen-report.md",
      extraSuffixes: ["_pre-screen-grounding-trace.json"],
      extraRoles: ["diagnostic"],
    },
  },
  {
    key: "extract",
    order: 2,
    slug: "02-extract",
    title: "Extract",
    directoryName: "02-extract",
    command: "extract",
    artifactGlobs: {
      primarySuffix: "_m2-extraction-results.json",
      reportSuffix: "_m2-extraction-report.md",
      extraSuffixes: ["_m2-inspection.md"],
      extraRoles: ["diagnostic"],
    },
  },
  {
    key: "classify",
    order: 3,
    slug: "03-classify",
    title: "Classify",
    directoryName: "03-classify",
    command: "classify",
    artifactGlobs: {
      primarySuffix: "_classification-results.json",
      reportSuffix: "_classification-report.md",
      extraSuffixes: [],
      extraRoles: [],
    },
  },
  {
    key: "evidence",
    order: 4,
    slug: "04-evidence",
    title: "Evidence",
    directoryName: "04-evidence",
    command: "evidence",
    artifactGlobs: {
      primarySuffix: "_evidence-results.json",
      reportSuffix: "_evidence-report.md",
      extraSuffixes: [],
      extraRoles: [],
    },
  },
  {
    key: "curate",
    order: 5,
    slug: "05-curate",
    title: "Curate",
    directoryName: "05-curate",
    command: "curate",
    artifactGlobs: {
      primarySuffix: "_audit-sample.json",
      reportSuffix: "_audit-sample-worksheet.md",
      extraSuffixes: [],
      extraRoles: [],
    },
  },
  {
    key: "adjudicate",
    order: 6,
    slug: "06-adjudicate",
    title: "Adjudicate",
    directoryName: "06-adjudicate",
    command: "adjudicate",
    artifactGlobs: {
      primarySuffix: "_llm-audit-sample.json",
      reportSuffix: "_llm-summary.md",
      extraSuffixes: ["_agreement-report.md"],
      extraRoles: ["report"],
    },
  },
] as const;

export const stageDefinitionByKey: Record<StageKey, StageDefinition> =
  Object.fromEntries(
    stageDefinitions.map((stage) => [stage.key, stage]),
  ) as Record<StageKey, StageDefinition>;

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
