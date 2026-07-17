import { describe, expect, it } from "vitest";

import { analysisRunConfigSchema } from "../../src/contract/run-types.js";

describe("analysis run config", () => {
  it("defaults the canonical nested stage configuration", () => {
    const config = analysisRunConfigSchema.parse({});

    expect(config.stopAfterStage).toBe("report");
    expect(config.discover.neighborhoodProvider).toBe("openalex");
    expect(config.scope.groundingModel).toBe("claude-sonnet-4-6");
    expect(config.prepare.classifier).toBe("deterministic");
    expect(config.evidence.rerankEnabled).toBe(false);
    expect(config.adjudicate.model).toBe("claude-opus-4-6");
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
