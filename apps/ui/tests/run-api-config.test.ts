import { describe, expect, it } from "vitest";

import { analysisRunConfigSchema } from "palimpsest/contract";

import { buildCreateRunConfig, createRunSchema } from "@/pages/api/runs";
import { startRunSchema } from "@/pages/api/runs/[runId]/start";

describe("run creation API config", () => {
  it("deep-merges an uploaded PDF into custom Scope config", () => {
    const requestedConfig = analysisRunConfigSchema.parse({
      scope: {
        groundingModel: "custom-grounding-model",
        groundingThinking: false,
      },
    });
    const config = buildCreateRunConfig({
      requestedConfig,
      targetStage: "report",
      seedPdfPath: "/tmp/uploaded-seed.pdf",
    });
    expect(config.scope).toEqual({
      groundingModel: "custom-grounding-model",
      groundingThinking: false,
      seedPdfPath: "/tmp/uploaded-seed.pdf",
    });
  });

  it("accepts ordered multi-DOI input and rejects duplicates or multi-DOI PDFs", () => {
    const ok = createRunSchema.parse({
      seedDois: ["10.1234/a", "10.1234/b"],
      targetStage: "report",
    });
    expect(ok.seedDois).toEqual(["10.1234/a", "10.1234/b"]);

    expect(() =>
      createRunSchema.parse({
        seedDois: ["10.1234/a", "https://doi.org/10.1234/A"],
      }),
    ).toThrow(/duplicate/i);

    expect(() =>
      createRunSchema.parse({
        seedDois: ["10.1234/a", "10.1234/b"],
        seedPdfBase64: "AAAA",
      }),
    ).toThrow(/single-DOI/i);

    expect(() =>
      createRunSchema.parse({
        seedDois: ["10.1234/a", "10.1234/b"],
        config: analysisRunConfigSchema.parse({
          scope: { seedPdfPath: "/tmp/seed.pdf" },
        }),
      }),
    ).toThrow(/single-DOI/i);
  });

  it("accepts only canonical target extensions in start requests", () => {
    expect(startRunSchema.parse({ targetStage: "scope" })).toEqual({
      targetStage: "scope",
    });
    expect(startRunSchema.parse({})).toEqual({});
    expect(() => startRunSchema.parse({ targetStage: "screen" })).toThrow();
  });
});
