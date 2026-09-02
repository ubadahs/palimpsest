import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  MutationFamilyView,
  ReportInspectorRecordRow,
  StageInspectorPayload,
} from "palimpsest/contract";

import { ReportInspector } from "../components/report-inspector";
import { formatRateValue } from "../lib/report-format";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

type CountUnit =
  | "seeds"
  | "citing_paper_observations"
  | "citing_papers"
  | "citation_occurrences"
  | "citation_groups"
  | "attributed_claim_records"
  | "candidates"
  | "families"
  | "family_occurrence_records"
  | "unique_claim_units"
  | "adjudication_packets"
  | "bm25_runs"
  | "rerank_runs"
  | "selections"
  | "decisions"
  | "exclusions";

function count(
  metricId: string,
  value: number,
  unit: CountUnit = "family_occurrence_records",
  population = "test population",
) {
  return { metricId, count: value, unit, population };
}

function rate(
  metricId: string,
  numerator: number,
  denominator: number,
  value: number | null,
) {
  return {
    metricId,
    numerator,
    denominator,
    value,
    unit: "test_unit",
    populationLabel: "Test population",
    numeratorDefinition: "numerator",
    denominatorDefinition: "denominator",
  };
}

function record(
  overrides: Partial<ReportInspectorRecordRow> &
    Pick<ReportInspectorRecordRow, "recordId" | "adjudicationStatus">,
): ReportInspectorRecordRow {
  return {
    familyId: "family_1",
    citationOccurrenceId: "mention_1",
    citingPaperId: "paper_1",
    trackedClaim: "Tracked claim about retinal input",
    evaluatedClaimText: "Several GABAergic types receive retinal input",
    seedId: "seed_1",
    seedTitle: "Seed paper on retinal input",
    seedDoi: "10.1000/seed-example",
    citingPaperTitle: "Atlas of ventral visual thalamus",
    citingPaperDoi: "10.1111/example",
    citingPaperYear: 2026,
    seedRefLabel: "Marlowe et al., 2021",
    sectionTitle: "Introduction",
    citationContext: "Prior work demonstrated retinal input to vRN neurons.",
    classificationStatus: "classified",
    citationRole: "substantive_attribution",
    evaluationMode: "fidelity_specific_claim",
    groundingStatus: "grounded",
    verifiedSeedGroundingSpans: [
      {
        text: "GABAergic neurons receive direct retinal input.",
        blockId: "block_1",
        blockKind: "body_paragraph",
        sectionTitle: "Results",
        charOffsetStart: 0,
        charOffsetEnd: 47,
      },
    ],
    occurrenceClaims: [
      {
        claimRecordId: "claim_1",
        extractedClaimText: "Several GABAergic types receive retinal input",
        supportSpan: {
          text: "retinal input to vRN neurons",
          charOffsetStart: 25,
          charOffsetEnd: 54,
        },
      },
    ],
    retrievalStatus: "retrieved",
    rerankStatus: "disabled",
    rankingSource: "bm25",
    evidencePassages: [
      {
        chunkId: "chunk_1",
        text: "Several subtypes of GABAergic neurons receive direct retinal input.",
        sourceBlockKind: "body_paragraph",
        sourceSectionTitle: "Results",
        pinned: true,
        modelCited: true,
      },
    ],
    ...overrides,
  };
}

function buildPayload(): StageInspectorPayload<"report"> {
  const payload = {
    stageKey: "report" as const,
    markdownPath: "/tmp/report.md",
    rawArtifact: {
      artifactId: `artifact_${"d".repeat(64)}`,
      contentHash: "e".repeat(64),
      payload: {
        interpretationWarning:
          "F/D/E/U labels are uncalibrated research outputs and have not been validated against blinded human labels. Do not treat verdict rates as calibrated faithfulness rates.",
      },
    },
    summary: {
      interpretationStatus: "uncalibrated_research_output",
      interpretationWarning:
        "F/D/E/U labels are uncalibrated research outputs and have not been validated against blinded human labels. Do not treat verdict rates as calibrated faithfulness rates.",
      method: {
        methodId: "canonical-audit-report-v1",
        strategy: "deterministic_funnel",
        calibrationStatus: "uncalibrated",
        outputs: "json_and_markdown",
      },
      lineage: {
        runId: "run-report-ui",
        discoverArtifact: {
          artifactId: "artifact_discover",
          contentHash: "a".repeat(64),
          role: "canonical-discover-input",
          canonicalStage: "discover",
        },
        scopeArtifact: {
          artifactId: "artifact_scope",
          contentHash: "b".repeat(64),
          role: "canonical-scope-input",
          canonicalStage: "scope",
        },
        prepareArtifact: {
          artifactId: "artifact_prepare",
          contentHash: "c".repeat(64),
          role: "canonical-prepare-input",
          canonicalStage: "prepare",
        },
        evidenceArtifact: {
          artifactId: "artifact_evidence",
          contentHash: "d".repeat(64),
          role: "canonical-evidence-input",
          canonicalStage: "evidence",
        },
        adjudicateArtifact: {
          artifactId: "artifact_adjudicate",
          contentHash: "e".repeat(64),
          role: "canonical-adjudicate-input",
          canonicalStage: "adjudicate",
        },
      },
      funnel: {
        discover: {
          probeStratumCounts: [],
          neighborhoodCoverage: [],
          materializationChannelCounts: [],
          materializationLossReasonCounts: [],
          harvestLossReasonCounts: [],
          bibliographyMatchMethodCounts: [],
          providerReportedNeighborhoodTotal: count(
            "discover.provider_reported_neighborhood_total",
            40,
            "citing_paper_observations",
          ),
          seeds: count("discover.seeds", 1, "seeds"),
          returnedCitingPaperObservations: count(
            "discover.returned_citing_paper_observations",
            40,
            "citing_paper_observations",
          ),
          probed: count("discover.probed", 40, "citing_paper_observations"),
          notProbed: count(
            "discover.not_probed",
            0,
            "citing_paper_observations",
          ),
          materializationSucceeded: count(
            "discover.materialization_succeeded",
            32,
            "citing_paper_observations",
          ),
          materializationFailed: count(
            "discover.materialization_failed",
            2,
            "citing_paper_observations",
          ),
          materializationUnavailable: count(
            "discover.materialization_unavailable",
            6,
            "citing_paper_observations",
          ),
          materializationNotAttempted: count(
            "discover.materialization_not_attempted",
            0,
            "citing_paper_observations",
          ),
          harvestSucceeded: count(
            "discover.harvest_succeeded",
            25,
            "citing_paper_observations",
          ),
          harvestNoMentions: count(
            "discover.harvest_no_mentions",
            7,
            "citing_paper_observations",
          ),
          harvestFailed: count(
            "discover.harvest_failed",
            0,
            "citing_paper_observations",
          ),
          harvestNotAttempted: count(
            "discover.harvest_not_attempted",
            8,
            "citing_paper_observations",
          ),
          citationOccurrences: count(
            "discover.citation_occurrences",
            61,
            "citation_occurrences",
          ),
          extractionClaimsExtracted: count(
            "discover.extraction_claims_extracted",
            57,
            "citation_occurrences",
          ),
          extractionNoClaims: count(
            "discover.extraction_no_claims",
            4,
            "citation_occurrences",
          ),
          extractionFailed: count(
            "discover.extraction_failed",
            0,
            "citation_occurrences",
          ),
          attributedClaimRecords: count(
            "discover.attributed_claim_records",
            78,
            "attributed_claim_records",
          ),
          candidateClaims: count("discover.candidate_claims", 58, "candidates"),
          selectedCandidates: count(
            "discover.selected_candidates",
            25,
            "candidates",
          ),
          deferredCandidates: count(
            "discover.deferred_candidates",
            33,
            "candidates",
          ),
          uniqueCitingPapersWithOccurrences: count(
            "discover.unique_citing_papers_with_occurrences",
            25,
            "citing_papers",
          ),
          uniqueCitationGroups: count(
            "discover.unique_citation_groups",
            45,
            "citation_groups",
          ),
          attributedClaimsWithVerifiedSupportSpan: count(
            "discover.attributed_claims_with_verified_support_span",
            70,
            "attributed_claim_records",
          ),
          attributedClaimsMissingSupportSpan: count(
            "discover.attributed_claims_missing_support_span",
            8,
            "attributed_claim_records",
          ),
          deferredByFamilyCap: count(
            "discover.deferred_by_family_cap",
            33,
            "candidates",
          ),
          deferredByRecordBudget: count(
            "discover.deferred_by_record_budget",
            0,
            "candidates",
          ),
          deferredByNovelty: count(
            "discover.deferred_by_novelty",
            0,
            "candidates",
          ),
        },
        scope: {
          scopedCandidates: count("scope.scoped_candidates", 25, "candidates"),
          deferredCandidates: count(
            "scope.deferred_candidates",
            33,
            "candidates",
          ),
          families: count("scope.families", 25, "families"),
          groundingStatusCounts: [
            { status: "grounded", count: 15 },
            { status: "ambiguous", count: 5 },
            { status: "not_found", count: 5 },
          ],
        },
        prepare: {
          expectedFamilyOccurrencePairs: count(
            "prepare.expected_family_occurrence_pairs",
            44,
          ),
          preparedRecords: count("prepare.prepared_records", 44),
          classified: count("prepare.classified", 35),
          ambiguous: count("prepare.ambiguous", 9),
          failed: count("prepare.failed", 0),
          lowInformation: count("prepare.low_information", 0),
          manualReview: count("prepare.manual_review", 9),
          manualReviewRoleAmbiguous: count(
            "prepare.manual_review_role_ambiguous",
            9,
          ),
          manualReviewExtractionLimited: count(
            "prepare.manual_review_extraction_limited",
            0,
          ),
        },
        evidence: {
          recordOutcomes: count("evidence.record_outcomes", 44),
          retrievalStatusCounts: [{ status: "retrieved", count: 44 }],
          bm25MatchedRuns: count("evidence.bm25_matched_runs", 25, "bm25_runs"),
          bm25NoMatchRuns: count("evidence.bm25_no_match_runs", 0, "bm25_runs"),
          rerankDisabled: count("evidence.rerank_disabled", 44),
          rerankCompleted: count("evidence.rerank_completed", 0),
          rerankFailed: count("evidence.rerank_failed", 0),
          rerankNotAttempted: count("evidence.rerank_not_attempted", 0),
          uniqueFinalSelectionsBm25: count(
            "evidence.unique_final_selections_bm25",
            25,
            "selections",
          ),
          uniqueFinalSelectionsReranked: count(
            "evidence.unique_final_selections_reranked",
            0,
            "selections",
          ),
          recordSelectionBm25: count("evidence.record_selection_bm25", 44),
          recordSelectionReranked: count(
            "evidence.record_selection_reranked",
            0,
          ),
        },
        adjudicate: {
          totalRecordOutcomes: count("adjudicate.total_record_outcomes", 44),
          adjudicated: count("adjudicate.adjudicated", 35),
          notAdjudicated: count("adjudicate.not_adjudicated", 9),
          adjudicationFailed: count("adjudicate.adjudication_failed", 0),
          invalidOutput: count("adjudicate.invalid_output", 0),
          gateCodeCounts: [
            { status: "manual_review_role_ambiguous", count: 9 },
          ],
          failureCodeCounts: [],
          mutationKindCounts: [],
          mutationDirectionCounts: [],
          verdictCountsByRankingSource: [],
          verdictCounts: {
            F: count("adjudicate.verdict_F", 31),
            D: count("adjudicate.verdict_D", 4),
            E: count("adjudicate.verdict_E", 0),
            U: count("adjudicate.verdict_U", 0),
          },
          uniqueClaimUnits: count(
            "adjudicate.unique_claim_units",
            20,
            "unique_claim_units",
          ),
          uniqueClaimUnitVerdictCounts: {
            F: count(
              "adjudicate.unique_claim_units_verdict_F",
              15,
              "unique_claim_units",
            ),
            D: count(
              "adjudicate.unique_claim_units_verdict_D",
              2,
              "unique_claim_units",
            ),
            E: count(
              "adjudicate.unique_claim_units_verdict_E",
              0,
              "unique_claim_units",
            ),
            U: count(
              "adjudicate.unique_claim_units_verdict_U",
              0,
              "unique_claim_units",
            ),
          },
          uniqueAdjudicatedClaimUnits: count(
            "adjudicate.unique_adjudicated_claim_units",
            17,
            "unique_claim_units",
          ),
          repeatedRecordsBeyondUniqueUnits: count(
            "adjudicate.repeated_records_beyond_unique_units",
            24,
          ),
          packetsWithVerifiedSupportSpans: count(
            "adjudicate.packets_with_verified_support_spans",
            40,
            "adjudication_packets",
          ),
          packetsMissingSupportSpans: count(
            "adjudicate.packets_missing_support_spans",
            4,
            "adjudication_packets",
          ),
          evidenceSufficient: count("adjudicate.evidence_sufficient", 33),
          evidenceLimited: count("adjudicate.evidence_limited", 2),
          figureOnlyLimitation: count("adjudicate.figure_only_limitation", 1),
        },
      },
      rates: [
        rate("scope_selection_rate", 25, 58, 25 / 58),
        rate("retrieval_coverage", 44, 44, 1),
        rate("adjudication_coverage", 35, 44, 35 / 44),
        rate("verdict_F_rate", 31, 35, 31 / 35),
        rate("verdict_D_rate", 4, 35, 4 / 35),
        rate("verdict_E_rate", 0, 35, 0),
        rate("verdict_U_rate", 0, 0, null),
        rate("verdict_F_unique_rate", 15, 17, 15 / 17),
        rate("verdict_D_unique_rate", 2, 17, 2 / 17),
        rate("verdict_E_unique_rate", 0, 17, 0),
        rate("verdict_U_unique_rate", 0, 17, 0),
      ],
      familyMutations: [],
      decisionSummaries: [
        {
          stage: "adjudicate",
          decisionType: "adjudicate_final_outcome",
          outcome: "adjudicated",
          count: 35,
          unit: "decisions",
        },
      ],
      records: [] as ReportInspectorRecordRow[],
      families: [] as MutationFamilyView[],
    },
  };
  const records = [
    record({
      recordId: "record_f",
      adjudicationStatus: "adjudicated",
      verdict: "F",
      confidence: "high",
      citingAssertion: "The attribution matches the seed findings.",
      sourceStatement: "The seed reports the same findings.",
      mutationKinds: [],
      direction: "none",
      rationale: "Direct support across multiple cited chunks.",
    }),
    record({
      recordId: "record_d",
      adjudicationStatus: "adjudicated",
      verdict: "D",
      confidence: "high",
      evaluatedClaimText: "Four inhibitory neuron types were identified",
      citingPaperTitle: "Circuit paper with distortion",
      citingAssertion: "Four inhibitory neuron types were identified.",
      sourceStatement: "The seed reported sublaminae, not total types.",
      mutationKinds: ["scope_narrowed"],
      direction: "shifted",
      rationale: "The count was materially narrowed.",
    }),
    record({
      recordId: "record_gated",
      adjudicationStatus: "not_adjudicated",
      gateCode: "manual_review_role_ambiguous",
      operationalReason: "Ambiguous citation role stays gated.",
      evaluatedClaimText: "Ambiguous role claim",
      citingPaperTitle: "Review-like paper",
      evidencePassages: [],
    }),
  ];
  const head = records[0]!;
  const family: MutationFamilyView = {
    familyId: head.familyId,
    seedId: head.seedId,
    trackedClaim: head.trackedClaim,
    seedTitle: head.seedTitle,
    verifiedSeedGroundingSpans: head.verifiedSeedGroundingSpans,
    recordCount: records.length,
    verdictCounts: {
      F: 1,
      D: 1,
      E: 0,
      U: 0,
      not_adjudicated: 1,
      failed: 0,
    },
    records,
  };
  if (head.seedDoi) family.seedDoi = head.seedDoi;
  if (head.groundingStatus) family.groundingStatus = head.groundingStatus;
  payload.summary.records = records;
  payload.summary.families = [family];
  return payload as unknown as StageInspectorPayload<"report">;
}

describe("report inspector", () => {
  it("formats zero-denominator rates as not estimable", () => {
    expect(formatRateValue(rate("verdict_U_rate", 0, 0, null))).toBe(
      "Not estimable",
    );
  });

  it("renders the uncalibrated warning and adjudicated denominators", () => {
    render(<ReportInspector payload={buildPayload()} runId="run-report-ui" />);

    expect(screen.getByText("uncalibrated_research_output")).toBeTruthy();
    expect(
      screen.getByText(/have not been validated against blinded human labels/i),
    ).toBeTruthy();
    expect(
      screen.getByText("31 of 35 adjudicated records received F"),
    ).toBeTruthy();
    expect(screen.getByText("Not estimable")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Families (1)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Records (3)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Review" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Audit trail" })).toBeTruthy();
  });

  it("filters records and expands adjudication detail", () => {
    render(
      <ReportInspector
        defaultTab="records"
        payload={buildPayload()}
        runId="run-report-ui"
      />,
    );

    expect(
      screen.getByText("Several GABAergic types receive retinal input"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^D \(1\)$/i }));
    expect(
      screen.getByText("Four inhibitory neuron types were identified"),
    ).toBeTruthy();
    expect(
      screen.queryByText("Several GABAergic types receive retinal input"),
    ).toBeNull();

    const details = screen
      .getByText("Four inhibitory neuron types were identified")
      .closest("details");
    expect(details).toBeTruthy();
    details!.setAttribute("open", "");
    expect(screen.getByText("The count was materially narrowed.")).toBeTruthy();
  });

  it("renders family mutation chronology and seed grounding", () => {
    render(
      <ReportInspector
        defaultTab="families"
        payload={buildPayload()}
        runId="run-report-ui"
      />,
    );

    expect(screen.getByText("Seed claim family")).toBeTruthy();
    expect(screen.getByText("Seed paper on retinal input")).toBeTruthy();
    expect(
      screen.getByText("GABAergic neurons receive direct retinal input."),
    ).toBeTruthy();
    expect(screen.getByText(/Chronological citing restatements/i)).toBeTruthy();
  });

  it("honors deep-link query params for families tab", () => {
    window.history.replaceState(
      {},
      "",
      "/runs/run-report-ui/stages/report?tab=families&family=family_1&record=record_d",
    );

    render(<ReportInspector payload={buildPayload()} runId="run-report-ui" />);

    expect(
      screen
        .getByRole("tab", { name: "Families (1)" })
        .getAttribute("data-state"),
    ).toBe("active");
    expect(screen.getByText("Seed claim family")).toBeTruthy();
    expect(
      screen.getByText("Four inhibitory neuron types were identified"),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Tracked claim about retinal input.*3 records/i,
      }),
    );
    expect(window.location.search).toContain("family=family_1");
    expect(window.location.search).not.toContain("record=");
  });
});
