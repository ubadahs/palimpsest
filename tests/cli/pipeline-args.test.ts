import { afterEach, describe, expect, it } from "vitest";

import { parsePipelineArgs } from "../../src/cli/commands/pipeline.js";

describe("pipeline CLI arguments", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("parses the adjudication effort level", () => {
    const overrides = parsePipelineArgs([
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
      parsePipelineArgs([
        "--input",
        "dois.json",
        "--adjudicate-effort",
        "extreme",
      ]),
    ).toThrow(/must be low, medium, high, or max/);
  });

  it("parses the Discover fetch concurrency", () => {
    const overrides = parsePipelineArgs([
      "--input",
      "dois.json",
      "--fetch-concurrency",
      "3",
    ]);
    expect(overrides.discoverFetchConcurrency).toBe(3);
  });

  it("parses a spend limit in dollars, cents included", () => {
    const overrides = parsePipelineArgs([
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
        parsePipelineArgs(["--input", "d.json", "--max-cost", value]),
      ).toThrow(/--max-cost must be a positive number/);
    }
  });

  it("turns on the batch transport only when asked, on fresh runs and resumes", () => {
    expect(parsePipelineArgs(["--input", "d.json"]).batch).toBe(undefined);
    expect(parsePipelineArgs(["--run-id", "abc", "--batch"]).batch).toBe(true);
  });

  it("expands --census into probing every citer and keeping every family", () => {
    const overrides = parsePipelineArgs([
      "--input",
      "dois.json",
      "--census",
      "--max-cost",
      "0.5",
    ]);
    expect(overrides.discoverProbeBudget).toBe("all");
    expect(overrides.discoverCandidateSelectionMode).toBe("all");
    expect(overrides.maxCostUsd).toBe(0.5);
  });

  it("rejects --census beside a probe budget or portfolio caps", () => {
    for (const extra of [
      ["--probe-budget", "50"],
      ["--max-families", "10"],
    ]) {
      expect(() =>
        parsePipelineArgs(["--input", "d.json", "--census", ...extra]),
      ).toThrow(/cannot be combined/);
    }
  });

  it("accepts --probe-budget all", () => {
    expect(
      parsePipelineArgs(["--input", "d.json", "--probe-budget", "all"])
        .discoverProbeBudget,
    ).toBe("all");
  });
});
