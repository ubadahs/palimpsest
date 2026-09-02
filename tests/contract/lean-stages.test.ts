import { describe, expect, it } from "vitest";

import {
  stageDefinitions,
  stageKeySchema,
  stageKeyValues,
} from "../../src/contract/lean-stages.js";

describe("lean stage contract", () => {
  it("defines the canonical six-stage order", () => {
    expect(stageKeyValues).toEqual([
      "discover",
      "scope",
      "prepare",
      "evidence",
      "adjudicate",
      "report",
    ]);
    expect(stageDefinitions.map((stage) => stage.order)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(
      stageDefinitions.find((stage) => stage.key === "prepare")?.responsibility,
    ).toContain("sampling is excluded");
  });

  it("rejects superseded and historical stage names", () => {
    for (const oldStageName of [
      "screen",
      "extract",
      "classify",
      "curate",
      "pre-screen",
      "m2-extract",
      "m3-classify",
      "m4-evidence",
      "m5-adjudicate",
      "m6-llm-judge",
    ]) {
      expect(stageKeySchema.safeParse(oldStageName).success).toBe(false);
    }
  });
});
