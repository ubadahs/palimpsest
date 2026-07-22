import { describe, expect, it } from "vitest";

import {
  annotateClaimCandidate,
  classifyClaimShape,
  extractFidelityMarkers,
  selectAdaptivePortfolio,
  adaptivePortfolioPolicySchema,
} from "../../src/contract/candidate-selection-policy.js";
import { defaultAdaptivePortfolioPolicy } from "../../src/contract/adaptive-portfolio-policy.js";
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
  it("defaults to balanced prevalence and novelty weights under v3 policy", () => {
    expect(defaultAdaptivePortfolioPolicy.policyVersion).toBe(
      "adaptive-portfolio-v3",
    );
    expect(defaultAdaptivePortfolioPolicy.prevalenceWeight).toBe(0.25);
    expect(defaultAdaptivePortfolioPolicy.noveltyWeight).toBe(0.25);
    expect(defaultAdaptivePortfolioPolicy.specificityWeight).toBe(0.35);
    expect(defaultAdaptivePortfolioPolicy.confidenceWeight).toBe(0.15);
  });

  it("extracts distinct fidelity markers for many vs mainly", () => {
    const many = extractFidelityMarkers(
      "Many GABAergic neurons in the VRN express Pvalb.",
    );
    const mainly = extractFidelityMarkers(
      "GABAergic neurons in the VRN mainly express Pvalb.",
    );
    expect(many).toContain("quantifier:many");
    expect(mainly).toContain("quantifier:mainly");
    expect(many).not.toEqual(mainly);
  });

  it("keeps fidelity-sensitive near-paraphrases non-redundant in the portfolio", () => {
    const manyMention = mention({
      id: "m_many",
      paperId: "p-many",
      group: 0,
      context: "Many GABAergic neurons in the VRN express Pvalb.",
    });
    const mainlyMention = mention({
      id: "m_mainly",
      paperId: "p-mainly",
      group: 0,
      context: "GABAergic neurons in the VRN mainly express Pvalb.",
    });
    const manyClaim = claim({
      id: "c_many",
      mentionId: "m_many",
      text: "Many GABAergic neurons in the VRN express Pvalb.",
      confidence: "high",
    });
    const mainlyClaim = claim({
      id: "c_mainly",
      mentionId: "m_mainly",
      text: "GABAergic neurons in the VRN mainly express Pvalb.",
      confidence: "high",
    });
    const manyCandidate = candidate({
      id: "cand_many",
      text: "Many GABAergic neurons in the VRN express Pvalb.",
      mentionIds: ["m_many"],
      claimIds: ["c_many"],
    });
    const mainlyCandidate = candidate({
      id: "cand_mainly",
      text: "GABAergic neurons in the VRN mainly express Pvalb.",
      mentionIds: ["m_mainly"],
      claimIds: ["c_mainly"],
    });

    const dispositions = selectAdaptivePortfolio({
      candidates: [manyCandidate, mainlyCandidate],
      mentions: [manyMention as never, mainlyMention as never],
      claims: [manyClaim as never, mainlyClaim as never],
      policy: adaptivePortfolioPolicySchema.parse({
        mode: "adaptive_portfolio",
        minFamilies: 2,
        maxFamilies: 2,
        maxPreparedRecords: 20,
        minMarginalNovelty: 0.08,
      }),
    });

    const selected = dispositions.filter((entry) => entry.selectedForScope);
    expect(selected.map((entry) => entry.candidateId).sort()).toEqual([
      "cand_mainly",
      "cand_many",
    ]);
    for (const entry of selected) {
      expect(entry.componentScores?.novelty).toBe(1);
    }
  });

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

  it("classifies methods, compound, and citing-meta claim shapes", () => {
    expect(
      classifyClaimShape({
        normalizedClaim:
          "mice were anesthetized with avertin before perfusion for immunohistochemistry.",
        memberMentions: [],
      }),
    ).toBe("methods_protocol");
    expect(
      classifyClaimShape({
        normalizedClaim:
          "pvalb neurons increase gamma power; nxph1 marks a distinct vrn population.",
        memberMentions: [],
      }),
    ).toBe("compound");
    expect(
      classifyClaimShape({
        normalizedClaim:
          "prior studies previously estimated that the seed paper described this circuit.",
        memberMentions: [],
      }),
    ).toBe("citing_meta");
    expect(
      classifyClaimShape({
        normalizedClaim:
          "pvalb+ fast-spiking interneurons increase gamma power after 40 hz stimulation.",
        memberMentions: [],
      }),
    ).toBe("atomic");
  });

  it("demotes avertin-style methods claims below atomic Pvalb/Nxph1 under a tight maxFamilies", () => {
    const methodsMention = mention({
      id: "m_avertin",
      paperId: "p-methods",
      group: 0,
      context:
        "Mice were anesthetized with Avertin before perfusion for immunohistochemistry.",
    });
    const pvalbMention = mention({
      id: "m_pvalb",
      paperId: "p-pvalb",
      group: 0,
      context:
        "Pvalb+ fast-spiking interneurons increase gamma power after 40 Hz stimulation.",
    });
    const nxph1Mention = mention({
      id: "m_nxph1",
      paperId: "p-nxph1",
      group: 0,
      context: "Nxph1 marks a distinct VRN neuronal population.",
    });
    const methodsClaim = claim({
      id: "c_avertin",
      mentionId: "m_avertin",
      text: "Mice were anesthetized with Avertin before perfusion for immunohistochemistry.",
      confidence: "high",
    });
    const pvalbClaim = claim({
      id: "c_pvalb",
      mentionId: "m_pvalb",
      text: "Pvalb+ fast-spiking interneurons increase gamma power after 40 Hz stimulation.",
      confidence: "high",
    });
    const nxph1Claim = claim({
      id: "c_nxph1",
      mentionId: "m_nxph1",
      text: "Nxph1 marks a distinct VRN neuronal population.",
      confidence: "high",
    });
    const methodsCandidate = candidate({
      id: "cand_avertin",
      text: "Mice were anesthetized with Avertin before perfusion for immunohistochemistry.",
      mentionIds: ["m_avertin"],
      claimIds: ["c_avertin"],
    });
    const pvalbCandidate = candidate({
      id: "cand_pvalb",
      text: "Pvalb+ fast-spiking interneurons increase gamma power after 40 Hz stimulation.",
      mentionIds: ["m_pvalb"],
      claimIds: ["c_pvalb"],
    });
    const nxph1Candidate = candidate({
      id: "cand_nxph1",
      text: "Nxph1 marks a distinct VRN neuronal population.",
      mentionIds: ["m_nxph1"],
      claimIds: ["c_nxph1"],
    });

    const dispositions = selectAdaptivePortfolio({
      candidates: [methodsCandidate, pvalbCandidate, nxph1Candidate],
      mentions: [
        methodsMention as never,
        pvalbMention as never,
        nxph1Mention as never,
      ],
      claims: [
        methodsClaim as never,
        pvalbClaim as never,
        nxph1Claim as never,
      ],
      policy: adaptivePortfolioPolicySchema.parse({
        mode: "adaptive_portfolio",
        minFamilies: 1,
        maxFamilies: 2,
        maxPreparedRecords: 20,
        minMarginalNovelty: 0.05,
      }),
    });

    const selected = dispositions.filter((entry) => entry.selectedForScope);
    expect(selected.map((entry) => entry.candidateId).sort()).toEqual([
      "cand_nxph1",
      "cand_pvalb",
    ]);
    expect(
      dispositions.find((entry) => entry.candidateId === "cand_avertin")
        ?.annotation.claimShape,
    ).toBe("methods_protocol");
  });

  it("prefers an atomic claim over a compound multi-part sibling under a tight budget", () => {
    const atomicMention = mention({
      id: "m_atomic",
      paperId: "p-atomic",
      group: 0,
      context: "Pvalb neurons increase gamma power after 40 Hz stimulation.",
    });
    const compoundMention = mention({
      id: "m_compound",
      paperId: "p-compound",
      group: 0,
      context:
        "Pvalb neurons increase gamma power; Nxph1 marks a distinct VRN population.",
    });
    const atomicClaim = claim({
      id: "c_atomic",
      mentionId: "m_atomic",
      text: "Pvalb neurons increase gamma power after 40 Hz stimulation.",
      confidence: "high",
    });
    const compoundClaim = claim({
      id: "c_compound",
      mentionId: "m_compound",
      text: "Pvalb neurons increase gamma power; Nxph1 marks a distinct VRN population.",
      confidence: "high",
    });
    const atomicCandidate = candidate({
      id: "cand_atomic",
      text: "Pvalb neurons increase gamma power after 40 Hz stimulation.",
      mentionIds: ["m_atomic"],
      claimIds: ["c_atomic"],
    });
    const compoundCandidate = candidate({
      id: "cand_compound",
      text: "Pvalb neurons increase gamma power; Nxph1 marks a distinct VRN population.",
      mentionIds: ["m_compound"],
      claimIds: ["c_compound"],
    });

    const dispositions = selectAdaptivePortfolio({
      candidates: [atomicCandidate, compoundCandidate],
      mentions: [atomicMention as never, compoundMention as never],
      claims: [atomicClaim as never, compoundClaim as never],
      policy: adaptivePortfolioPolicySchema.parse({
        mode: "adaptive_portfolio",
        minFamilies: 1,
        maxFamilies: 1,
        maxPreparedRecords: 20,
        minMarginalNovelty: 0.05,
      }),
    });

    const selected = dispositions.filter((entry) => entry.selectedForScope);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.candidateId).toBe("cand_atomic");
    expect(
      dispositions.find((entry) => entry.candidateId === "cand_compound")
        ?.annotation.claimShape,
    ).toBe("compound");
  });
});
