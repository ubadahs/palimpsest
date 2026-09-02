import { describe, expect, it } from "vitest";

import {
  chunksOverlappingVerifiedSpans,
  selectEvidenceChunkIds,
  unionBm25Candidates,
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

describe("unionBm25Candidates", () => {
  function run(candidates: Array<[string, number]>) {
    return {
      candidates: candidates.map(([chunkId, rawScore], index) => ({
        chunkId,
        rawScore,
        rank: index + 1,
      })),
    } as never;
  }

  it("fuses by reciprocal rank so a long query cannot dominate on raw score", () => {
    // The occurrence-local query is longer and scores every chunk higher.
    const local = run([
      ["chunk_a", 9.1],
      ["chunk_b", 8.7],
      ["chunk_c", 8.2],
    ]);
    const fallback = run([
      ["chunk_c", 2.1],
      ["chunk_d", 1.9],
    ]);
    const fused = unionBm25Candidates([local, fallback]);
    // chunk_c is ranked by both runs and should outrank chunk_b, which only
    // the local run returned; under max-raw-score it would have lost.
    expect(fused.map((candidate) => candidate.chunkId)).toEqual([
      "chunk_c",
      "chunk_a",
      "chunk_b",
      "chunk_d",
    ]);
    expect(fused.map((candidate) => candidate.rank)).toEqual([1, 2, 3, 4]);
    for (let index = 1; index < fused.length; index++) {
      expect(fused[index]!.rawScore).toBeLessThanOrEqual(
        fused[index - 1]!.rawScore,
      );
    }
  });

  it("honors the candidate limit", () => {
    const fused = unionBm25Candidates(
      [
        run([
          ["a", 3],
          ["b", 2],
        ]),
        run([
          ["c", 3],
          ["d", 2],
        ]),
      ],
      3,
    );
    expect(fused).toHaveLength(3);
  });
});
