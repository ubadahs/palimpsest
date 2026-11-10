import { describe, expect, it } from "vitest";

import {
  constructedCaseIds,
  constructedScoreMarkdown,
  scoreConstructedCases,
} from "../../src/evaluation/constructed-scoring.js";
import type { Trial } from "../../src/evaluation/runner.js";
import type {
  ConstructedLabel,
  EvaluationCase,
} from "../../src/evaluation/types.js";

function adjudicationCase(
  caseId: string,
  constructed?: ConstructedLabel,
): EvaluationCase {
  return {
    caseId,
    task: "adjudication",
    runId: "run-one",
    seedDoi: "10.1/seed",
    recordId: `record_${caseId}`,
    sourceArtifactHashes: { report: "hash" },
    unitKey: `unit_${caseId}`,
    anthropicPrompt: "prompt",
    packet: {
      citationRole: "substantive_attribution",
      evaluationMode: "fidelity_specific_claim",
      markedCitingContext: "▶ Marlowe et al. reported three marker classes. ◀",
      familyTrackedClaim: "Seed reported three marker classes.",
      citingPaperTitle: "Citing paper",
      citedPaperTitle: "Seed paper",
      occurrenceClaims: [],
      selectedChunks: [],
    },
    ...(constructed ? { constructed } : {}),
  };
}

const provenance = { sourceCaseId: "source", rationale: "why" };
const cases = [
  adjudicationCase("source"),
  adjudicationCase("pinned", {
    ...provenance,
    evidencePinned: true,
    expectedVerdict: "D",
    mutationKind: "population_shifted",
    direction: "shifted",
  }),
  adjudicationCase("ranked", {
    ...provenance,
    evidencePinned: false,
    expectedVerdict: "D",
    mutationKind: "certainty_strengthened",
    direction: "strengthened",
  }),
  adjudicationCase("control", {
    ...provenance,
    evidencePinned: true,
    expectedVerdict: "F",
  }),
];

function trial(
  providerId: string,
  caseId: string,
  verdict: string,
  mutationKinds: string[] = [],
): Trial {
  return {
    trialId: `${providerId}-${caseId}`,
    experimentId: "experiment",
    caseId,
    task: "adjudication",
    providerId,
    requestedModel: "model",
    repetition: 1,
    caseHash: "case",
    providerHash: "provider",
    status: "success",
    prediction: { verdict },
    calls: [],
    diagnostics: { response: { mutationKinds } },
  };
}

describe("constructed case scoring", () => {
  it("separates a provider that catches the edits from one that misses them", () => {
    const scores = scoreConstructedCases(
      cases,
      [
        trial("sharp", "source", "F"),
        trial("sharp", "pinned", "D", ["population_shifted"]),
        trial("sharp", "ranked", "D", ["scope_broadened"]),
        trial("sharp", "control", "F"),
        trial("lenient", "source", "F"),
        trial("lenient", "pinned", "F"),
        trial("lenient", "ranked", "U"),
        trial("lenient", "control", "F"),
      ],
      ["sharp", "lenient"],
    );
    expect(scores).toEqual([
      {
        providerId: "sharp",
        distortions: {
          cases: 2,
          scored: 2,
          matchedExpectedVerdict: 2,
          falseFaithful: 0,
          namedMutationKind: 1,
          pairs: 2,
          discriminatedPairs: 2,
        },
        pinnedEvidence: {
          scored: 1,
          matchedExpectedVerdict: 1,
          falseFaithful: 0,
        },
        byMutationKind: [
          {
            mutationKind: "certainty_strengthened",
            scored: 1,
            matchedExpectedVerdict: 1,
            falseFaithful: 0,
          },
          {
            mutationKind: "population_shifted",
            scored: 1,
            matchedExpectedVerdict: 1,
            falseFaithful: 0,
          },
        ],
        controls: { cases: 1, scored: 1, calledFaithful: 1 },
      },
      {
        providerId: "lenient",
        distortions: {
          cases: 2,
          scored: 2,
          matchedExpectedVerdict: 0,
          falseFaithful: 1,
          namedMutationKind: 0,
          pairs: 2,
          discriminatedPairs: 1,
        },
        pinnedEvidence: {
          scored: 1,
          matchedExpectedVerdict: 0,
          falseFaithful: 1,
        },
        byMutationKind: [
          {
            mutationKind: "certainty_strengthened",
            scored: 1,
            matchedExpectedVerdict: 0,
            falseFaithful: 0,
          },
          {
            mutationKind: "population_shifted",
            scored: 1,
            matchedExpectedVerdict: 0,
            falseFaithful: 1,
          },
        ],
        controls: { cases: 1, scored: 1, calledFaithful: 1 },
      },
    ]);
    const markdown = constructedScoreMarkdown(scores).join("\n");
    expect(markdown).toContain("| lenient | 2/2 | 0 | 1 | 0 | 1/2 | 1/1 |");
    expect(markdown).toContain("| lenient | 1 | 0 | 1 |");
  });

  it("exposes a provider that objects to any edit, whatever it says", () => {
    const [score] = scoreConstructedCases(
      cases,
      [
        trial("jumpy", "source", "F"),
        trial("jumpy", "pinned", "D", ["population_shifted"]),
        trial("jumpy", "control", "D", ["scope_narrowed"]),
      ],
      ["jumpy"],
    );
    expect(score!.distortions.matchedExpectedVerdict).toBe(1);
    expect(score!.controls).toEqual({ cases: 1, scored: 1, calledFaithful: 0 });
  });

  it("does not credit catching an edit when the source was also rejected", () => {
    const [score] = scoreConstructedCases(
      cases,
      [
        trial("harsh", "source", "D", ["scope_narrowed"]),
        trial("harsh", "pinned", "D", ["population_shifted"]),
      ],
      ["harsh"],
    );
    expect(score!.distortions).toMatchObject({
      scored: 1,
      matchedExpectedVerdict: 1,
      pairs: 1,
      discriminatedPairs: 0,
    });
  });

  it("leaves failed trials and datasets without constructed cases unscored", () => {
    const [score] = scoreConstructedCases(
      cases,
      [
        trial("flaky", "source", "F"),
        { ...trial("flaky", "pinned", "D"), status: "provider_failure" },
      ],
      ["flaky"],
    );
    expect(score!.distortions).toMatchObject({ scored: 0, pairs: 0 });
    expect(
      scoreConstructedCases(
        [adjudicationCase("source")],
        [trial("any", "source", "F")],
        ["any"],
      ),
    ).toEqual([]);
  });

  it("names the constructed cases so reports can set them apart", () => {
    expect(constructedCaseIds(cases)).toEqual(
      new Set(["pinned", "ranked", "control"]),
    );
  });
});
