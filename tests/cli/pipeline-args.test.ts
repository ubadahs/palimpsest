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

  it("parses a spend limit in dollars, cents included", () => {
    const overrides = parseCanonicalPipelineArgs([
      "--run-id",
      "abc",
      "--max-cost",
      "2.5",
    ]);
    expect(overrides.maxCostUsd).toBe(2.5);
  });

  it("rejects a spend limit that is not a positive amount", () => {
    for (const value of ["0", "-1", "four"]) {
      expect(() =>
        parseCanonicalPipelineArgs(["--input", "d.json", "--max-cost", value]),
      ).toThrow(/--max-cost must be a positive number/);
    }
  });
});
