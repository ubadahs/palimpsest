import { describe, expect, it } from "vitest";
import { getPreviousStageKey } from "palimpsest/contract";

describe("stage ordering for rerun validation", () => {
  it("discover has no previous stage", () => {
    expect(getPreviousStageKey("discover")).toBeUndefined();
  });

  it("screen follows discover", () => {
    expect(getPreviousStageKey("screen")).toBe("discover");
  });

  it("adjudicate follows curate", () => {
    expect(getPreviousStageKey("adjudicate")).toBe("curate");
  });
});
