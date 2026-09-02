import { describe, expect, it } from "vitest";

import {
  analysisRunConfigSchema,
  CANONICAL_RUN_CONFIG_DEFAULTS,
} from "../../src/contract/run-types.js";

describe("analysis run config", () => {
  it("defaults the canonical nested stage configuration", () => {
    const config = analysisRunConfigSchema.parse({});

    expect(config).toStrictEqual(CANONICAL_RUN_CONFIG_DEFAULTS);
    expect(config.discover.extractionModel).toBe("claude-haiku-4-5");
    expect(config.discover.probeBudget).toBe(100);
    expect(config.evidence.rerankEnabled).toBe(true);
  });

  it("accepts nested canonical stage overrides", () => {
    const config = analysisRunConfigSchema.parse({
      stopAfterStage: "evidence",
      discover: { probeBudget: 12 },
      evidence: {
        rerankEnabled: true,
        rerankModel: "fixture-reranker",
        rerankTopN: 3,
        bm25CandidateLimit: 8,
        selectionLimit: 3,
      },
      adjudicate: { model: "fixture-adjudicator", thinking: false },
    });

    expect(config).toMatchObject({
      stopAfterStage: "evidence",
      discover: { probeBudget: 12 },
      evidence: { rerankEnabled: true, rerankTopN: 3 },
      adjudicate: { model: "fixture-adjudicator", thinking: false },
    });
  });

  it("rejects superseded config fields and stage names", () => {
    expect(
      analysisRunConfigSchema.safeParse({
        adjudicationMode: "vector_first",
      }).success,
    ).toBe(false);
    expect(
      analysisRunConfigSchema.safeParse({
        screen: { groundingModel: "obsolete" },
      }).success,
    ).toBe(false);
    expect(
      analysisRunConfigSchema.safeParse({
        stopAfterStage: "extract",
      }).success,
    ).toBe(false);
    expect(
      analysisRunConfigSchema.safeParse({
        seedPdfPath: "/tmp/legacy-alias.pdf",
      }).success,
    ).toBe(false);
  });
});
