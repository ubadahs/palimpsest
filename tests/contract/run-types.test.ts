import { describe, expect, it } from "vitest";

import {
  analysisRunConfigSchema,
  RUN_CONFIG_DEFAULTS,
} from "../../src/contract/run-types.js";
import { expectRejected } from "../rejection.fixture.js";

describe("analysis run config", () => {
  it("defaults the nested stage configuration", () => {
    const config = analysisRunConfigSchema.parse({});

    expect(config).toStrictEqual(RUN_CONFIG_DEFAULTS);
    expect(config.discover.extractionModel).toBe("claude-haiku-5-5");
    expect(config.discover.probeBudget).toBe(100);
    expect(config.evidence.rerankEnabled).toBe(true);
  });

  it("accepts nested stage overrides", () => {
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
    for (const [config, message] of [
      [{ unknownField: true }, /Unrecognized key: "unknownField"/],
      [
        { scope: { unknownModel: "claude-sonnet-5-5" } },
        /scope: Unrecognized key: "unknownModel"/,
      ],
      [{ stopAfterStage: "unknown" }, /stopAfterStage: Invalid option/],
      [
        { adjudicate: { model: "claude-opus-4-6" } },
        /adjudicate\.model: Invalid option/,
      ],
    ] as const) {
      expectRejected(analysisRunConfigSchema, config, message);
    }
  });
});
