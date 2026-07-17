import {
  canonicalStageDefinitionByKey,
  canonicalStageDefinitions,
  canonicalStageKeySchema,
  canonicalStageKeyValues,
  type CanonicalStageKey,
} from "./lean-stages.js";

export { canonicalStageKeySchema as stageKeySchema };

/** Public runtime stage vocabulary — canonical six-stage pipeline only. */
export const stageKeyValues = canonicalStageKeyValues;
export type StageKey = CanonicalStageKey;

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

const titles: Record<StageKey, string> = {
  discover: "Discover",
  scope: "Scope",
  prepare: "Prepare",
  evidence: "Evidence",
  adjudicate: "Adjudicate",
  report: "Report",
};

const directoryNames: Record<StageKey, string> = {
  discover: "00-discover",
  scope: "01-scope",
  prepare: "02-prepare",
  evidence: "03-evidence",
  adjudicate: "04-adjudicate",
  report: "05-report",
};

const primarySuffixes: Record<StageKey, string> = {
  discover: "_canonical-discover.json",
  scope: "_canonical-scope.json",
  prepare: "_canonical-prepare.json",
  evidence: "_canonical-evidence.json",
  adjudicate: "_canonical-adjudicate.json",
  report: "_canonical-report.json",
};

export const stageDefinitions: readonly StageDefinition[] =
  canonicalStageDefinitions.map((stage) => {
    const key = stage.key;
    return {
      key,
      order: stage.order,
      slug: directoryNames[key],
      title: titles[key],
      directoryName: directoryNames[key],
      command: key,
      responsibility: stage.responsibility,
      artifactGlobs: {
        primarySuffix: primarySuffixes[key],
        extraSuffixes: [],
        extraRoles: [],
        ...(key === "report" ? { reportSuffix: "_canonical-report.md" } : {}),
      },
    };
  });

export const stageDefinitionByKey: Record<StageKey, StageDefinition> =
  Object.fromEntries(
    stageDefinitions.map((stage) => [stage.key, stage]),
  ) as Record<StageKey, StageDefinition>;

export function getStageDefinition(stageKey: StageKey): StageDefinition {
  return stageDefinitionByKey[stageKey];
}

export function compareStageKeys(left: StageKey, right: StageKey): number {
  return (
    canonicalStageDefinitionByKey[left].order -
    canonicalStageDefinitionByKey[right].order
  );
}

export function getPreviousStageKey(stageKey: StageKey): StageKey | undefined {
  const previous = stageDefinitions
    .filter((stage) => compareStageKeys(stage.key, stageKey) < 0)
    .sort((left, right) => left.order - right.order)
    .at(-1);

  return previous?.key;
}

export function getNextStageKey(stageKey: StageKey): StageKey | undefined {
  const next = stageDefinitions
    .filter((stage) => compareStageKeys(stage.key, stageKey) > 0)
    .sort((left, right) => left.order - right.order)
    .at(0);

  return next?.key;
}

/** Rejected legacy stage names — never accepted as aliases. */
export const rejectedLegacyStageNames = [
  "screen",
  "extract",
  "classify",
  "curate",
  "pre-screen",
  "pre_screen",
] as const;
