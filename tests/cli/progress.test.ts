import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrackedCliProgressReporter } from "../../src/cli/progress.js";
import { parseProgressEventLine } from "../../src/ui-contract/workflow.js";

describe("createTrackedCliProgressReporter", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a failed progress line for the running step on reportCliFailure", () => {
    const { progress, reportCliFailure } =
      createTrackedCliProgressReporter("m3-classify");

    progress.startStep("classify_citation_roles", {
      detail: "Working",
    });
    reportCliFailure(new Error("classification crashed"));

    expect(console.info).toHaveBeenCalled();
    const args = vi.mocked(console.info).mock.calls.at(-1);
    expect(args).toBeDefined();
    const message: unknown = args![0];
    if (typeof message !== "string") {
      throw new Error("expected console.info string");
    }
    const event = parseProgressEventLine(message);
    expect(event?.status).toBe("failed");
    expect(event?.step).toBe("classify_citation_roles");
    expect(event?.detail).toContain("classification crashed");
  });

  it("uses the first workflow step when failure happens before any telemetry", () => {
    const { reportCliFailure } = createTrackedCliProgressReporter("pre-screen");
    reportCliFailure(new Error("early"));

    const args = vi.mocked(console.info).mock.calls.at(-1);
    expect(args).toBeDefined();
    const message: unknown = args![0];
    if (typeof message !== "string") {
      throw new Error("expected console.info string");
    }
    const event = parseProgressEventLine(message);
    expect(event?.step).toBe("resolve_seed_paper");
    expect(event?.detail).toContain("early");
  });
});
