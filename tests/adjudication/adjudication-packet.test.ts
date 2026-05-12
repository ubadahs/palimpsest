import { describe, expect, it } from "vitest";

import type {
  AdjudicationRecord,
  EvidenceSpan,
} from "../../src/domain/types.js";
import {
  buildAdjudicationPacket,
  renderAdjudicationPacket,
} from "../../src/adjudication/adjudication-packet.js";

function makeSpan(
  index: number,
  overrides: Partial<EvidenceSpan> = {},
): EvidenceSpan {
  return {
    spanId: `span-${String(index)}`,
    text: `Evidence snippet ${String(index)}.`,
    sectionTitle: "Results",
    blockKind: "body_paragraph",
    matchMethod: "bm25",
    relevanceScore: index,
    bm25Score: index,
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<AdjudicationRecord> = {},
): AdjudicationRecord {
  return {
    recordId: "record-1",
    taskId: "task-1",
    evaluationMode: "fidelity_specific_claim",
    citationRole: "substantive_attribution",
    modifiers: { isBundled: true, isReviewMediated: true, bundleSize: 3 },
    citingPaperTitle: "Citing Paper",
    citedPaperTitle: "Cited Paper",
    groundedSeedClaimText: "The cited paper reports the specific finding.",
    citingSpan:
      "Other work says something else. Mets and Meyer, 2009 reported the specific finding in this condition. A later sentence cites another source.",
    citingSpanSection: "Results",
    citingMarker: "Mets and Meyer",
    seedRefLabel: "Mets and Meyer, 2009",
    rubricQuestion: "Does the cited evidence support the citing claim?",
    evidenceSpans: [
      makeSpan(1, {
        matchMethod: "llm_reranked",
        relevanceScore: 88,
        rerankScore: 88,
      }),
      makeSpan(2, { matchMethod: "bm25", bm25Score: 42 }),
      makeSpan(3, { matchMethod: "bm25_reranked", rerankScore: 0.7 }),
      makeSpan(4, {
        text: "FULL CITED PAPER TEXT SHOULD NOT APPEAR.",
        matchMethod: "bm25",
      }),
    ],
    evidenceRetrievalStatus: "no_fulltext",
    comparison: undefined,
    verdict: undefined,
    rationale: undefined,
    retrievalQuality: undefined,
    judgeConfidence: undefined,
    adjudicator: undefined,
    adjudicatedAt: undefined,
    excluded: undefined,
    excludeReason: undefined,
    telemetry: undefined,
    ...overrides,
  };
}

describe("adjudication packet rendering", () => {
  it("preserves citation scope, retrieval warning, and top evidence formatting", () => {
    const rendered = renderAdjudicationPacket(
      buildAdjudicationPacket(makeRecord()),
    );

    expect(rendered).toContain(
      "Note: The cited paper's full text was not available",
    );
    expect(rendered).toMatch(
      /▶\s+Mets and Meyer, 2009 reported the specific finding in this condition\.\s+◀/,
    );
    expect(rendered).toContain(
      'Evidence span 1 [llm_reranked, relevance 88/100] (section: "Results")',
    );
    expect(rendered).toContain("Evidence span 2 [bm25]");
    expect(rendered).toContain("Evidence span 3 [bm25_reranked]");
    expect(rendered).not.toContain("Evidence span 4");
    expect(rendered).not.toContain("FULL CITED PAPER TEXT SHOULD NOT APPEAR");
    expect(rendered).not.toContain("bm25, relevance 42/100");
    expect(rendered).not.toContain("bm25_reranked, relevance");
  });

  it("renders no-evidence status without inventing evidence", () => {
    const rendered = renderAdjudicationPacket(
      buildAdjudicationPacket(
        makeRecord({
          evidenceSpans: [],
          evidenceRetrievalStatus: "no_matches",
        }),
      ),
    );

    expect(rendered).toContain("No matching passages were found");
    expect(rendered).toContain("No evidence spans retrieved.");
  });
});
