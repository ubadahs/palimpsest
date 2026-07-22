/**
 * Guards against form defaults drifting from schema defaults.
 *
 * The schema in analysisRunConfigSchema is the single source of truth for
 * config defaults. The UI form has its own defaultState for rendering, which
 * must stay in sync. This test parses an empty config through the schema and
 * asserts the form would produce the same values.
 */

import { describe, expect, it } from "vitest";
import { analysisRunConfigSchema } from "palimpsest/contract";

/**
 * Form defaults extracted from new-run-form.tsx's defaultState + flattenConfig.
 * If this test fails, either the schema default changed (update the form) or
 * the form default drifted (fix it back).
 */
const formDefaults = {
  stopAfterStage: "report",
  forceRefresh: false,
  discover: {
    neighborhoodProvider: "openalex",
    neighborhoodQuery: "works-citing-seed",
    neighborhoodLimit: 200,
    probeBudget: 100,
    candidateSelection: {
      mode: "adaptive_portfolio",
      minFamilies: 15,
      maxFamilies: 25,
      maxPreparedRecords: 100,
      prevalenceWeight: 0.25,
      specificityWeight: 0.35,
      confidenceWeight: 0.15,
      noveltyWeight: 0.25,
      minMarginalNovelty: 0.08,
      policyVersion: "adaptive-portfolio-v3",
    },
    extractionModel: "claude-haiku-4-5",
    extractionThinking: false,
  },
  scope: { groundingModel: "claude-sonnet-4-6", groundingThinking: true },
  prepare: { classifier: "deterministic" },
  evidence: {
    rerankEnabled: false,
    rerankModel: "claude-haiku-4-5",
    rerankTopN: 5,
    bm25CandidateLimit: 20,
    selectionLimit: 5,
  },
  adjudicate: { model: "claude-opus-4-6", thinking: true },
};

describe("config defaults contract", () => {
  it("schema defaults match UI form defaults", () => {
    const schemaDefaults = analysisRunConfigSchema.parse({});

    for (const [key, formValue] of Object.entries(formDefaults)) {
      const schemaValue = schemaDefaults[key as keyof typeof schemaDefaults];
      expect(
        schemaValue,
        `schema default for "${key}" should match form`,
      ).toStrictEqual(formValue);
    }
  });
});
