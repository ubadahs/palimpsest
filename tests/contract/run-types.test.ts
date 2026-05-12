import { describe, expect, it } from "vitest";

import { analysisRunConfigSchema } from "../../src/contract/run-types.js";

describe("analysis run config", () => {
  it("defaults fidelity vector tracing off with conservative settings", () => {
    const config = analysisRunConfigSchema.parse({});

    expect(config.adjudicateFidelityVectorTrace).toBe(false);
    expect(config.fidelityVectorSamples).toBe(3);
    expect(config.fidelityVectorModel).toBe("claude-sonnet-4-6");
    expect(config.fidelityVectorTemperature).toBe(0.7);
    expect(config.adjudicationMode).toBe("categorical");
    expect(config.vectorFirstInitialSamples).toBe(1);
    expect(config.vectorFirstMaxSamples).toBe(3);
    expect(config.vectorFirstModel).toBe("claude-sonnet-4-6");
    expect(config.vectorFirstTemperature).toBe(0.7);
    expect(config.vectorFirstConcurrency).toBe(2);
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

  it("accepts vector-first overrides", () => {
    const config = analysisRunConfigSchema.parse({
      adjudicationMode: "vector_first",
      vectorFirstInitialSamples: 2,
      vectorFirstMaxSamples: 4,
      vectorFirstModel: "custom-vector-first-model",
      vectorFirstTemperature: 0.4,
      vectorFirstConcurrency: 3,
    });

    expect(config).toMatchObject({
      adjudicationMode: "vector_first",
      vectorFirstInitialSamples: 2,
      vectorFirstMaxSamples: 4,
      vectorFirstModel: "custom-vector-first-model",
      vectorFirstTemperature: 0.4,
      vectorFirstConcurrency: 3,
    });
  });
});
