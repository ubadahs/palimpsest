import { describe, expect, it } from "vitest";

import type { ClaimDiscoveryResult } from "../../src/domain/types.js";
import { toDiscoveryMarkdown } from "../../src/reporting/discovery-report.js";

describe("toDiscoveryMarkdown", () => {
  it("includes acquisition failure reasons when no method was selected", () => {
    const result: ClaimDiscoveryResult = {
      doi: "10.1234/example",
      resolvedPaper: undefined,
      status: "no_fulltext",
      statusDetail: "Full text unavailable: No fetchable full text candidates",
      claims: [],
      findingCount: 0,
      totalClaimCount: 0,
      llmModel: undefined,
      llmInputTokens: undefined,
      llmOutputTokens: undefined,
      llmEstimatedCostUsd: undefined,
      ranking: undefined,
      fullTextAcquisition: {
        materializationSource: "network",
        attempts: [],
        selectedMethod: undefined,
        selectedLocatorKind: undefined,
        selectedUrl: undefined,
        fullTextFormat: undefined,
        failureReason: "No fetchable full text candidates",
      },
      generatedAt: "2026-04-07T00:00:00.000Z",
    };

    const markdown = toDiscoveryMarkdown([result]);

    expect(markdown).toContain("Full text acquisition");
    expect(markdown).toContain("No fetchable full text candidates");
  });
});
