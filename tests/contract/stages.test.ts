import { describe, expect, it } from "vitest";

import { stageDefinitions, stageKeyValues } from "../../src/contract/stages.js";

describe("stage contract", () => {
  it("defines the six-stage order", () => {
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
  });
});
