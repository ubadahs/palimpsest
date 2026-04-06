import { describe, expect, it } from "vitest";

import {
  preScreenGroundingTraceFileSchema,
  preScreenGroundingTraceRecordSchema,
} from "../../src/domain/pre-screen-grounding-trace.js";

describe("preScreenGroundingTraceRecordSchema", () => {
  it("accepts a minimal resolution-only record", () => {
    const parsed = preScreenGroundingTraceRecordSchema.parse({
      seed: { doi: "10.1234/x", trackedClaim: "claim" },
      seedResolutionOk: false,
      seedResolutionError: "not found",
      finalClaimGrounding: {
        status: "not_attempted",
        analystClaim: "claim",
        normalizedClaim: "claim",
        supportSpans: [],
        blocksDownstream: true,
        detailReason: "skipped",
      },
    });
    expect(parsed.seedResolutionOk).toBe(false);
  });

  it("accepts a full LLM trace record", () => {
    const parsed = preScreenGroundingTraceRecordSchema.parse({
      seed: { doi: "10.1234/x", trackedClaim: "claim" },
      seedResolutionOk: true,
      resolvedSeedPaperId: "id",
      resolvedSeedTitle: "Title",
      materializationOk: true,
      llmCall: {
        modelId: "claude-opus-4-6",
        promptTemplateVersion: "2026-04-06-v1",
        promptText: "full prompt",
        manuscriptCharCount: 100,
        manuscriptSha256: "a".repeat(64),
        rawResponseText: '{"status":"grounded"}',
        parsedResponse: {
          status: "grounded",
          normalizedClaim: "n",
          supportSpans: [{ verbatimQuote: "quote" }],
          detailReason: "ok",
        },
        quoteVerification: { overallOk: true, failures: [] },
        inputTokens: 10,
        outputTokens: 20,
        latencyMs: 500,
        finishReason: "stop",
        estimatedCostUsd: 0.01,
      },
      finalClaimGrounding: {
        status: "grounded",
        analystClaim: "claim",
        normalizedClaim: "n",
        supportSpans: [{ text: "quote" }],
        blocksDownstream: false,
        detailReason: "ok",
      },
    });
    expect(parsed.llmCall?.parsedResponse?.status).toBe("grounded");
  });
});

describe("preScreenGroundingTraceFileSchema", () => {
  it("round-trips a file envelope", () => {
    const payload = {
      artifactKind: "pre-screen-grounding-trace" as const,
      schemaVersion: 1,
      generatedAt: "2026-04-05T00:00:00.000Z",
      recordsBySeedDoi: {
        "10.1234/x": {
          seed: { doi: "10.1234/x", trackedClaim: "c" },
          seedResolutionOk: true,
          resolvedSeedPaperId: "p",
          resolvedSeedTitle: "T",
          materializationOk: true,
          finalClaimGrounding: {
            status: "grounded",
            analystClaim: "c",
            normalizedClaim: "c",
            supportSpans: [{ text: "span" }],
            blocksDownstream: false,
            detailReason: "grounded",
          },
        },
      },
    };
    const parsed = preScreenGroundingTraceFileSchema.parse(payload);
    expect(parsed.recordsBySeedDoi["10.1234/x"]?.materializationOk).toBe(true);
    const again = preScreenGroundingTraceFileSchema.parse(
      JSON.parse(JSON.stringify(parsed)),
    );
    expect(again).toEqual(parsed);
  });
});
