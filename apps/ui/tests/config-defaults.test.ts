/**
 * Guards against form defaults drifting from schema defaults.
 *
 * RUN_CONFIG_DEFAULTS / analysisRunConfigSchema is the single source
 * of truth. The UI form builds defaultState from that object.
 */

import { describe, expect, it } from "vitest";
import {
  analysisRunConfigSchema,
  RUN_CONFIG_DEFAULTS,
} from "palimpsest/contract";

describe("config defaults contract", () => {
  it("exported defaults match schema parse of empty config", () => {
    expect(analysisRunConfigSchema.parse({})).toStrictEqual(
      RUN_CONFIG_DEFAULTS,
    );
  });

  it("schema defaults match UI form flatten of RUN_CONFIG_DEFAULTS", () => {
    const schemaDefaults = analysisRunConfigSchema.parse({});
    const formFlattened = {
      stopAfterStage: RUN_CONFIG_DEFAULTS.stopAfterStage,
      forceRefresh: RUN_CONFIG_DEFAULTS.forceRefresh,
      modelConcurrency: RUN_CONFIG_DEFAULTS.modelConcurrency,
      discover: {
        neighborhoodProvider: RUN_CONFIG_DEFAULTS.discover.neighborhoodProvider,
        neighborhoodQuery: RUN_CONFIG_DEFAULTS.discover.neighborhoodQuery,
        neighborhoodLimit: RUN_CONFIG_DEFAULTS.discover.neighborhoodLimit,
        probeBudget: RUN_CONFIG_DEFAULTS.discover.probeBudget,
        fetchConcurrency: RUN_CONFIG_DEFAULTS.discover.fetchConcurrency,
        candidateSelection: {
          mode: "adaptive_portfolio" as const,
          minFamilies:
            RUN_CONFIG_DEFAULTS.discover.candidateSelection.minFamilies,
          maxFamilies:
            RUN_CONFIG_DEFAULTS.discover.candidateSelection.maxFamilies,
          maxPreparedRecords:
            RUN_CONFIG_DEFAULTS.discover.candidateSelection.maxPreparedRecords,
          prevalenceWeight:
            RUN_CONFIG_DEFAULTS.discover.candidateSelection.prevalenceWeight,
          specificityWeight:
            RUN_CONFIG_DEFAULTS.discover.candidateSelection.specificityWeight,
          confidenceWeight:
            RUN_CONFIG_DEFAULTS.discover.candidateSelection.confidenceWeight,
          noveltyWeight:
            RUN_CONFIG_DEFAULTS.discover.candidateSelection.noveltyWeight,
          minMarginalNovelty:
            RUN_CONFIG_DEFAULTS.discover.candidateSelection.minMarginalNovelty,
          policyVersion:
            RUN_CONFIG_DEFAULTS.discover.candidateSelection.policyVersion,
        },
        extractionModel: RUN_CONFIG_DEFAULTS.discover.extractionModel,
        extractionThinking: RUN_CONFIG_DEFAULTS.discover.extractionThinking,
        clusteringModel: RUN_CONFIG_DEFAULTS.discover.clusteringModel,
        clusteringThinking: RUN_CONFIG_DEFAULTS.discover.clusteringThinking,
      },
      scope: { ...RUN_CONFIG_DEFAULTS.scope },
      prepare: { ...RUN_CONFIG_DEFAULTS.prepare },
      evidence: { ...RUN_CONFIG_DEFAULTS.evidence },
      adjudicate: { ...RUN_CONFIG_DEFAULTS.adjudicate },
    };

    expect(schemaDefaults).toStrictEqual(formFlattened);
  });
});
