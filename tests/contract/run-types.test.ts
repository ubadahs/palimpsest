import { describe, expect, it } from "vitest";

import { analysisRunConfigSchema } from "../../src/contract/run-types.js";

describe("analysis run config", () => {
  it("defaults fidelity vector tracing off with conservative settings", () => {
    const config = analysisRunConfigSchema.parse({});

    expect(config.adjudicateFidelityVectorTrace).toBe(false);
    expect(config.fidelityVectorSamples).toBe(3);
    expect(config.fidelityVectorModel).toBe("claude-sonnet-4-6");
    expect(config.fidelityVectorTemperature).toBe(0.7);
  });

  it("accepts fidelity vector trace overrides", () => {
    const config = analysisRunConfigSchema.parse({
      adjudicateFidelityVectorTrace: true,
      fidelityVectorSamples: 5,
      fidelityVectorModel: "custom-vector-model",
      fidelityVectorTemperature: 0.2,
    });

    expect(config).toMatchObject({
      adjudicateFidelityVectorTrace: true,
      fidelityVectorSamples: 5,
      fidelityVectorModel: "custom-vector-model",
      fidelityVectorTemperature: 0.2,
    });
  });
});
