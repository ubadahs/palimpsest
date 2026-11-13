import { describe, expect, it } from "vitest";

import {
  analysisRunConfigSchema,
  CANONICAL_RUN_CONFIG_DEFAULTS,
} from "../../src/contract/run-types.js";

describe("analysis run config", () => {
  it("defaults the canonical nested stage configuration", () => {
    const config = analysisRunConfigSchema.parse({});

    expect(config).toStrictEqual(CANONICAL_RUN_CONFIG_DEFAULTS);
    expect(config.discover.extractionModel).toBe("claude-haiku-5-5");
    expect(config.discover.probeBudget).toBe(100);
    expect(config.evidence.rerankEnabled).toBe(true);
  });

  it("accepts nested canonical stage overrides", () => {
    const config = analysisRunConfigSchema.parse({
      stopAfterStage: "evidence",
      discover: { probeBudget: 12 },
      evidence: {
        rerankEnabled: true,
        rerankModel: "claude-sonnet-5-5",
        rerankTopN: 3,
        bm25CandidateLimit: 8,
        selectionLimit: 3,
      },
      adjudicate: { model: "claude-opus-5-5", thinking: false },
    });

    expect(config).toMatchObject({
      stopAfterStage: "evidence",
      discover: { probeBudget: 12 },
      evidence: { rerankEnabled: true, rerankTopN: 3 },
      adjudicate: { model: "claude-opus-5-5", thinking: false },
    });
  });

  it("rejects unknown fields, stage names, and models", () => {
    for (const config of [
      { unknownField: true },
      { scope: { unknownModel: "claude-sonnet-5-5" } },
      { stopAfterStage: "unknown" },
      { adjudicate: { model: "claude-opus-4-6" } },
    ]) {
      expect(analysisRunConfigSchema.safeParse(config).success).toBe(false);
    }
  });
});
