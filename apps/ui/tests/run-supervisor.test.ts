import { describe, expect, it } from "vitest";
import {
  analysisRunConfigSchema,
  getPreviousStageKey,
  type AnalysisRun,
} from "palimpsest/contract";

import { buildRunTargetExtension } from "../lib/run-supervisor";

describe("stage ordering for rerun validation", () => {
  it("discover has no previous stage", () => {
    expect(getPreviousStageKey("discover")).toBeUndefined();
  });

  it("scope follows discover", () => {
    expect(getPreviousStageKey("scope")).toBe("discover");
  });

  it("adjudicate follows evidence", () => {
    expect(getPreviousStageKey("adjudicate")).toBe("evidence");
  });

  it("extends a completed target without changing scientific config", () => {
    const run: AnalysisRun = {
      id: "run-partial",
      seedDoi: "10.1234/seed",
      targetStage: "discover",
      status: "succeeded",
      runRoot: "/tmp/run-partial",
      config: analysisRunConfigSchema.parse({
        stopAfterStage: "discover",
      }),
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };

    expect(buildRunTargetExtension(run, "scope")).toEqual({
      targetStage: "scope",
      config: {
        ...run.config,
        stopAfterStage: "scope",
      },
    });
    expect(buildRunTargetExtension(run, "discover")).toBeUndefined();
    expect(() => buildRunTargetExtension(run, "discover")).not.toThrow();

    const later = { ...run, targetStage: "evidence" as const };
    expect(() => buildRunTargetExtension(later, "scope")).toThrow(/shrink/i);
  });
});
