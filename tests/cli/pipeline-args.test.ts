import { afterEach, describe, expect, it } from "vitest";

import { parseCanonicalPipelineArgs } from "../../src/cli/commands/pipeline.js";

describe("pipeline CLI arguments", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("parses the adjudication effort level", () => {
    const overrides = parseCanonicalPipelineArgs([
      "--input",
      "dois.json",
      "--adjudicate-effort",
      "medium",
    ]);
    expect(overrides.adjudicateEffort).toBe("medium");
    expect(overrides.input).toBe("dois.json");
  });

  it("rejects an effort level the model does not offer", () => {
    expect(() =>
      parseCanonicalPipelineArgs([
        "--input",
        "dois.json",
        "--adjudicate-effort",
        "extreme",
      ]),
    ).toThrow(/must be low, medium, high, or max/);
  });
});
