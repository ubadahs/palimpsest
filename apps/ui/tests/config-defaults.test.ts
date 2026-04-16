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
  stopAfterStage: "adjudicate",
  forceRefresh: false,
  discoverStrategy: "attribution_first",
  discoverModel: "claude-haiku-4-5",
  discoverThinking: false,
  discoverTopN: 5,
  discoverRank: true,
  discoverProbeBudget: 100,
  discoverShortlistCap: 5,
  screenGroundingModel: "claude-sonnet-4-6",
  screenGroundingThinking: true,
  screenFilterModel: "claude-haiku-4-5",
  screenFilterConcurrency: 10,
  evidenceLlmRerank: true,
  evidenceRerankModel: "claude-haiku-4-5",
  evidenceRerankTopN: 5,
  curateTargetSize: 20,
  adjudicateModel: "claude-opus-4-6",
  adjudicateThinking: true,
  adjudicateAdvisor: true,
  adjudicateFirstPassModel: "claude-sonnet-4-6",
  familyConcurrency: 5,
};

describe("config defaults contract", () => {
  it("schema defaults match UI form defaults", () => {
    const schemaDefaults = analysisRunConfigSchema.parse({});

    for (const [key, formValue] of Object.entries(formDefaults)) {
      const schemaValue = (schemaDefaults as Record<string, unknown>)[key];
      expect(schemaValue, `schema default for "${key}" should match form`).toBe(
        formValue,
      );
    }
  });
});
