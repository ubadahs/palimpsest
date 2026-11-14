import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CURRENT_PROMPT_REVISION,
  experimentConfigSchema,
  promptsSeen,
} from "../../src/evaluation/config.js";

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

describe("evaluation prompt revisions", () => {
  it("runs new experiments under the current revision", () => {
    expect(
      experimentConfigSchema.parse({
        schemaVersion: "evaluation-experiment-config-v1",
        tasks: ["role"],
        providers: [{ id: "rules", kind: "rules", model: "role-regex-v1" }],
      }).promptRevision,
    ).toBe(CURRENT_PROMPT_REVISION);
  });

  it("keeps trials reusable until a later revision changed what their provider saw", () => {
    const anthropic = { kind: "anthropic" } as const;
    const wholePaper = {
      kind: "anthropic",
      adjudicationEvidence: "seed_text",
    } as const;
    const jev = { kind: "jev" } as const;
    for (const kind of ["anthropic", "bm25", "rules"] as const) {
      expect(promptsSeen("evaluation-prompts-v4", { kind }, "role")).toBe(
        "evaluation-prompts-v2",
      );
    }
    expect(promptsSeen("evaluation-prompts-v4", jev, "role")).toBe(
      "evaluation-prompts-v3",
    );
    expect(promptsSeen("evaluation-prompts-v4", jev, "adjudication")).toBe(
      "evaluation-prompts-v4",
    );
    expect(
      promptsSeen("evaluation-prompts-v4", wholePaper, "adjudication"),
    ).toBe("evaluation-prompts-v4");
    // The selected-chunks prompt is frozen in the dataset.
    expect(
      promptsSeen("evaluation-prompts-v4", anthropic, "adjudication"),
    ).toBe("evaluation-prompts-v2");
    expect(promptsSeen("evaluation-prompts-v3", jev, "adjudication")).toBe(
      "evaluation-prompts-v3",
    );
    expect(promptsSeen("evaluation-prompts-v4", jev, "rerank")).toBe(
      "evaluation-prompts-v2",
    );
    // v5 changed only the bundle note, which only whole-paper adjudication renders live.
    expect(
      promptsSeen("evaluation-prompts-v5", wholePaper, "adjudication"),
    ).toBe("evaluation-prompts-v5");
    expect(promptsSeen("evaluation-prompts-v5", jev, "adjudication")).toBe(
      "evaluation-prompts-v4",
    );
    expect(
      promptsSeen("evaluation-prompts-v5", anthropic, "adjudication"),
    ).toBe("evaluation-prompts-v2");
    expect(promptsSeen("evaluation-prompts-v1", anthropic, "role")).toBe(
      "evaluation-prompts-v1",
    );
  });
});
