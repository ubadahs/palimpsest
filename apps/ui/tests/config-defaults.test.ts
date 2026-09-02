/**
 * Guards against form defaults drifting from schema defaults.
 *
 * CANONICAL_RUN_CONFIG_DEFAULTS / analysisRunConfigSchema is the single source
 * of truth. The UI form builds defaultState from that object.
 */

import { describe, expect, it } from "vitest";
import {
  analysisRunConfigSchema,
  CANONICAL_RUN_CONFIG_DEFAULTS,
} from "palimpsest/contract";

describe("config defaults contract", () => {
  it("exported defaults match schema parse of empty config", () => {
    expect(analysisRunConfigSchema.parse({})).toStrictEqual(
      CANONICAL_RUN_CONFIG_DEFAULTS,
    );
  });

  it("schema defaults match UI form flatten of CANONICAL_RUN_CONFIG_DEFAULTS", () => {
    const schemaDefaults = analysisRunConfigSchema.parse({});
    const formFlattened = {
      stopAfterStage: CANONICAL_RUN_CONFIG_DEFAULTS.stopAfterStage,
      forceRefresh: CANONICAL_RUN_CONFIG_DEFAULTS.forceRefresh,
      discover: {
        neighborhoodProvider:
          CANONICAL_RUN_CONFIG_DEFAULTS.discover.neighborhoodProvider,
        neighborhoodQuery:
          CANONICAL_RUN_CONFIG_DEFAULTS.discover.neighborhoodQuery,
        neighborhoodLimit:
          CANONICAL_RUN_CONFIG_DEFAULTS.discover.neighborhoodLimit,
        probeBudget: CANONICAL_RUN_CONFIG_DEFAULTS.discover.probeBudget,
        candidateSelection: {
          mode: "adaptive_portfolio" as const,
          minFamilies:
            CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection
              .minFamilies,
          maxFamilies:
            CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection
              .maxFamilies,
          maxPreparedRecords:
            CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection
              .maxPreparedRecords,
          prevalenceWeight:
            CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection
              .prevalenceWeight,
          specificityWeight:
            CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection
              .specificityWeight,
          confidenceWeight:
            CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection
              .confidenceWeight,
          noveltyWeight:
            CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection
              .noveltyWeight,
          minMarginalNovelty:
            CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection
              .minMarginalNovelty,
          policyVersion:
            CANONICAL_RUN_CONFIG_DEFAULTS.discover.candidateSelection
              .policyVersion,
        },
        extractionModel: CANONICAL_RUN_CONFIG_DEFAULTS.discover.extractionModel,
        extractionThinking:
          CANONICAL_RUN_CONFIG_DEFAULTS.discover.extractionThinking,
        canonicalizationModel:
          CANONICAL_RUN_CONFIG_DEFAULTS.discover.canonicalizationModel,
        canonicalizationThinking:
          CANONICAL_RUN_CONFIG_DEFAULTS.discover.canonicalizationThinking,
      },
      scope: { ...CANONICAL_RUN_CONFIG_DEFAULTS.scope },
      prepare: { ...CANONICAL_RUN_CONFIG_DEFAULTS.prepare },
      evidence: { ...CANONICAL_RUN_CONFIG_DEFAULTS.evidence },
      adjudicate: { ...CANONICAL_RUN_CONFIG_DEFAULTS.adjudicate },
    };

    expect(schemaDefaults).toStrictEqual(formFlattened);
  });
});
