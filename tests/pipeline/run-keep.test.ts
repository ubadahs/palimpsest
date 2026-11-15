import { expect, it } from "vitest";
import { parseRunsKeepArgs } from "../../src/cli/commands/runs-keep.js";
it("parses keep and release requests", () => {
  expect(parseRunsKeepArgs(["--run-id", "r", "--reason", "review"])).toEqual({
    runId: "r",
    reason: "review",
    release: false,
  });
  expect(parseRunsKeepArgs(["--run-id", "r", "--release"]).release).toBe(true);
});
it.each([
  [],
  ["--run-id"],
  ["--run-id", "--release"],
  ["--run-id", "r", "--unknown"],
  ["--run-id", "r", "--run-id", "s"],
  ["--run-id", "r", "--release", "--release"],
  ["--run-id", "r", "--release", "--reason", "x"],
])("rejects malformed flags %j", (...args) => {
  expect(() => parseRunsKeepArgs(args)).toThrow();
});
