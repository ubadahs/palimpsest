import { describe, expect, it } from "vitest";

import {
  claimFamilyBlocksDownstream,
  claimGroundingBlocksAnalysis,
} from "../../src/domain/pre-screen.js";
import type {
  ClaimFamilyPreScreen,
  ClaimGrounding,
} from "../../src/domain/types.js";

function minimalFamily(claimGrounding: ClaimGrounding): ClaimFamilyPreScreen {
  const metrics = {
    totalEdges: 0,
    uniqueEdges: 0,
    collapsedDuplicates: 0,
    auditableStructuredEdges: 0,
    auditablePdfEdges: 0,
    partiallyAuditableEdges: 0,
    notAuditableEdges: 0,
    auditableCoverage: 0,
    primaryLikeEdgeCount: 0,
    primaryLikeEdgeRate: 0,
    reviewEdgeCount: 0,
    reviewEdgeRate: 0,
    commentaryEdgeCount: 0,
    commentaryEdgeRate: 0,
    letterEdgeCount: 0,
    letterEdgeRate: 0,
    bookChapterEdgeCount: 0,
    bookChapterEdgeRate: 0,
    articleEdgeCount: 0,
    articleEdgeRate: 0,
    preprintEdgeCount: 0,
    preprintEdgeRate: 0,
  };

  return {
    seed: { doi: "10.1/x", trackedClaim: "c" },
    edges: [],
    resolvedPapers: {},
    duplicateGroups: [],
    metrics,
    claimGrounding,
    familyUseProfile: [],
    m2Priority: "not_now",
    decision: "deprioritize",
    decisionReason: "test",
  };
}

describe("claimGroundingBlocksAnalysis", () => {
  it("never blocks for ambiguous even when blocksDownstream was true in older artifacts", () => {
    const g: ClaimGrounding = {
      status: "ambiguous",
      analystClaim: "x",
      normalizedClaim: "x",
      supportSpans: [],
      blocksDownstream: true,
      detailReason: "legacy",
    };
    expect(claimGroundingBlocksAnalysis(g)).toBe(false);
    expect(claimFamilyBlocksDownstream(minimalFamily(g))).toBe(false);
  });

  it("blocks when not_found and blocksDownstream true", () => {
    const g: ClaimGrounding = {
      status: "not_found",
      analystClaim: "x",
      normalizedClaim: "x",
      supportSpans: [],
      blocksDownstream: true,
      detailReason: "no match",
    };
    expect(claimGroundingBlocksAnalysis(g)).toBe(true);
  });
});
