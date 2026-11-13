import { describe, expect, it } from "vitest";

import {
  annotateClaimCandidate,
  classifyClaimShape,
  extractFidelityMarkers,
  selectAdaptivePortfolio,
  selectCandidates,
  adaptivePortfolioPolicySchema,
  candidateSelectionPolicySchema,
} from "../../../src/stages/discover/candidate-selection.js";
import { defaultAdaptivePortfolioPolicy } from "../../../src/contract/selection-policy.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../../src/shared/stable-identity.js";
import { expectRejected } from "../../rejection.fixture.js";

function mention(input: {
  id: string;
  paperId: string;
  group: number;
  context: string;
  mentionIndex?: number;
  blockId?: string;
}) {
  return {
    mentionId: input.id,
    seedId: "seed_a",
    citingPaperRecordId: `citing-paper_${input.paperId}`,
    citingPaperId: input.paperId,
    citedPaperId: "seed-paper",
    mentionIndex: input.mentionIndex ?? input.group,
    targetRefIds: ["seed-ref"],
    citationGroupOrdinal: input.group,
    ...(input.blockId
      ? {
          sourceLocator: {
            kind: "block_id" as const,
            value: `${input.blockId}#cg-${String(input.group)}`,
          },
        }
      : {}),
    locationQuality: "exact_dom" as const,
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
    claim: input.text,
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
      "Many Calmic neurons in the Kestrin express Lorn.",
    );
    const mainly = extractFidelityMarkers(
      "Calmic neurons in the Kestrin mainly express Lorn.",
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
      context: "Many Calmic neurons in the Kestrin express Lorn.",
    });
    const mainlyMention = mention({
      id: "m_mainly",
      paperId: "p-mainly",
      group: 0,
      context: "Calmic neurons in the Kestrin mainly express Lorn.",
    });
    const manyClaim = claim({
      id: "c_many",
      mentionId: "m_many",
      text: "Many Calmic neurons in the Kestrin express Lorn.",
      confidence: "high",
    });
    const mainlyClaim = claim({
      id: "c_mainly",
      mentionId: "m_mainly",
      text: "Calmic neurons in the Kestrin mainly express Lorn.",
      confidence: "high",
    });
    const manyCandidate = candidate({
      id: "cand_many",
      text: "Many Calmic neurons in the Kestrin express Lorn.",
      mentionIds: ["m_many"],
      claimIds: ["c_many"],
    });
    const mainlyCandidate = candidate({
      id: "cand_mainly",
      text: "Calmic neurons in the Kestrin mainly express Lorn.",
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
        context: "Lorn neurons express the marker.",
      }),
      mention({
        id: "m2",
        paperId: "p1",
        group: 1,
        context: "A second group also cites Lorn.",
      }),
      mention({
        id: "m3",
        paperId: "p2",
        group: 0,
        context: "Another paper cites Lorn.",
      }),
    ];
    const claims = [
      claim({
        id: "c1",
        mentionId: "m1",
        text: "Lorn neurons express the marker.",
        confidence: "high",
      }),
      claim({
        id: "c2",
        mentionId: "m2",
        text: "Lorn neurons express the marker.",
        confidence: "medium",
      }),
      claim({
        id: "c3",
        mentionId: "m3",
        text: "Lorn neurons express the marker.",
        confidence: "high",
      }),
    ];
    const cand = candidate({
      id: "cand_lorn",
      text: "Lorn neurons express the marker.",
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

  it("prefers a specific Lorn claim over redundant Calmic paraphrases under a modest family budget", () => {
    const gabaClaims = Array.from({ length: 8 }, (_, index) => {
      const mentionId = `mg${String(index)}`;
      const claimId = `cg${String(index)}`;
      return {
        mention: mention({
          id: mentionId,
          paperId: `calmic-${String(index)}`,
          group: 0,
          context: "Calmic interneurons play an important role in the brain.",
        }),
        claim: claim({
          id: claimId,
          mentionId,
          text:
            index % 2 === 0
              ? "Calmic interneurons play an important role in the brain."
              : "Calmic cells play an important role in cortical circuits.",
          confidence: "medium",
        }),
        candidate: candidate({
          id: `cand_gaba_${String(index)}`,
          text:
            index % 2 === 0
              ? "Calmic interneurons play an important role in the brain."
              : "Calmic cells play an important role in cortical circuits.",
          mentionIds: [mentionId],
          claimIds: [claimId],
        }),
      };
    });
    const lornMention = mention({
      id: "mp",
      paperId: "lorn-1",
      group: 0,
      context:
        "Lorn+ relay cells increase burst rate after a patterned stimulus.",
    });
    const lornClaim = claim({
      id: "cp",
      mentionId: "mp",
      text: "Lorn+ relay cells increase burst rate after a patterned stimulus.",
      confidence: "high",
    });
    const lornCandidate = candidate({
      id: "cand_lorn_specific",
      text: "Lorn+ relay cells increase burst rate after a patterned stimulus.",
      mentionIds: ["mp"],
      claimIds: ["cp"],
    });

    const dispositions = selectAdaptivePortfolio({
      candidates: [
        ...gabaClaims.map((entry) => entry.candidate),
        lornCandidate,
      ],
      mentions: [
        ...gabaClaims.map((entry) => entry.mention as never),
        lornMention as never,
      ],
      claims: [
        ...gabaClaims.map((entry) => entry.claim as never),
        lornClaim as never,
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
      selected.some((entry) => entry.candidateId === "cand_lorn_specific"),
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
          "mice were anesthetized with brinol before perfusion for immunohistochemistry.",
        memberMentions: [],
      }),
    ).toBe("methods_protocol");
    expect(
      classifyClaimShape({
        normalizedClaim:
          "lorn neurons increase burst rate; nexil marks a distinct kestrin population.",
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
          "lorn+ relay cells increase burst rate after a patterned stimulus.",
        memberMentions: [],
      }),
    ).toBe("atomic");
  });

  it("demotes brinol-style methods claims below atomic Lorn/Nexil under a tight maxFamilies", () => {
    const methodsMention = mention({
      id: "m_brinol",
      paperId: "p-methods",
      group: 0,
      context:
        "Mice were anesthetized with Brinol before perfusion for immunohistochemistry.",
    });
    const lornMention = mention({
      id: "m_lorn",
      paperId: "p-lorn",
      group: 0,
      context:
        "Lorn+ relay cells increase burst rate after a patterned stimulus.",
    });
    const nexilMention = mention({
      id: "m_nexil",
      paperId: "p-nexil",
      group: 0,
      context: "Nexil marks a distinct Kestrin neuronal population.",
    });
    const methodsClaim = claim({
      id: "c_brinol",
      mentionId: "m_brinol",
      text: "Mice were anesthetized with Brinol before perfusion for immunohistochemistry.",
      confidence: "high",
    });
    const lornClaim = claim({
      id: "c_lorn",
      mentionId: "m_lorn",
      text: "Lorn+ relay cells increase burst rate after a patterned stimulus.",
      confidence: "high",
    });
    const nexilClaim = claim({
      id: "c_nexil",
      mentionId: "m_nexil",
      text: "Nexil marks a distinct Kestrin neuronal population.",
      confidence: "high",
    });
    const methodsCandidate = candidate({
      id: "cand_brinol",
      text: "Mice were anesthetized with Brinol before perfusion for immunohistochemistry.",
      mentionIds: ["m_brinol"],
      claimIds: ["c_brinol"],
    });
    const lornCandidate = candidate({
      id: "cand_lorn",
      text: "Lorn+ relay cells increase burst rate after a patterned stimulus.",
      mentionIds: ["m_lorn"],
      claimIds: ["c_lorn"],
    });
    const nexilCandidate = candidate({
      id: "cand_nexil",
      text: "Nexil marks a distinct Kestrin neuronal population.",
      mentionIds: ["m_nexil"],
      claimIds: ["c_nexil"],
    });

    const dispositions = selectAdaptivePortfolio({
      candidates: [methodsCandidate, lornCandidate, nexilCandidate],
      mentions: [
        methodsMention as never,
        lornMention as never,
        nexilMention as never,
      ],
      claims: [methodsClaim as never, lornClaim as never, nexilClaim as never],
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
      "cand_lorn",
      "cand_nexil",
    ]);
    expect(
      dispositions.find((entry) => entry.candidateId === "cand_brinol")
        ?.annotation.claimShape,
    ).toBe("methods_protocol");
  });

  it("prefers an atomic claim over a compound multi-part sibling under a tight budget", () => {
    const atomicMention = mention({
      id: "m_atomic",
      paperId: "p-atomic",
      group: 0,
      context:
        "Lorn neurons increase burst rate 2-fold after a patterned stimulus.",
    });
    const compoundMention = mention({
      id: "m_compound",
      paperId: "p-compound",
      group: 0,
      context:
        "Lorn neurons increase burst rate; Nexil marks a distinct Kestrin population.",
    });
    const atomicClaim = claim({
      id: "c_atomic",
      mentionId: "m_atomic",
      text: "Lorn neurons increase burst rate 2-fold after a patterned stimulus.",
      confidence: "high",
    });
    const compoundClaim = claim({
      id: "c_compound",
      mentionId: "m_compound",
      text: "Lorn neurons increase burst rate; Nexil marks a distinct Kestrin population.",
      confidence: "high",
    });
    const atomicCandidate = candidate({
      id: "cand_atomic",
      text: "Lorn neurons increase burst rate 2-fold after a patterned stimulus.",
      mentionIds: ["m_atomic"],
      claimIds: ["c_atomic"],
    });
    const compoundCandidate = candidate({
      id: "cand_compound",
      text: "Lorn neurons increase burst rate; Nexil marks a distinct Kestrin population.",
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

  it("counts citation groups per paragraph, not per paper-local ordinal", () => {
    // Both groups carry ordinal 0 because the ordinal restarts in every
    // paragraph; the source locator is what makes them distinct.
    const mentions = [
      mention({
        id: "m_para1",
        paperId: "p1",
        group: 0,
        mentionIndex: 0,
        blockId: "block_intro",
        context: "Lorn neurons express the marker in the intro.",
      }),
      mention({
        id: "m_para2",
        paperId: "p1",
        group: 0,
        mentionIndex: 1,
        blockId: "block_discussion",
        context: "Lorn neurons express the marker in the discussion.",
      }),
    ];
    const claims = [
      claim({
        id: "c_para1",
        mentionId: "m_para1",
        text: "Lorn neurons express the marker.",
      }),
      claim({
        id: "c_para2",
        mentionId: "m_para2",
        text: "Lorn neurons express the marker.",
      }),
    ];
    const cand = candidate({
      id: "cand_two_paragraphs",
      text: "Lorn neurons express the marker.",
      mentionIds: ["m_para1", "m_para2"],
      claimIds: ["c_para1", "c_para2"],
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
    expect(annotation.uniqueCitingPaperCount).toBe(1);
    expect(annotation.uniqueCitationGroupCount).toBe(2);

    const [disposition] = selectAdaptivePortfolio({
      candidates: [cand],
      mentions: mentions as never[],
      claims: claims as never[],
      policy: defaultAdaptivePortfolioPolicy,
    });
    // Prepare emits one record per member occurrence.
    expect(disposition?.projectedRecordCost).toBe(2);
  });

  it("fills the family minimum before the record budget binds and records the real deferral reason", () => {
    const texts = [
      "Lorn neurons increase burst rate in sample Kestrin slices.",
      "Nexil marks a caudal Calmic population in the developing Kestrin.",
      "Calb1 neurons project to the superior colliculus in mice.",
    ];
    const mentions = texts.map((text, index) =>
      mention({
        id: `m${String(index)}`,
        paperId: `p${String(index)}`,
        group: 0,
        blockId: `block${String(index)}`,
        context: text,
      }),
    );
    const claims = texts.map((text, index) =>
      claim({
        id: `c${String(index)}`,
        mentionId: `m${String(index)}`,
        text,
        confidence: "high",
      }),
    );
    const candidates = texts.map((text, index) =>
      candidate({
        id: `cand${String(index)}`,
        text,
        mentionIds: [`m${String(index)}`],
        claimIds: [`c${String(index)}`],
      }),
    );

    // A record budget of 1 would admit a single family. The minimum of 2
    // takes priority, so two are selected and the third is deferred by budget.
    const dispositions = selectAdaptivePortfolio({
      candidates,
      mentions: mentions as never[],
      claims: claims as never[],
      policy: adaptivePortfolioPolicySchema.parse({
        mode: "adaptive_portfolio",
        minFamilies: 2,
        maxFamilies: 3,
        maxPreparedRecords: 1,
      }),
    });
    const selected = dispositions.filter((entry) => entry.selectedForScope);
    const deferred = dispositions.filter((entry) => !entry.selectedForScope);
    expect(selected).toHaveLength(2);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.bindingConstraint).toBe("max_prepared_records");
    expect(deferred[0]?.reason).toContain("max_prepared_records");
  });
});

describe("candidate selection mode all", () => {
  function census(count: number) {
    const entries = Array.from({ length: count }, (_, index) => {
      // Candidate i is restated by (i % 4) + 1 citing papers.
      const papers = (index % 4) + 1;
      const mentions = Array.from({ length: papers }, (_, paper) =>
        mention({
          id: `m${String(index)}_${String(paper)}`,
          paperId: `paper-${String(index)}-${String(paper)}`,
          group: 0,
          context: `Finding ${String(index)} holds in setting ${String(paper)}.`,
        }),
      );
      const claims = mentions.map((entry) =>
        claim({
          id: `c${entry.mentionId}`,
          mentionId: entry.mentionId,
          text: `Finding ${String(index)} holds.`,
        }),
      );
      return {
        mentions,
        claims,
        candidate: candidate({
          id: `cand_${String(index).padStart(3, "0")}`,
          text: `Finding ${String(index)} holds.`,
          mentionIds: mentions.map((entry) => entry.mentionId),
          claimIds: claims.map((entry) => entry.claimRecordId),
        }),
      };
    });
    return {
      candidates: entries.map((entry) => entry.candidate),
      mentions: entries.flatMap((entry) => entry.mentions) as never[],
      claims: entries.flatMap((entry) => entry.claims) as never[],
    };
  }

  it("selects every candidate with a reason, past any family cap or record budget", () => {
    const input = census(60);
    const dispositions = selectCandidates({
      ...input,
      policy: candidateSelectionPolicySchema.parse({ mode: "all" }),
    });
    expect(dispositions).toHaveLength(60);
    expect(dispositions.every((entry) => entry.selectedForScope)).toBe(true);
    expect(
      dispositions.every((entry) => entry.bindingConstraint === "selected"),
    ).toBe(true);
    expect(dispositions[0]!.reason).toMatch(/mode "all" keeps every candidate/);
    expect(dispositions.map((entry) => entry.rank)).toEqual(
      Array.from({ length: 60 }, (_, index) => index + 1),
    );
    // The most-restated findings lead; ties fall back to candidate ID.
    const citers = dispositions.map(
      (entry) => entry.annotation.uniqueCitingPaperCount,
    );
    expect(citers).toEqual([...citers].sort((left, right) => right - left));
    expect(dispositions[0]!.candidateId).toBe("cand_003");

    // The default portfolio, on the same candidates, defers most of them.
    const portfolio = selectCandidates({
      ...input,
      policy: defaultAdaptivePortfolioPolicy,
    });
    expect(
      portfolio.filter((entry) => entry.selectedForScope).length,
    ).toBeLessThanOrEqual(defaultAdaptivePortfolioPolicy.maxFamilies);
  });

  it("rejects portfolio settings on the all mode", () => {
    expectRejected(
      candidateSelectionPolicySchema,
      { mode: "all", maxFamilies: 5 },
      /Unrecognized key: "maxFamilies"/,
    );
  });
});
