import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MutationFamilyView,
  ReportInspectorRecordRow,
  StageInspectorPayload,
} from "palimpsest/contract";
import type { CitationHistoryArtifact } from "palimpsest/history";

import { ReportInspector } from "../components/report-inspector";
import { formatRateValue } from "../lib/report-format";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    familyClaim: "Family claim about dorsal contact",
    evaluatedClaimText: "Several Calmic types receive dorsal contact",
    seedId: "seed_1",
    seedTitle: "Seed paper on dorsal contact",
    seedDoi: "10.1000/seed-example",
    citingPaperTitle: "Atlas of ventral visual thalamus",
    citingPaperDoi: "10.1111/example",
    citingPaperYear: 2026,
    seedRefLabel: "Marlowe et al., 2021",
    sectionTitle: "Introduction",
    citationContext:
      "Prior work demonstrated dorsal contact to Kestrin neurons.",
    classificationStatus: "classified",
    citationRole: "substantive_attribution",
    evaluationMode: "fidelity_specific_claim",
    groundingStatus: "grounded",
    verifiedSeedGroundingSpans: [
      {
        text: "Calmic neurons receive direct dorsal contact.",
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
        extractedClaimText: "Several Calmic types receive dorsal contact",
        supportSpan: {
          text: "dorsal contact to Kestrin neurons",
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
        text: "Several subtypes of Calmic neurons receive direct dorsal contact.",
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
        methodId: "audit-report-v1",
        strategy: "deterministic_funnel",
        calibrationStatus: "uncalibrated",
        outputs: "json_and_markdown",
      },
      lineage: {
        runId: "run-report-ui",
        discoverArtifact: {
          artifactId: "artifact_discover",
          contentHash: "a".repeat(64),
          role: "discover-input",
          stage: "discover",
        },
        scopeArtifact: {
          artifactId: "artifact_scope",
          contentHash: "b".repeat(64),
          role: "scope-input",
          stage: "scope",
        },
        prepareArtifact: {
          artifactId: "artifact_prepare",
          contentHash: "c".repeat(64),
          role: "prepare-input",
          stage: "prepare",
        },
        evidenceArtifact: {
          artifactId: "artifact_evidence",
          contentHash: "d".repeat(64),
          role: "evidence-input",
          stage: "evidence",
        },
        adjudicateArtifact: {
          artifactId: "artifact_adjudicate",
          contentHash: "e".repeat(64),
          role: "adjudicate-input",
          stage: "adjudicate",
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
      weightedRates: [],
      familyMutations: [],
      statementReview: {
        seedInventories: [],
        citationStatements: [],
        statementAssessments: [],
      },
      statementFidelity: {},
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
    claim: head.familyClaim,
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
    recordIds: records.map((row) => row.recordId),
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
      screen.getByText("Several Calmic types receive dorsal contact"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^D \(1\)$/i }));
    expect(
      screen.getByText("Four inhibitory neuron types were identified"),
    ).toBeTruthy();
    expect(
      screen.queryByText("Several Calmic types receive dorsal contact"),
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
    expect(screen.getByText("Seed paper on dorsal contact")).toBeTruthy();
    expect(
      screen.getByText("Calmic neurons receive direct dorsal contact."),
    ).toBeTruthy();
    expect(screen.getByText(/Chronological citing restatements/i)).toBeTruthy();
  });

  it("shows the exact shared citation marker, cited finding, and separate fidelity result", () => {
    const payload = buildPayload();
    const context =
      "Earlier discussion [6]. The effect extended to both groups [6].";
    const claim = "The effect extended to both groups [6].";
    payload.summary.statementReview = {
      seedInventories: [
        {
          seedId: "seed_1",
          seedDoi: "10.1/source",
          seedTitle: "One-group trial",
          seedPublicationYear: 2019,
          status: "completed",
          rejectedFindingCount: 0,
          reason: "Verified in Results.",
          findings: [
            {
              findingId: "finding_1",
              statement: "The trial found the effect in one group.",
              ownershipReason: "Reports a trial result.",
              hierarchy: {
                kind: "result",
                qualifiers: ["in one group"],
                supports: [],
              },
              evidenceSpans: [
                {
                  blockId: "results",
                  blockKind: "body_paragraph",
                  sectionTitle: "Results",
                  text: "We observed the effect in one group.",
                  charOffsetStart: 0,
                  charOffsetEnd: 36,
                  verificationStatus: "verified_exact",
                  sourceArtifact: {
                    artifactId: "source",
                    contentHash: "test",
                    role: "seed-text",
                  },
                },
              ],
            },
          ],
        },
      ],
      citationStatements: [
        {
          statementId: "statement_1",
          seedId: "seed_1",
          citingPaperId: "paper_1",
          citingPaperRecordId: "citing_1",
          citingTitle: "Later two-group report",
          citingPublicationYear: 2023,
          occurrenceId: "mention_1",
          claimRecordId: "claim_1",
          extractedClaimText: "The effect extended to both groups.",
          citationContext: context,
          citationMarker: "[6]",
          markerSpan: {
            charOffsetStart: context.lastIndexOf("[6]"),
            charOffsetEnd: context.lastIndexOf("[6]") + 3,
          },
          textSpan: {
            text: claim,
            charOffsetStart: context.indexOf(claim),
            charOffsetEnd: context.length,
            verificationStatus: "verified_exact",
          },
          locationQuality: "exact_dom",
          targetRefIds: ["ref_6", "ref_7"],
          bundleRefIds: ["ref_6", "ref_7"],
          credit: "shared_reference_group",
          sourceVersion: { parser: "grobid", sourceType: "pdf", artifacts: [] },
          assessment: {
            status: "assessed",
            relationship: "scope_changed",
            findingIds: ["finding_1"],
            retained: ["The effect"],
            changes: ["One group became both groups."],
            reason: "The later paper broadened the groups.",
            batchId: "batch_1",
          },
        },
      ],
      statementAssessments: [],
    };
    payload.summary.statementReview.citationStatements.unshift({
      ...payload.summary.statementReview.citationStatements[0]!,
      statementId: "statement_undated",
      citingTitle: "Undated field note",
      citingPublicationYear: undefined,
      extractedClaimText: "The note discussed a separate result.",
      markerSpan: undefined,
      textSpan: undefined,
      credit: "unverified",
      assessment: {
        status: "exact_attribution_unverified",
        relationship: "unassessed",
        findingIds: [],
        retained: [],
        changes: [],
        reason: "The citation marker was unavailable.",
      },
    });
    payload.summary.statementFidelity = {
      statement_1: [
        {
          recordId: "record_1",
          adjudication: {
            status: "adjudicated",
            adjudicationResultId: "result_1",
            verdict: "D",
            mutationKinds: [],
            direction: "shifted",
            evidenceSufficiency: "sufficient",
          },
        },
      ],
    };
    const { container } = render(
      <ReportInspector
        defaultTab="statements"
        payload={payload}
        runId="run-report-ui"
      />,
    );
    const row = screen
      .getByText("The effect extended to both groups.")
      .closest("details")!;
    row.setAttribute("open", "");
    expect(
      screen
        .getAllByText(/Later two-group report|Undated field note/)
        .map((item) => item.textContent),
    ).toEqual([
      "Later two-group report (2023)",
      "Undated field note (year unknown)",
    ]);
    expect(within(row).getByText("Shared citation credit")).toBeTruthy();
    expect(within(row).getByText("Later two-group report (2023)")).toBeTruthy();
    expect(within(row).getByText("One-group trial (2019)")).toBeTruthy();
    expect(within(row).getByText("One group became both groups.")).toBeTruthy();
    expect(
      within(row).getByText("“We observed the effect in one group.”"),
    ).toBeTruthy();
    expect(container.querySelectorAll("mark")).toHaveLength(1);
    expect(container.querySelector("mark")?.previousSibling?.textContent).toBe(
      "Earlier discussion [6]. The effect extended to both groups ",
    );
    expect(within(row).getByText("Current fidelity")).toBeTruthy();
    expect(within(row).getByText("D")).toBeTruthy();
  });

  it("reads history only on its tab and pins the request to this report", async () => {
    const fetchHistory = vi.fn().mockResolvedValue(new Response("[]"));
    vi.stubGlobal("fetch", fetchHistory);
    const payload = buildPayload();
    const { unmount } = render(
      <ReportInspector payload={payload} runId="run-report-ui" />,
    );
    expect(fetchHistory).not.toHaveBeenCalled();
    unmount();
    render(
      <ReportInspector
        defaultTab="history"
        payload={payload}
        runId="run-report-ui"
      />,
    );
    expect(
      await screen.findByText(
        "No citation history has been saved for this report.",
      ),
    ).toBeTruthy();
    expect(fetchHistory).toHaveBeenCalledWith(
      `/api/runs/run-report-ui/history?report=${payload.rawArtifact.artifactId}`,
      expect.anything(),
    );
  });

  it("shows bounded history, direct citation status, and unavailable coverage", async () => {
    const payload = buildPayload();
    const original = {
      paperId: "original",
      title: "Original trial",
      publicationYear: 2009,
    };
    const middle = {
      paperId: "middle",
      title: "Intermediate study",
      publicationYear: 2013,
    };
    const later = {
      paperId: "later",
      title: "Later review",
      publicationYear: 2020,
    };
    const unavailable = { paperId: "closed", title: "Closed paper" };
    const sourceVersion = {
      sourceType: "tei",
      parser: "tei",
      artifacts: [],
    };
    const modelResponse = {
      artifactId: "prov_comparison_response",
      contentHash: "response-hash",
      role: "citation-history-assessment-response",
    };
    const parseArtifact = {
      artifactId: "prov_citing_parse",
      contentHash: "parse-hash",
      role: "citing-paper-parse",
    };
    const history: CitationHistoryArtifact = {
      schemaVersion: "citation-history-v3",
      artifactId: "artifact_saved_history",
      contentHash: "history-hash",
      payload: {
        report: {
          runId: "run-report-ui",
          artifactId: payload.rawArtifact.artifactId,
          contentHash: payload.rawArtifact.contentHash,
        },
        limits: { maxHops: 2, maxParents: 1, maxCiters: 2, maxCostUsd: 1 },
        selection: {
          candidateCount: 2,
          eligibleCount: 1,
          selectedCount: 1,
          explicitStatementIds: [],
        },
        paths: [
          {
            statementId: "statement_1",
            original,
            middle,
            firstHop: {
              occurrenceId: "occurrence_1",
              claimRecordId: "claim_1",
              relationship: "partial",
              sourceVersion,
              credit: "shared_reference_group",
              context: "The original observed an effect [1].",
              citationMarker: "[1]",
              findingIds: ["finding_1"],
              findings: [
                {
                  findingId: "finding_1",
                  statement: "The original found an average effect.",
                  ownershipReason: "Its own study.",
                  evidenceSpans: [],
                },
              ],
              retained: ["An effect"],
              changes: [],
              reason: "The statement used part of the original finding.",
              provenanceArtifacts: [],
            },
            laterHops: [
              {
                useId: "use_2",
                status: "assessed",
                reason: "Assessed against the selected finding.",
                assessments: [
                  {
                    status: "assessed",
                    caseId: "case_2",
                    findingId: "finding_1",
                    downstreamQuote: "own subgroup effect",
                    parentTextVersionId: "prov_middle",
                    parentEvidenceStatus: "available",
                    immediateFidelity: {
                      status: "assessed",
                      verdict: "F",
                      reason: "The later paper preserves the subgroup result.",
                      evidence: [
                        {
                          blockId: "results",
                          start: 0,
                          end: 15,
                          text: "Subgroup effect",
                        },
                      ],
                    },
                    route: {
                      kind: "independent_contribution",
                      contribution: [
                        {
                          blockId: "results",
                          start: 0,
                          end: 15,
                          text: "Subgroup effect",
                        },
                      ],
                    },
                    comparison: {
                      status: "distinct",
                      retained: [],
                      changes: [],
                      reason: "The original examined a different outcome.",
                    },
                    reason:
                      "The intermediate study reported a result from its own analysis.",
                    provenanceArtifacts: [modelResponse],
                  },
                ],
                directCitation: {
                  status: "elsewhere",
                  referenceIds: ["ref_1"],
                  provenanceArtifacts: [],
                },
                provenanceArtifacts: [],
              },
            ],
          },
        ],
        citationUses: [
          {
            useId: "use_2",
            middlePaperId: "middle",
            citing: later,
            occurrenceId: "occurrence_2",
            mentionIndex: 0,
            targetRefIds: ["ref_2"],
            observationProvenance: sourceVersion,
            context:
              "The intermediate study reported its own subgroup effect [5].",
            citationMarker: "[5]",
            credit: "single_reference",
            provenanceArtifacts: [parseArtifact],
          },
        ],
        neighborhoods: [
          {
            middle,
            status: "citer_budget_exhausted",
            coverage: "truncated",
            providerReportedTotal: 3,
            allocatedCiterLimit: 2,
            omittedCount: 1,
            reason: "Citer limit reached.",
            middleSource: {
              status: "available",
              reason:
                "Verified against the same version of the intermediate paper.",
              provenanceArtifacts: [],
            },
            citers: [
              {
                paper: unavailable,
                status: "access_unavailable",
                reason: "Full text could not be retrieved.",
                provenanceArtifacts: [],
              },
              {
                paper: later,
                status: "assessed",
                reason: "Examined.",
                provenanceArtifacts: [],
              },
            ],
            provenanceArtifacts: [],
          },
        ],
      },
    };
    const secondPath = structuredClone(history.payload.paths[0]!);
    secondPath.statementId = "statement_2";
    secondPath.laterHops[0]!.assessments = [];
    secondPath.laterHops[0]!.status = "unassessed";
    secondPath.laterHops[0]!.reason =
      "The comparison exceeded the spend limit.";
    secondPath.laterHops[0]!.directCitation.status = "unknown";
    history.payload.paths.push(secondPath);
    history.payload.selection.selectedCount = 2;
    history.payload.selection.eligibleCount = 2;
    history.payload.limits.maxParents = 2;
    const fetchHistory = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              artifactId: history.artifactId,
              pathCount: 1,
              neighborhoodCount: 1,
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(history)));
    vi.stubGlobal("fetch", fetchHistory);
    render(
      <ReportInspector
        defaultTab="history"
        payload={payload}
        runId="run-report-ui"
      />,
    );

    const download = await screen.findByRole("link", {
      name: "Download history JSON",
    });
    expect(download.getAttribute("href")).toContain(
      `&artifact=${history.artifactId}&download=1`,
    );
    expect(
      screen.getByText("Original cited elsewhere in the paper"),
    ).toBeTruthy();
    expect(screen.getByText(/Intermediate paper’s own finding/)).toBeTruthy();
    expect(screen.getByText("Fidelity to the intermediate paper")).toBeTruthy();
    expect(
      screen.getByText(/The later paper preserves the subgroup result/),
    ).toBeTruthy();
    expect(
      screen.getByText("Comparison with the original finding"),
    ).toBeTruthy();
    expect(
      screen.getByText("The original examined a different outcome."),
    ).toBeTruthy();
    expect(
      screen.getByText("Contribution of the intermediate paper"),
    ).toBeTruthy();
    expect(screen.getByText("prov_comparison_response")).toBeTruthy();
    expect(screen.getByText("prov_citing_parse")).toBeTruthy();
    expect(
      screen
        .getAllByRole("link", { name: "Later review (2020)" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["#use_2", "#use_2"]);
    expect(
      screen.getAllByText(
        "The intermediate study reported its own subgroup effect [5].",
      ),
    ).toHaveLength(1);
    expect(screen.getByText(/coverage truncated/)).toBeTruthy();
    expect(
      screen.getAllByText(
        /Original trial \(2009\) → Intermediate study \(2013\)/,
      ),
    ).toHaveLength(2);
    expect(
      screen.getByText("The comparison exceeded the spend limit."),
    ).toBeTruthy();
    const coverage = screen.getByText(/coverage truncated/).closest("details")!;
    const citingWorks = within(coverage).getAllByText(
      /Later review|Closed paper/,
    );
    expect(citingWorks.map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("Later review (2020)"),
      expect.stringContaining("Closed paper (year unknown)"),
    ]);
    expect(screen.getByText("Single cited reference")).toBeTruthy();
    expect(
      screen.getByText(/same version of the intermediate paper/),
    ).toBeTruthy();
    expect(screen.getByText(/2 slots allocated/)).toBeTruthy();
    expect(screen.getByText(/access unavailable/)).toBeTruthy();
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
        name: /Family claim about dorsal contact.*3 records/i,
      }),
    );
    expect(window.location.search).toContain("family=family_1");
    expect(window.location.search).not.toContain("record=");
  });

  it("pages a large family's restatements instead of rendering them all", () => {
    const payload = buildPayload();
    const many = Array.from({ length: 120 }, (_, index) =>
      record({
        recordId: `record_many_${String(index).padStart(3, "0")}`,
        adjudicationStatus: "adjudicated",
        verdict: "F",
        evaluatedClaimText: `Restatement number ${String(index)}`,
      }),
    );
    payload.summary.records = many;
    payload.summary.families[0]!.recordIds = many.map((row) => row.recordId);
    payload.summary.families[0]!.recordCount = many.length;
    render(
      <ReportInspector
        defaultTab="families"
        payload={payload}
        runId="run-report-ui"
      />,
    );

    expect(screen.getByText("Restatement number 49")).toBeTruthy();
    expect(screen.queryByText("Restatement number 50")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 50 more of 70" }));
    expect(screen.getByText("Restatement number 99")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Show 20 more of 20" }),
    ).toBeTruthy();
  });
});
