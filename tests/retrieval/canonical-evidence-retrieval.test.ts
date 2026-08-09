import { describe, expect, it } from "vitest";

import {
  chunksOverlappingVerifiedSpans,
  selectEvidenceChunkIds,
} from "../../src/retrieval/canonical-evidence-retrieval.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";

function artifact(role: string) {
  return {
    artifactId: buildStableId("fixture", { role }),
    contentHash: canonicalSha256(role),
    role,
    uri: `fixture://${role}`,
  };
}

describe("scope-span evidence pinning", () => {
  const seedTextArtifact = artifact("immutable-seed-text");
  const corpus = {
    corpusId: "corpus_1",
    seedId: "seed_a",
    seedTextArtifact,
    sourceArtifacts: [seedTextArtifact],
    configuration: {
      version: "canonical-evidence-chunking-v1" as const,
      strategy: "scope-block-character-windows" as const,
      boundaryRule: "fixed-character" as const,
      maxCharacters: 1_200,
      overlapCharacters: 200,
      sourceOrdering: "scope-block-offset-then-chunk-offset" as const,
    },
    chunks: [
      {
        chunkId: "chunk_far",
        seedId: "seed_a",
        chunkIndex: 0,
        text: "far away text",
        contentHash: canonicalSha256("far"),
        sourceBlockId: "b0",
        sourceBlockKind: "body_paragraph" as const,
        sourceBlockCharOffsetStart: 0,
        sourceBlockCharOffsetEnd: 100,
        charOffsetStart: 0,
        charOffsetEnd: 100,
        overlapWithPrevious: 0,
        sourceArtifact: seedTextArtifact,
        sourceArtifacts: [seedTextArtifact],
        configuration: {
          version: "canonical-evidence-chunking-v1" as const,
          strategy: "scope-block-character-windows" as const,
          boundaryRule: "fixed-character" as const,
          maxCharacters: 1_200,
          overlapCharacters: 200,
          sourceOrdering: "scope-block-offset-then-chunk-offset" as const,
        },
      },
      {
        chunkId: "chunk_hit",
        seedId: "seed_a",
        chunkIndex: 1,
        text: "supported claim text",
        contentHash: canonicalSha256("hit"),
        sourceBlockId: "b1",
        sourceBlockKind: "body_paragraph" as const,
        sourceBlockCharOffsetStart: 100,
        sourceBlockCharOffsetEnd: 200,
        charOffsetStart: 100,
        charOffsetEnd: 200,
        overlapWithPrevious: 0,
        sourceArtifact: seedTextArtifact,
        sourceArtifacts: [seedTextArtifact],
        configuration: {
          version: "canonical-evidence-chunking-v1" as const,
          strategy: "scope-block-character-windows" as const,
          boundaryRule: "fixed-character" as const,
          maxCharacters: 1_200,
          overlapCharacters: 200,
          sourceOrdering: "scope-block-offset-then-chunk-offset" as const,
        },
      },
    ],
  };

  const groundedFamily = {
    familyId: "family_a",
    seedId: "seed_a",
    candidateIds: ["cand_a"],
    sourceClaimRecordIds: ["claim_a"],
    trackedClaim: "supported claim",
    normalizedClaim: "supported claim",
    includedCitationOccurrenceIds: ["occ_a"],
    provenanceArtifacts: [seedTextArtifact],
    grounding: {
      status: "grounded" as const,
      detailReason: "Exact support.",
      evidenceSpans: [
        {
          text: "supported claim text",
          blockId: "b1",
          blockKind: "body_paragraph" as const,
          charOffsetStart: 120,
          charOffsetEnd: 140,
          verificationStatus: "verified_exact" as const,
          sourceArtifact: seedTextArtifact,
        },
      ],
      quoteVerification: {
        status: "verified_exact" as const,
        failures: [],
      },
      modelExecution: {
        kind: "model" as const,
        provider: "fixture",
        model: "fixture",
        promptId: "fixture",
        promptVersion: "v1",
        promptContentHash: canonicalSha256("p"),
        requestHash: canonicalSha256("r"),
        requestArtifact: artifact("req"),
        responseArtifact: artifact("res"),
      },
    },
  };

  it("finds chunks overlapping verified spans", () => {
    expect(
      chunksOverlappingVerifiedSpans(groundedFamily as never, corpus as never),
    ).toEqual(["chunk_hit"]);
  });

  it("pins overlapping chunks ahead of BM25 order", () => {
    const selected = selectEvidenceChunkIds({
      family: groundedFamily as never,
      corpus: corpus as never,
      bm25Candidates: [{ chunkId: "chunk_far" }, { chunkId: "chunk_hit" }],
      selectionLimit: 2,
    });
    expect(selected.rankingSource).toBe("bm25_with_scope_pins");
    expect(selected.pinnedChunkIds).toEqual(["chunk_hit"]);
    expect(selected.selectedChunkIds).toEqual(["chunk_hit", "chunk_far"]);
  });

  it("keeps pure BM25 order when grounding has no verified spans", () => {
    const notFound = {
      ...groundedFamily,
      grounding: {
        ...groundedFamily.grounding,
        status: "not_found" as const,
        evidenceSpans: [],
        quoteVerification: {
          status: "not_applicable" as const,
          failures: [],
        },
      },
    };
    const selected = selectEvidenceChunkIds({
      family: notFound as never,
      corpus: corpus as never,
      bm25Candidates: [{ chunkId: "chunk_far" }, { chunkId: "chunk_hit" }],
      selectionLimit: 2,
    });
    expect(selected.rankingSource).toBe("bm25");
    expect(selected.pinnedChunkIds).toEqual([]);
    expect(selected.selectedChunkIds).toEqual(["chunk_far", "chunk_hit"]);
  });
});
