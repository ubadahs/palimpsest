import { describe, expect, it } from "vitest";

import {
  annotateClaimCandidate,
  selectAdaptivePortfolio,
  adaptivePortfolioPolicySchema,
} from "../../src/contract/candidate-selection-policy.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";

function mention(input: {
  id: string;
  paperId: string;
  group: number;
  context: string;
}) {
  return {
    mentionId: input.id,
    seedId: "seed_a",
    citingPaperRecordId: `citing-paper_${input.paperId}`,
    citingPaperId: input.paperId,
    citedPaperId: "seed-paper",
    mentionIndex: input.group,
    targetRefIds: ["seed-ref"],
    citationGroupOrdinal: input.group,
    identityStrength: "weak_context_fallback" as const,
    citationMarker: "[1]",
    rawContext: input.context,
    isBundledCitation: false,
    bundleSize: 1,
    bundleRefIds: ["seed-ref"],
    bundlePattern: "single",
    observationProvenance: {
      sourceType: "jats_xml",
      parser: "fixture",
      artifacts: [
        {
          artifactId: buildStableId("fixture", { id: input.id }),
          contentHash: canonicalSha256(input.id),
          role: "mention",
        },
      ],
    },
  };
}

function claim(input: {
  id: string;
  mentionId: string;
  text: string;
  confidence?: "high" | "medium" | "low";
}) {
  return {
    claimRecordId: input.id,
    extractionId: `extraction_${input.id.slice(-8)}`,
    seedId: "seed_a",
    mentionId: input.mentionId,
    duplicateOrdinal: 0,
    extractedClaimText: input.text,
    sourceClaimIndex: 0,
    ...(input.confidence ? { confidence: input.confidence } : {}),
    provenanceArtifacts: [
      {
        artifactId: buildStableId("fixture", { id: input.id }),
        contentHash: canonicalSha256(input.id),
        role: "claim",
      },
    ],
  };
}

function candidate(input: {
  id: string;
  text: string;
  mentionIds: string[];
  claimIds: string[];
}) {
  return {
    candidateId: input.id,
    seedId: "seed_a",
    canonicalClaim: input.text,
    normalizedClaim: input.text.toLowerCase(),
    memberMentionIds: input.mentionIds,
    sourceClaimRecordIds: input.claimIds,
    provenanceArtifacts: [
      {
        artifactId: buildStableId("fixture", { id: input.id }),
        contentHash: canonicalSha256(input.id),
        role: "candidate",
      },
    ],
  };
}

describe("adaptive portfolio candidate selection", () => {
  it("annotates prevalence from unique papers and citation groups", () => {
    const mentions = [
      mention({
        id: "m1",
        paperId: "p1",
        group: 0,
        context: "Pvalb neurons express the marker.",
      }),
      mention({
        id: "m2",
        paperId: "p1",
        group: 1,
        context: "A second group also cites Pvalb.",
      }),
      mention({
        id: "m3",
        paperId: "p2",
        group: 0,
        context: "Another paper cites Pvalb.",
      }),
    ];
    const claims = [
      claim({
        id: "c1",
        mentionId: "m1",
        text: "Pvalb neurons express the marker.",
        confidence: "high",
      }),
      claim({
        id: "c2",
        mentionId: "m2",
        text: "Pvalb neurons express the marker.",
        confidence: "medium",
      }),
      claim({
        id: "c3",
        mentionId: "m3",
        text: "Pvalb neurons express the marker.",
        confidence: "high",
      }),
    ];
    const cand = candidate({
      id: "cand_pvalb",
      text: "Pvalb neurons express the marker.",
      mentionIds: ["m1", "m2", "m3"],
      claimIds: ["c1", "c2", "c3"],
    });
    const annotation = annotateClaimCandidate({
      candidate: cand,
      mentionsById: new Map(
        mentions.map((entry) => [entry.mentionId, entry as never]),
      ),
      claimsById: new Map(
        claims.map((entry) => [entry.claimRecordId, entry as never]),
      ),
    });
    expect(annotation.uniqueCitingPaperCount).toBe(2);
    expect(annotation.uniqueCitationGroupCount).toBe(3);
    expect(annotation.sourceRecordCount).toBe(3);
    expect(annotation.specificityScore).toBeGreaterThan(0.2);
  });

  it("prefers a specific Pvalb claim over redundant GABAergic paraphrases under a modest family budget", () => {
    const gabaClaims = Array.from({ length: 8 }, (_, index) => {
      const mentionId = `mg${String(index)}`;
      const claimId = `cg${String(index)}`;
      return {
        mention: mention({
          id: mentionId,
          paperId: `gaba-${String(index)}`,
          group: 0,
          context:
            "GABAergic interneurons play an important role in the brain.",
        }),
        claim: claim({
          id: claimId,
          mentionId,
          text:
            index % 2 === 0
              ? "GABAergic interneurons play an important role in the brain."
              : "GABAergic cells play an important role in cortical circuits.",
          confidence: "medium",
        }),
        candidate: candidate({
          id: `cand_gaba_${String(index)}`,
          text:
            index % 2 === 0
              ? "GABAergic interneurons play an important role in the brain."
              : "GABAergic cells play an important role in cortical circuits.",
          mentionIds: [mentionId],
          claimIds: [claimId],
        }),
      };
    });
    const pvalbMention = mention({
      id: "mp",
      paperId: "pvalb-1",
      group: 0,
      context:
        "Pvalb+ fast-spiking interneurons increase gamma power after 40 Hz stimulation.",
    });
    const pvalbClaim = claim({
      id: "cp",
      mentionId: "mp",
      text: "Pvalb+ fast-spiking interneurons increase gamma power after 40 Hz stimulation.",
      confidence: "high",
    });
    const pvalbCandidate = candidate({
      id: "cand_pvalb_specific",
      text: "Pvalb+ fast-spiking interneurons increase gamma power after 40 Hz stimulation.",
      mentionIds: ["mp"],
      claimIds: ["cp"],
    });

    const dispositions = selectAdaptivePortfolio({
      candidates: [
        ...gabaClaims.map((entry) => entry.candidate),
        pvalbCandidate,
      ],
      mentions: [
        ...gabaClaims.map((entry) => entry.mention as never),
        pvalbMention as never,
      ],
      claims: [
        ...gabaClaims.map((entry) => entry.claim as never),
        pvalbClaim as never,
      ],
      policy: adaptivePortfolioPolicySchema.parse({
        mode: "adaptive_portfolio",
        minFamilies: 3,
        maxFamilies: 5,
        maxPreparedRecords: 20,
        minMarginalNovelty: 0.05,
      }),
    });

    const selected = dispositions.filter((entry) => entry.selectedForScope);
    expect(selected.length).toBeGreaterThanOrEqual(3);
    expect(selected.length).toBeLessThanOrEqual(5);
    expect(
      selected.some((entry) => entry.candidateId === "cand_pvalb_specific"),
    ).toBe(true);
    const gabaSelected = selected.filter((entry) =>
      entry.candidateId.startsWith("cand_gaba_"),
    ).length;
    expect(gabaSelected).toBeLessThan(selected.length);
  });
});
