import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { experimentConfigSchema } from "../../src/evaluation/config.js";

function example(name: string) {
  return experimentConfigSchema.parse(
    JSON.parse(readFileSync(`docs/${name}.example.json`, "utf8")),
  );
}

describe("evaluation example configs", () => {
  it("runs each compared model on chunks and on the whole paper, twice", () => {
    const { tasks, repetitions, providers } = example(
      "evaluation.adjudication-arms",
    );
    expect(tasks).toEqual(["adjudication"]);
    expect(repetitions).toBe(2);
    expect(
      providers.map((provider) => [
        provider.model,
        provider.adjudicationEvidence ?? "selected_chunks",
      ]),
    ).toEqual([
      ["claude-haiku-5-5", "selected_chunks"],
      ["claude-haiku-5-5", "seed_text"],
      ["claude-sonnet-5-5", "selected_chunks"],
      ["claude-sonnet-5-5", "seed_text"],
      ["claude-opus-5-5", "selected_chunks"],
      ["claude-opus-5-5", "seed_text"],
    ]);
  });

  it("keeps the probe's arms identical to the comparison's, so its trials are reused", () => {
    const arms = example("evaluation.adjudication-arms").providers;
    for (const provider of example("evaluation.adjudication-probe").providers)
      expect(arms).toContainEqual(provider);
  });

  it("names no legacy model", () => {
    for (const name of [
      "evaluation",
      "evaluation.adjudication-arms",
      "evaluation.adjudication-probe",
    ])
      for (const provider of example(name).providers)
        expect(provider.model).not.toMatch(/claude-(opus|sonnet|haiku)-4/);
  });
});
