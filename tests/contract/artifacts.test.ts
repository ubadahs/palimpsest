import { describe, expect, it } from "vitest";

import {
  adjudicateArtifactSchema,
  artifactReferenceSchema,
  appendOnlyDecisionSchema,
  buildAttributedClaimRecordId,
  buildClaimCandidateId,
  buildClaimExtractionObservationId,
  buildCitationOccurrenceId,
  buildCitationInstanceRecordId,
  buildCitingPaperRecordId,
  buildEvidenceQueryId,
  buildNeighborhoodQueryId,
  buildReportDecisionRecordId,
  buildScopedFamilyId,
  buildSeedId,
  createAppendOnlyDecision,
  buildReportCount,
  buildReportRate,
  buildReportWeightedRate,
  createStageArtifact,
  discoverArtifactPayloadSchema,
  discoverArtifactSchema,
  evidenceArtifactSchema,
  artifactIdSchema,
  currentArtifactSchemaVersion,
  currentArtifactVersion,
  stageArtifactSchema,
  parseStageArtifact,
  prepareArtifactSchema,
  reportMethodId,
  REPORT_INTERPRETATION_WARNING,
  REPORT_PUBLICATION_REASON,
  reportArtifactSchema,
  sha256DigestSchema,
  scopedFamilySchema,
  scopeArtifactSchema,
  stableIdentifierSchema,
  type AppendOnlyDecision,
  type ArtifactReference,
  type ArtifactProvenance,
  type ExecutionMetadata,
  type StageArtifact,
} from "../../src/contract/artifacts/index.js";
import {
  artifactReferenceSchema as primitiveArtifactReferenceSchema,
  artifactIdSchema as primitiveArtifactIdSchema,
  sha256DigestSchema as primitiveSha256DigestSchema,
  stableIdentifierSchema as primitiveStableIdentifierSchema,
} from "../../src/contract/artifacts/primitives.js";
import { computeArtifactId } from "../../src/contract/artifacts/envelope.js";
import { deriveStageSummary } from "../../src/contract/selectors.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";

const deterministicExecution: ExecutionMetadata = {
  kind: "deterministic",
  implementation: "test-fixture-v1",
  replayableFromInputs: true,
};

const provenance: ArtifactProvenance = {
  configuration: {
    contentHash: canonicalSha256({ mode: "test", threshold: 0.5 }),
  },
  code: {
    revision: "0123456789abcdef",
    dirty: false,
  },
  prompts: [],
  models: [],
};

function baseEnvelope(createdAt = "2026-07-16T12:00:00.000Z") {
  return {
    schemaVersion: currentArtifactSchemaVersion,
    artifactVersion: currentArtifactVersion,
    runId: "run-contract-test",
    createdAt,
    inputArtifacts: [] as ArtifactReference[],
    provenance,
    execution: deterministicExecution,
    decisions: [] as AppendOnlyDecision[],
  };
}

function asReference(artifact: StageArtifact, role: string): ArtifactReference {
  return {
    artifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    role,
    stage: artifact.stage,
  };
}

function lineageReference<
  Role extends "evidence-input" | "prepare-input",
  Stage extends "evidence" | "prepare",
>(
  artifact: StageArtifact,
  role: Role,
  stage: Stage,
): {
  artifactId: string;
  contentHash: string;
  role: Role;
  stage: Stage;
} {
  return {
    artifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    role,
    stage,
  };
}

function buildAllStageArtifacts() {
  const rawInputReference: ArtifactReference = {
    artifactId: buildStableId("input", { doi: "10.1234/seed" }),
    contentHash: canonicalSha256({ doi: "10.1234/seed" }),
    role: "discovery-input",
  };
  const requestReference: ArtifactReference = {
    artifactId: buildStableId("request", { doi: "10.1234/seed" }),
    contentHash: canonicalSha256({ request: "10.1234/seed" }),
    role: "provider-request",
  };
  const responseReference: ArtifactReference = {
    artifactId: buildStableId("response", { doi: "10.1234/seed" }),
    contentHash: canonicalSha256({ response: "seed and neighborhood fixture" }),
    role: "provider-response",
  };
  const seedId = buildSeedId({ doi: "10.1234/seed" });
  const neighborhoodIdentity = {
    seedId,
    provider: "fixture-provider",
    query: "cites:seed-paper",
    limit: 10,
  };
  const neighborhoodId = buildNeighborhoodQueryId(neighborhoodIdentity);
  const citingPaperRecordId = buildCitingPaperRecordId({
    seedId,
    provider: neighborhoodIdentity.provider,
    providerRecordId: "provider-citing-paper",
  });
  const mentionIdentity = {
    seedId,
    citingPaperRecordId,
    citingPaperId: "citing-paper",
    citedPaperId: "seed-paper",
    mentionIndex: 0,
    refId: "ref-7",
    targetRefIds: ["ref-7"],
    charOffsetStart: 100,
    charOffsetEnd: 149,
    citationMarker: "[7]",
    rawContext: "Prior work [7] reported the measured effect.",
  };
  const mentionId = buildCitationOccurrenceId(mentionIdentity);
  const sourceClaimRecordIdentity = {
    seedId,
    mentionId,
    duplicateOrdinal: 0,
    extractedClaimText: "The intervention changed the measured outcome.",
  };
  const sourceClaimRecordId = buildAttributedClaimRecordId(
    sourceClaimRecordIdentity,
  );
  const extractionId = buildClaimExtractionObservationId({
    seedId,
    mentionId,
  });
  const claim = "The intervention changed the measured outcome.";
  const candidateIdentity = {
    seedId,
    normalizedClaim: "the intervention changed the measured outcome.",
    sourceClaimRecordIds: [sourceClaimRecordId],
  };
  const candidateId = buildClaimCandidateId(candidateIdentity);
  const familyId = buildScopedFamilyId({
    seedId,
    normalizedClaim: claim,
  });
  const discover = createStageArtifact({
    ...baseEnvelope(),
    stage: "discover",
    inputArtifacts: [rawInputReference],
    payload: {
      seeds: [
        {
          seedId,
          doi: "10.1234/seed",
          provenanceArtifacts: [
            rawInputReference,
            requestReference,
            responseReference,
          ],
          resolution: {
            status: "resolved",
            provider: "fixture-provider",
            requestHash: canonicalSha256({ doi: "10.1234/seed" }),
            requestArtifact: requestReference,
            responseArtifact: responseReference,
            paper: {
              paperId: "seed-paper",
              providerRecordId: "provider-seed-paper",
              title: "Seed paper",
              doi: "10.1234/seed",
              authors: ["Seed Author"],
              publicationYear: 2020,
            },
          },
        },
      ],
      neighborhoodQueries: [
        {
          neighborhoodId,
          seedId,
          provider: neighborhoodIdentity.provider,
          query: neighborhoodIdentity.query,
          configuredLimit: neighborhoodIdentity.limit,
          status: "completed",
          statusReason: "Fixture provider query completed",
          returnedCount: 1,
          providerReportedTotal: 1,
          coverage: "complete",
          probeStrata: [
            {
              yearBand: "2020-2024",
              typeGroup: "other",
              enumeratedCount: 1,
              frameCount: 1,
              probedCount: 1,
              probedFrameCount: 1,
              inclusionProbability: 1,
            },
          ],
          requestHash: canonicalSha256({ query: "cites:seed-paper" }),
          requestArtifact: requestReference,
          responseArtifact: responseReference,
          provenanceArtifacts: [requestReference, responseReference],
        },
      ],
      citingPapers: [
        {
          citingPaperRecordId,
          seedId,
          neighborhoodId,
          provider: neighborhoodIdentity.provider,
          providerRecordId: "provider-citing-paper",
          providerPosition: 0,
          paper: {
            paperId: "citing-paper",
            title: "Citing paper",
            doi: "10.1234/citing",
            authors: ["Citing Author"],
            publicationYear: 2024,
            fullTextAvailability: "available",
          },
          provenanceArtifacts: [responseReference],
          probe: {
            status: "selected",
            stratum: { yearBand: "2020-2024", typeGroup: "other" },
            reason: "Within fixture probe budget",
            provenanceArtifacts: [responseReference],
          },
          materialization: {
            status: "succeeded",
            reason: "Fixture full text materialized",
            provenanceArtifacts: [responseReference],
          },
          harvest: {
            status: "succeeded",
            reason: "Fixture occurrence harvested",
            provenanceArtifacts: [responseReference],
            observedMentionCount: 1,
          },
        },
      ],
      citationMentions: [
        {
          mentionId,
          ...mentionIdentity,
          locationQuality: "exact_dom",
          sectionTitle: "Discussion",
          seedRefLabel: "Seed Author, 2020",
          isBundledCitation: false,
          bundleSize: 1,
          bundleRefIds: ["ref-7"],
          bundlePattern: "single",
          observationProvenance: {
            sourceType: "jats_xml",
            parser: "jats-v1",
            artifacts: [responseReference],
          },
        },
      ],
      claimExtractionObservations: [
        {
          extractionId,
          seedId,
          mentionId,
          status: "claims_extracted",
          reason: "Fixture attributed claim extracted",
          claimRecordIds: [sourceClaimRecordId],
          provenanceArtifacts: [responseReference],
          execution: {
            kind: "deterministic",
            implementation: "fixture-extractor-v1",
          },
        },
      ],
      attributedClaimRecords: [
        {
          claimRecordId: sourceClaimRecordId,
          extractionId,
          ...sourceClaimRecordIdentity,
          sourceClaimIndex: 0,
          provenanceArtifacts: [responseReference],
        },
      ],
      claimCandidates: [
        {
          candidateId,
          seedId,
          claim,
          normalizedClaim: candidateIdentity.normalizedClaim,
          memberMentionIds: [mentionId],
          sourceClaimRecordIds: candidateIdentity.sourceClaimRecordIds,
          provenanceArtifacts: [responseReference],
        },
      ],
      candidateDispositions: [
        {
          candidateId,
          selectedForScope: true,
          rank: 1,
          reason: "Highest-supported claim candidate.",
          annotation: {
            policyVersion: "adaptive-portfolio-v3",
            uniqueCitingPaperCount: 1,
            uniqueCitationGroupCount: 1,
            sourceRecordCount: 1,
            mentionCount: 1,
            confidenceAggregate: 0.5,
            specificityScore: 0.5,
            informativeTokenCount: 4,
            namedOrAlphanumericTermCount: 1,
            quantityCount: 0,
            comparisonCount: 0,
            conditionCount: 0,
            genericLanguagePenalty: 0,
            claimShape: "atomic",
          },
        },
      ],
    },
  });
  const discoverReference = {
    ...asReference(discover, "discover-input"),
    role: "discover-input" as const,
    stage: "discover" as const,
  };
  const scopeDecision = createAppendOnlyDecision({
    recordId: candidateId,
    decisionType: "scope_candidate_disposition",
    outcome: "scoped",
    reason: "Highest-supported claim candidate.",
    recordedAt: "2026-07-16T12:00:00.000Z",
    actor: {
      kind: "deterministic",
      identifier: "scope-membership-freeze-v1",
    },
    evidenceArtifacts: [discoverReference],
  });
  const scope = createStageArtifact({
    ...baseEnvelope(),
    stage: "scope",
    inputArtifacts: [discoverReference],
    decisions: [scopeDecision],
    payload: {
      discoverArtifact: discoverReference,
      candidateDecisions: [
        {
          candidateId,
          seedId,
          disposition: "scoped",
          familyId,
          discoverRank: 1,
          discoverReason: "Highest-supported claim candidate.",
          sourceClaimRecordIds: [sourceClaimRecordId],
          memberMentionIds: [mentionId],
        },
      ],
      seedMaterializations: [
        {
          seedId,
          status: "seed_text_unavailable",
          reasonCode: "unavailable",
          reason: "Fixture intentionally omits seed full text.",
          provenanceArtifacts: [responseReference],
          execution: {
            kind: "deterministic",
            implementation: "fixture-materializer-v1",
            sourceArtifacts: [responseReference],
          },
        },
      ],
      families: [
        {
          familyId,
          seedId,
          candidateIds: [candidateId],
          sourceClaimRecordIds: [sourceClaimRecordId],
          claim: claim,
          normalizedClaim: claim,
          grounding: {
            status: "seed_text_unavailable",
            evidenceSpans: [],
            detailReason: "Fixture intentionally omits seed full text.",
            quoteVerification: {
              status: "not_applicable",
              failures: [],
            },
          },
          includedCitationOccurrenceIds: [mentionId],
          provenanceArtifacts: [discoverReference, responseReference],
        },
      ],
      codebooks: [
        {
          status: "seed_text_unavailable",
          seedId,
          reason: "Fixture intentionally omits seed full text.",
        },
      ],
      claimTags: [
        {
          claimRecordId: sourceClaimRecordId,
          seedId,
          status: "not_tagged",
          reason: "codebook_unavailable",
        },
      ],
    },
  });
  const prepareScopeReference = {
    ...asReference(scope, "scope-input"),
    role: "scope-input" as const,
    stage: "scope" as const,
  };
  if (discover.stage !== "discover" || scope.stage !== "scope") {
    throw new Error("Expected Discover and Scope artifacts");
  }
  const family = scope.payload.families[0]!;
  const citationOccurrence = discover.payload.citationMentions[0]!;
  const prepareRecordId = buildCitationInstanceRecordId({
    familyId: family.familyId,
    citationOccurrenceId: citationOccurrence.mentionId,
  });
  const prepareLineage = {
    runId: "run-contract-test",
    scopeArtifact: prepareScopeReference,
    discoverArtifact: discoverReference,
  };
  const classificationRationale =
    "Fixture role classification for the prepared citation instance.";
  const prepareSourceCandidates = discover.payload.claimCandidates.filter(
    (candidate) => family.candidateIds.includes(candidate.candidateId),
  );
  const prepareSourceClaimRecords =
    discover.payload.attributedClaimRecords.filter((sourceClaim) =>
      family.sourceClaimRecordIds.includes(sourceClaim.claimRecordId),
    );
  const prepareRecord = {
    recordId: prepareRecordId,
    familyId: family.familyId,
    citationOccurrenceId: citationOccurrence.mentionId,
    occurrenceSourceCandidateIds: prepareSourceCandidates
      .filter((candidate) =>
        candidate.memberMentionIds.includes(citationOccurrence.mentionId),
      )
      .map((candidate) => candidate.candidateId),
    occurrenceSourceClaimRecordIds: prepareSourceClaimRecords
      .filter(
        (sourceClaim) => sourceClaim.mentionId === citationOccurrence.mentionId,
      )
      .map((sourceClaim) => sourceClaim.claimRecordId),
    citationOccurrence,
    classification: {
      status: "classified" as const,
      citationRole: "substantive_attribution" as const,
      evaluationMode: "fidelity_specific_claim" as const,
      modifiers: {
        isBundled: false,
        isReviewMediated: false,
        bundleSize: 1,
      },
      signals: ["fixture:substantive-attribution"],
      rationale: classificationRationale,
      confidence: "high" as const,
      execution: {
        kind: "deterministic" as const,
        implementation: "fixture-classifier-v1",
      },
    },
  };
  const prepareDecision = createAppendOnlyDecision({
    recordId: prepareRecordId,
    decisionType: "prepare_classification_outcome",
    outcome: "classified",
    reason: classificationRationale,
    recordedAt: "2026-07-16T12:00:00.000Z",
    actor: {
      kind: "deterministic",
      identifier: "fixture-classifier-v1",
    },
    evidenceArtifacts: [prepareScopeReference, discoverReference],
  });
  const prepare = createStageArtifact({
    ...baseEnvelope(),
    stage: "prepare",
    inputArtifacts: [prepareScopeReference, discoverReference],
    decisions: [prepareDecision],
    payload: {
      lineage: prepareLineage,
      seeds: [discover.payload.seeds[0]!],
      scopedFamilies: [family],
      sourceCandidates: prepareSourceCandidates,
      sourceClaimRecords: prepareSourceClaimRecords,
      citingPapers: [discover.payload.citingPapers[0]!],
      records: [prepareRecord],
    },
  });
  const evidencePrepareReference = {
    ...asReference(prepare, "prepare-input"),
    role: "prepare-input" as const,
    stage: "prepare" as const,
  };
  const evidenceScopeReference = {
    ...asReference(scope, "scope-input"),
    role: "scope-input" as const,
    stage: "scope" as const,
  };
  const evidenceQueryText = family.claim;
  const evidenceQueryId = buildEvidenceQueryId({
    familyId: family.familyId,
    text: evidenceQueryText,
    source: "scope-family-claim",
  });
  const evidenceInputArtifacts = [
    evidencePrepareReference,
    evidenceScopeReference,
  ];
  const evidenceDecisions = [
    createAppendOnlyDecision({
      recordId: prepareRecordId,
      decisionType: "evidence_retrieval_outcome",
      outcome: "seed_text_unavailable",
      reason: "Fixture seed text is unavailable.",
      recordedAt: "2026-07-16T12:00:00.000Z",
      actor: {
        kind: "deterministic",
        identifier: "evidence-bm25-v1",
      },
      evidenceArtifacts: evidenceInputArtifacts,
    }),
    createAppendOnlyDecision({
      recordId: prepareRecordId,
      decisionType: "evidence_rerank_outcome",
      outcome: "disabled",
      reason: "Fixture reranking is disabled.",
      recordedAt: "2026-07-16T12:00:00.000Z",
      actor: {
        kind: "deterministic",
        identifier: "evidence-rerank-policy-v1",
      },
      evidenceArtifacts: evidenceInputArtifacts,
    }),
    createAppendOnlyDecision({
      recordId: prepareRecordId,
      decisionType: "evidence_final_selection",
      outcome: "not_available",
      reason: "Fixture seed text prevents final selection.",
      recordedAt: "2026-07-16T12:00:00.000Z",
      actor: {
        kind: "deterministic",
        identifier: "evidence-selection-v1",
      },
      evidenceArtifacts: evidenceInputArtifacts,
    }),
  ];
  const evidence = createStageArtifact({
    ...baseEnvelope(),
    stage: "evidence",
    inputArtifacts: evidenceInputArtifacts,
    decisions: evidenceDecisions,
    payload: {
      lineage: {
        runId: "run-contract-test",
        prepareArtifact: evidencePrepareReference,
        scopeArtifact: evidenceScopeReference,
      },
      rerankingPolicy: { enabled: false },
      preparedRecords: [
        {
          recordId: prepareRecordId,
          familyId: family.familyId,
          citationOccurrenceId: citationOccurrence.mentionId,
          seedId,
        },
      ],
      queries: [
        {
          queryId: evidenceQueryId,
          familyId: family.familyId,
          text: evidenceQueryText,
          contentHash: canonicalSha256(evidenceQueryText),
          source: "scope-family-claim",
          groundingStatus: "seed_text_unavailable",
          verificationStatus: "unverified_attributed_claim",
        },
      ],
      corpora: [],
      bm25Runs: [],
      rerankRuns: [],
      selections: [],
      records: [
        {
          recordId: prepareRecordId,
          familyId: family.familyId,
          citationOccurrenceId: citationOccurrence.mentionId,
          seedId,
          queryId: evidenceQueryId,
          retrievalStatus: "seed_text_unavailable",
          rerankStatus: "disabled",
        },
      ],
    },
  });
  const adjudicate = createStageArtifact({
    ...baseEnvelope(),
    stage: "adjudicate",
    inputArtifacts: [
      lineageReference(evidence, "evidence-input", "evidence"),
      lineageReference(prepare, "prepare-input", "prepare"),
    ],
    payload: {
      lineage: {
        runId: "run-contract-test",
        evidenceArtifact: lineageReference(
          evidence,
          "evidence-input",
          "evidence",
        ),
        prepareArtifact: lineageReference(prepare, "prepare-input", "prepare"),
      },
      method: {
        methodId: "categorical-adjudicate-v2",
        strategy: "single_categorical",
        calibrationStatus: "uncalibrated",
      },
      records: [],
    },
  });
  const zeroFamilyOccurrence = (metricId: string, population: string) =>
    buildReportCount({
      metricId,
      count: 0,
      unit: "family_occurrence_records",
      population,
    });
  const zeroCandidates = (metricId: string, population: string) =>
    buildReportCount({
      metricId,
      count: 0,
      unit: "candidates",
      population,
    });
  const reportDiscover = {
    artifactId: discover.artifactId,
    contentHash: discover.contentHash,
    role: "discover-input" as const,
    stage: "discover" as const,
  };
  const reportScope = {
    artifactId: scope.artifactId,
    contentHash: scope.contentHash,
    role: "scope-input" as const,
    stage: "scope" as const,
  };
  const reportPrepare = {
    artifactId: prepare.artifactId,
    contentHash: prepare.contentHash,
    role: "prepare-input" as const,
    stage: "prepare" as const,
  };
  const reportEvidence = {
    artifactId: evidence.artifactId,
    contentHash: evidence.contentHash,
    role: "evidence-input" as const,
    stage: "evidence" as const,
  };
  const reportAdjudicate = {
    artifactId: adjudicate.artifactId,
    contentHash: adjudicate.contentHash,
    role: "adjudicate-input" as const,
    stage: "adjudicate" as const,
  };
  const reportInputs = [
    reportDiscover,
    reportScope,
    reportPrepare,
    reportEvidence,
    reportAdjudicate,
  ];
  const reportRecordId = buildReportDecisionRecordId("run-contract-test");
  const reportDecisions = [
    createAppendOnlyDecision({
      recordId: reportRecordId,
      decisionType: "report_interpretation_status",
      outcome: "uncalibrated_research_output",
      reason: REPORT_INTERPRETATION_WARNING,
      recordedAt: "2026-07-16T12:00:00.000Z",
      actor: {
        kind: "deterministic",
        identifier: reportMethodId,
      },
      evidenceArtifacts: reportInputs,
    }),
    createAppendOnlyDecision({
      recordId: reportRecordId,
      decisionType: "report_publication_status",
      outcome: "research_artifact_only",
      reason: REPORT_PUBLICATION_REASON,
      recordedAt: "2026-07-16T12:00:00.000Z",
      actor: {
        kind: "deterministic",
        identifier: reportMethodId,
      },
      evidenceArtifacts: reportInputs,
    }),
  ];
  const report = createStageArtifact({
    ...baseEnvelope(),
    stage: "report",
    inputArtifacts: reportInputs,
    decisions: reportDecisions,
    payload: {
      lineage: {
        runId: "run-contract-test",
        discoverArtifact: reportDiscover,
        scopeArtifact: reportScope,
        prepareArtifact: reportPrepare,
        evidenceArtifact: reportEvidence,
        adjudicateArtifact: reportAdjudicate,
      },
      method: {
        methodId: "audit-report-v1",
        strategy: "deterministic_funnel",
        calibrationStatus: "uncalibrated",
        outputs: "json_and_markdown",
      },
      interpretationStatus: "uncalibrated_research_output",
      interpretationWarning: REPORT_INTERPRETATION_WARNING,
      deterministic: true,
      replayableFromInputs: true,
      funnel: {
        discover: {
          probeStratumCounts: [],
          neighborhoodCoverage: [],
          materializationChannelCounts: [],
          materializationLossReasonCounts: [],
          harvestLossReasonCounts: [],
          bibliographyMatchMethodCounts: [],
          providerReportedNeighborhoodTotal: buildReportCount({
            metricId: "discover.provider_reported_neighborhood_total",
            count: 0,
            unit: "citing_paper_observations",
            population: "Provider-reported citing works for the seed",
          }),
          seeds: buildReportCount({
            metricId: "discover.seeds",
            count: 0,
            unit: "seeds",
            population: "Discover seed papers",
          }),
          returnedCitingPaperObservations: buildReportCount({
            metricId: "discover.returned_citing_paper_observations",
            count: 0,
            unit: "citing_paper_observations",
            population: "Returned citing-paper observations",
          }),
          probed: buildReportCount({
            metricId: "discover.probed",
            count: 0,
            unit: "citing_paper_observations",
            population: "Probed citing papers",
          }),
          notProbed: buildReportCount({
            metricId: "discover.not_probed",
            count: 0,
            unit: "citing_paper_observations",
            population: "Not-probed citing papers",
          }),
          materializationSucceeded: buildReportCount({
            metricId: "discover.materialization_succeeded",
            count: 0,
            unit: "citing_paper_observations",
            population: "Succeeded materializations",
          }),
          materializationFailed: buildReportCount({
            metricId: "discover.materialization_failed",
            count: 0,
            unit: "citing_paper_observations",
            population: "Failed materializations",
          }),
          materializationUnavailable: buildReportCount({
            metricId: "discover.materialization_unavailable",
            count: 0,
            unit: "citing_paper_observations",
            population: "Unavailable materializations",
          }),
          materializationNotAttempted: buildReportCount({
            metricId: "discover.materialization_not_attempted",
            count: 0,
            unit: "citing_paper_observations",
            population: "Not-attempted materializations",
          }),
          harvestSucceeded: buildReportCount({
            metricId: "discover.harvest_succeeded",
            count: 0,
            unit: "citing_paper_observations",
            population: "Successful harvests",
          }),
          harvestNoMentions: buildReportCount({
            metricId: "discover.harvest_no_mentions",
            count: 0,
            unit: "citing_paper_observations",
            population: "No-mention harvests",
          }),
          harvestFailed: buildReportCount({
            metricId: "discover.harvest_failed",
            count: 0,
            unit: "citing_paper_observations",
            population: "Failed harvests",
          }),
          harvestNotAttempted: buildReportCount({
            metricId: "discover.harvest_not_attempted",
            count: 0,
            unit: "citing_paper_observations",
            population: "Not-attempted harvests",
          }),
          citationOccurrences: buildReportCount({
            metricId: "discover.citation_occurrences",
            count: 0,
            unit: "citation_occurrences",
            population: "Citation occurrences",
          }),
          extractionClaimsExtracted: buildReportCount({
            metricId: "discover.extraction_claims_extracted",
            count: 0,
            unit: "citation_occurrences",
            population: "Extractions claims",
          }),
          extractionNoClaims: buildReportCount({
            metricId: "discover.extraction_no_claims",
            count: 0,
            unit: "citation_occurrences",
            population: "No-claim extractions",
          }),
          extractionFailed: buildReportCount({
            metricId: "discover.extraction_failed",
            count: 0,
            unit: "citation_occurrences",
            population: "Failed extractions",
          }),
          attributedClaimRecords: buildReportCount({
            metricId: "discover.attributed_claim_records",
            count: 0,
            unit: "attributed_claim_records",
            population: "Attributed claim records",
          }),
          candidateClaims: zeroCandidates(
            "discover.candidate_claims",
            "Candidate claims",
          ),
          selectedCandidates: zeroCandidates(
            "discover.selected_candidates",
            "Selected candidates",
          ),
          deferredCandidates: zeroCandidates(
            "discover.deferred_candidates",
            "Deferred candidates",
          ),
          uniqueCitingPapersWithOccurrences: buildReportCount({
            metricId: "discover.unique_citing_papers_with_occurrences",
            count: 0,
            unit: "citing_papers",
            population: "Unique citing papers with occurrences",
          }),
          uniqueCitationGroups: buildReportCount({
            metricId: "discover.unique_citation_groups",
            count: 0,
            unit: "citation_groups",
            population: "Unique citation groups",
          }),
          deferredByFamilyCap: zeroCandidates(
            "discover.deferred_by_family_cap",
            "Deferred by family cap",
          ),
          deferredByRecordBudget: zeroCandidates(
            "discover.deferred_by_record_budget",
            "Deferred by record budget",
          ),
          deferredByNovelty: zeroCandidates(
            "discover.deferred_by_novelty",
            "Deferred by novelty",
          ),
          attributedClaimsWithVerifiedSupportSpan: buildReportCount({
            metricId: "discover.attributed_claims_with_verified_support_span",
            count: 0,
            unit: "attributed_claim_records",
            population: "Claims with verified support spans",
          }),
          attributedClaimsMissingSupportSpan: buildReportCount({
            metricId: "discover.attributed_claims_missing_support_span",
            count: 0,
            unit: "attributed_claim_records",
            population: "Claims missing verified support spans",
          }),
        },
        scope: {
          scopedCandidates: zeroCandidates(
            "scope.scoped_candidates",
            "Scoped candidates",
          ),
          deferredCandidates: zeroCandidates(
            "scope.deferred_candidates",
            "Deferred candidates",
          ),
          families: buildReportCount({
            metricId: "scope.families",
            count: 0,
            unit: "families",
            population: "Scoped families",
          }),
          groundingStatusCounts: [],
        },
        prepare: {
          expectedFamilyOccurrencePairs: zeroFamilyOccurrence(
            "prepare.expected_family_occurrence_pairs",
            "Expected pairs",
          ),
          preparedRecords: zeroFamilyOccurrence(
            "prepare.prepared_records",
            "Prepared records",
          ),
          classified: zeroFamilyOccurrence(
            "prepare.classified",
            "Classified records",
          ),
          ambiguous: zeroFamilyOccurrence(
            "prepare.ambiguous",
            "Ambiguous records",
          ),
          failed: zeroFamilyOccurrence("prepare.failed", "Failed records"),
          lowInformation: zeroFamilyOccurrence(
            "prepare.low_information",
            "Low-information records",
          ),
          manualReview: zeroFamilyOccurrence(
            "prepare.manual_review",
            "Manual-review records",
          ),
          manualReviewRoleAmbiguous: zeroFamilyOccurrence(
            "prepare.manual_review_role_ambiguous",
            "Role-ambiguous manual-review records",
          ),
          manualReviewExtractionLimited: zeroFamilyOccurrence(
            "prepare.manual_review_extraction_limited",
            "Extraction-limited manual-review records",
          ),
        },
        evidence: {
          recordOutcomes: zeroFamilyOccurrence(
            "evidence.record_outcomes",
            "Evidence outcomes",
          ),
          retrievalStatusCounts: [],
          bm25MatchedRuns: buildReportCount({
            metricId: "evidence.bm25_matched_runs",
            count: 0,
            unit: "bm25_runs",
            population: "Matched BM25 runs",
          }),
          bm25NoMatchRuns: buildReportCount({
            metricId: "evidence.bm25_no_match_runs",
            count: 0,
            unit: "bm25_runs",
            population: "No-match BM25 runs",
          }),
          rerankDisabled: zeroFamilyOccurrence(
            "evidence.rerank_disabled",
            "Rerank disabled",
          ),
          rerankSkippedPinnedSelection: zeroFamilyOccurrence(
            "evidence.rerank_skipped_pinned_selection",
            "Rerank skipped because pins fill the selection",
          ),
          rerankCompleted: zeroFamilyOccurrence(
            "evidence.rerank_completed",
            "Rerank completed",
          ),
          rerankFailed: zeroFamilyOccurrence(
            "evidence.rerank_failed",
            "Rerank failed",
          ),
          rerankNotAttempted: zeroFamilyOccurrence(
            "evidence.rerank_not_attempted",
            "Rerank not attempted",
          ),
          uniqueFinalSelectionsBm25: buildReportCount({
            metricId: "evidence.unique_final_selections_bm25",
            count: 0,
            unit: "selections",
            population: "Unique BM25 final selections",
          }),
          uniqueFinalSelectionsReranked: buildReportCount({
            metricId: "evidence.unique_final_selections_reranked",
            count: 0,
            unit: "selections",
            population: "Unique reranked final selections",
          }),
          recordSelectionBm25: zeroFamilyOccurrence(
            "evidence.record_selection_bm25",
            "Records using BM25 selections",
          ),
          recordSelectionReranked: zeroFamilyOccurrence(
            "evidence.record_selection_reranked",
            "Records using reranked selections",
          ),
        },
        adjudicate: {
          totalRecordOutcomes: zeroFamilyOccurrence(
            "adjudicate.total_record_outcomes",
            "Total adjudicate outcomes",
          ),
          adjudicated: zeroFamilyOccurrence(
            "adjudicate.adjudicated",
            "Adjudicated records",
          ),
          notAdjudicated: zeroFamilyOccurrence(
            "adjudicate.not_adjudicated",
            "Not adjudicated",
          ),
          adjudicationFailed: zeroFamilyOccurrence(
            "adjudicate.adjudication_failed",
            "Adjudication failed",
          ),
          invalidOutput: zeroFamilyOccurrence(
            "adjudicate.invalid_output",
            "Invalid output",
          ),
          gateCodeCounts: [],
          failureCodeCounts: [],
          mutationKindCounts: [],
          mutationDirectionCounts: [],
          verdictCountsByRankingSource: [],
          verdictCounts: {
            F: zeroFamilyOccurrence("adjudicate.verdict_F", "Verdict F"),
            D: zeroFamilyOccurrence("adjudicate.verdict_D", "Verdict D"),
            E: zeroFamilyOccurrence("adjudicate.verdict_E", "Verdict E"),
            U: zeroFamilyOccurrence("adjudicate.verdict_U", "Verdict U"),
          },
          uniqueClaimUnits: buildReportCount({
            metricId: "adjudicate.unique_claim_units",
            count: 0,
            unit: "unique_claim_units",
            population: "Unique claim units",
          }),
          uniqueClaimUnitVerdictCounts: {
            F: buildReportCount({
              metricId: "adjudicate.unique_claim_units_verdict_F",
              count: 0,
              unit: "unique_claim_units",
              population: "Unique units F",
            }),
            D: buildReportCount({
              metricId: "adjudicate.unique_claim_units_verdict_D",
              count: 0,
              unit: "unique_claim_units",
              population: "Unique units D",
            }),
            E: buildReportCount({
              metricId: "adjudicate.unique_claim_units_verdict_E",
              count: 0,
              unit: "unique_claim_units",
              population: "Unique units E",
            }),
            U: buildReportCount({
              metricId: "adjudicate.unique_claim_units_verdict_U",
              count: 0,
              unit: "unique_claim_units",
              population: "Unique units U",
            }),
          },
          uniqueAdjudicatedClaimUnits: buildReportCount({
            metricId: "adjudicate.unique_adjudicated_claim_units",
            count: 0,
            unit: "unique_claim_units",
            population: "Unique adjudicated claim units",
          }),
          repeatedRecordsBeyondUniqueUnits: zeroFamilyOccurrence(
            "adjudicate.repeated_records_beyond_unique_units",
            "Repeated records beyond unique units",
          ),
          packetsWithVerifiedSupportSpans: buildReportCount({
            metricId: "adjudicate.packets_with_verified_support_spans",
            count: 0,
            unit: "adjudication_packets",
            population: "Packets with verified support spans",
          }),
          packetsMissingSupportSpans: buildReportCount({
            metricId: "adjudicate.packets_missing_support_spans",
            count: 0,
            unit: "adjudication_packets",
            population: "Packets missing support spans",
          }),
          evidenceSufficient: zeroFamilyOccurrence(
            "adjudicate.evidence_sufficient",
            "Evidence sufficient",
          ),
          evidenceLimited: zeroFamilyOccurrence(
            "adjudicate.evidence_limited",
            "Evidence limited",
          ),
          figureOnlyLimitation: zeroFamilyOccurrence(
            "adjudicate.figure_only_limitation",
            "Figure-only limitation",
          ),
        },
      },
      rates: [
        buildReportRate({
          metricId: "adjudication_coverage",
          numerator: 0,
          denominator: 0,
          unit: "adjudicated_records / family_occurrence_records",
          populationLabel: "Adjudication coverage",
          numeratorDefinition: "Adjudicated records",
          denominatorDefinition: "All records",
        }),
        buildReportRate({
          metricId: "retrieval_coverage",
          numerator: 0,
          denominator: 0,
          unit: "retrieved_records / family_occurrence_records",
          populationLabel: "Retrieval coverage",
          numeratorDefinition: "Retrieved records",
          denominatorDefinition: "Prepare records",
        }),
        buildReportRate({
          metricId: "scope_selection_rate",
          numerator: 0,
          denominator: 0,
          unit: "selected_candidates / candidates",
          populationLabel: "Scope selection rate",
          numeratorDefinition: "Selected candidates",
          denominatorDefinition: "All Discover candidates",
        }),
        buildReportRate({
          metricId: "verdict_D_rate",
          numerator: 0,
          denominator: 0,
          unit: "D_verdicts / adjudicated_records",
          populationLabel: "D rate",
          numeratorDefinition: "D verdicts",
          denominatorDefinition: "Adjudicated records only",
        }),
        buildReportRate({
          metricId: "verdict_E_rate",
          numerator: 0,
          denominator: 0,
          unit: "E_verdicts / adjudicated_records",
          populationLabel: "E rate",
          numeratorDefinition: "E verdicts",
          denominatorDefinition: "Adjudicated records only",
        }),
        buildReportRate({
          metricId: "verdict_F_rate",
          numerator: 0,
          denominator: 0,
          unit: "F_verdicts / adjudicated_records",
          populationLabel: "F rate",
          numeratorDefinition: "F verdicts",
          denominatorDefinition: "Adjudicated records only",
        }),
        buildReportRate({
          metricId: "verdict_U_rate",
          numerator: 0,
          denominator: 0,
          unit: "U_verdicts / adjudicated_records",
          populationLabel: "U rate",
          numeratorDefinition: "U verdicts",
          denominatorDefinition: "Adjudicated records only",
        }),
        buildReportRate({
          metricId: "verdict_F_unique_rate",
          numerator: 0,
          denominator: 0,
          unit: "U_verdicts / adjudicated_records",
          populationLabel: "U rate",
          numeratorDefinition: "U verdicts",
          denominatorDefinition: "Adjudicated records only",
        }),
        buildReportRate({
          metricId: "verdict_D_unique_rate",
          numerator: 0,
          denominator: 0,
          unit: "U_verdicts / adjudicated_records",
          populationLabel: "U rate",
          numeratorDefinition: "U verdicts",
          denominatorDefinition: "Adjudicated records only",
        }),
        buildReportRate({
          metricId: "verdict_E_unique_rate",
          numerator: 0,
          denominator: 0,
          unit: "U_verdicts / adjudicated_records",
          populationLabel: "U rate",
          numeratorDefinition: "U verdicts",
          denominatorDefinition: "Adjudicated records only",
        }),
        buildReportRate({
          metricId: "verdict_U_unique_rate",
          numerator: 0,
          denominator: 0,
          unit: "U_verdicts / adjudicated_records",
          populationLabel: "U rate",
          numeratorDefinition: "U verdicts",
          denominatorDefinition: "Adjudicated records only",
        }),
      ].sort((left, right) =>
        left.metricId < right.metricId
          ? -1
          : left.metricId > right.metricId
            ? 1
            : 0,
      ),
      weightedRates: (["D", "E", "F", "U"] as const).map((verdict) =>
        buildReportWeightedRate({
          metricId: `verdict_${verdict}_weighted_rate`,
          weightedNumerator: 0,
          weightedDenominator: 0,
          sampleNumerator: 0,
          sampleDenominator: 0,
          unit: "weighted verdicts / weighted adjudicated records",
          populationLabel: "Weighted verdict share",
          numeratorDefinition: "Weighted verdict records",
          denominatorDefinition: "Weighted adjudicated records",
        }),
      ),
      familyMutations: [],
      recordTraces: [],
      decisionSummaries: [],
      selectionAudit: [],
      seedCodebooks: [],
    },
  });
  return { discover, scope, prepare, evidence, adjudicate, report };
}

describe("stage artifact contracts", () => {
  it("re-exports the single artifact primitive definitions", () => {
    expect(artifactReferenceSchema).toBe(primitiveArtifactReferenceSchema);
    expect(artifactIdSchema).toBe(primitiveArtifactIdSchema);
    expect(sha256DigestSchema).toBe(primitiveSha256DigestSchema);
    expect(stableIdentifierSchema).toBe(primitiveStableIdentifierSchema);
  });

  it("validates a versioned envelope for every stage", () => {
    const artifacts = buildAllStageArtifacts();

    expect(discoverArtifactSchema.safeParse(artifacts.discover).success).toBe(
      true,
    );
    expect(scopeArtifactSchema.safeParse(artifacts.scope).success).toBe(true);
    expect(prepareArtifactSchema.safeParse(artifacts.prepare).success).toBe(
      true,
    );
    expect(evidenceArtifactSchema.safeParse(artifacts.evidence).success).toBe(
      true,
    );
    expect(
      adjudicateArtifactSchema.safeParse(artifacts.adjudicate).success,
    ).toBe(true);
    expect(reportArtifactSchema.safeParse(artifacts.report).success).toBe(true);

    for (const artifact of Object.values(artifacts)) {
      expect(stageArtifactSchema.safeParse(artifact).success).toBe(true);
      expect(artifact.schemaVersion).toBe(1);
      expect(artifact.artifactVersion).toBe(1);
      expect(artifact.artifactId).toMatch(/^artifact_[a-f0-9]{64}$/);
      expect(artifact.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("requires dispositions without deleting the complete candidate ledger", () => {
    const discover = buildAllStageArtifacts().discover;
    if (discover.stage !== "discover") {
      throw new Error("Expected discover artifact");
    }
    expect(
      discoverArtifactPayloadSchema.safeParse({
        ...discover.payload,
        candidateDispositions: [],
      }).success,
    ).toBe(false);
    expect(discover.payload.claimCandidates).toHaveLength(1);
    expect(discover.payload.citationMentions).toHaveLength(1);
    expect(discover.payload.attributedClaimRecords).toHaveLength(1);
  });

  it("excludes creation time from stable artifact identity", () => {
    const first = buildAllStageArtifacts().discover;
    if (first.stage !== "discover") {
      throw new Error("Expected discover artifact");
    }
    const second = createStageArtifact({
      ...baseEnvelope("2026-07-17T12:00:00.000Z"),
      stage: "discover",
      inputArtifacts: first.inputArtifacts,
      payload: first.payload,
    });

    expect(second.contentHash).toBe(first.contentHash);
    expect(second.artifactId).toBe(first.artifactId);
  });

  it("rejects content or identity tampering", () => {
    const artifact = buildAllStageArtifacts().discover;
    if (artifact.stage !== "discover") {
      throw new Error("Expected discover artifact");
    }
    const tampered = {
      ...artifact,
      payload: {
        ...artifact.payload,
        claimCandidates: artifact.payload.claimCandidates.map((candidate) => ({
          ...candidate,
          claim: "A meaningfully different claim.",
        })),
      },
    };

    const parsed = parseStageArtifact(tampered);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/candidateId|contentHash|artifactId/);
    }
  });

  it("rejects a report whose input lineage was swapped, dropped, or corrupted", () => {
    const report = buildAllStageArtifacts().report;
    if (report.stage !== "report") {
      throw new Error("Expected report artifact");
    }
    const [first, second, ...rest] = report.inputArtifacts;
    if (!first || !second) throw new Error("Report needs at least two inputs");
    const variants: Array<[string, ArtifactReference[]]> = [
      ["swapped", [second, first, ...rest]],
      ["dropped", [second, ...rest]],
      [
        "corrupted",
        [
          { ...first, contentHash: canonicalSha256({ tampered: true }) },
          second,
          ...rest,
        ],
      ],
    ];

    for (const [label, inputArtifacts] of variants) {
      // Re-derive identity so only the lineage check can reject it.
      const tampered = {
        ...report,
        inputArtifacts,
        artifactId: computeArtifactId({ ...report, inputArtifacts }),
      };
      const parsed = parseStageArtifact(tampered);
      expect(parsed.ok, label).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error, label).toMatch(/exact inputs in stage order/);
      }
    }
  });

  it("rejects a funnel count relabelled with another unit", () => {
    const report = buildAllStageArtifacts().report;
    if (report.stage !== "report") {
      throw new Error("Expected report artifact");
    }
    const funnel = report.payload.funnel;
    const tampered = {
      ...report,
      payload: {
        ...report.payload,
        funnel: {
          ...funnel,
          discover: {
            ...funnel.discover,
            seeds: { ...funnel.discover.seeds, unit: "candidates" },
          },
        },
      },
    };
    const parsed = parseStageArtifact(tampered);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/unit/);
    }
  });

  it("summarizes Adjudicate from its record statuses and verdicts", () => {
    const adjudicate = buildAllStageArtifacts().adjudicate;
    if (adjudicate.stage !== "adjudicate") {
      throw new Error("Expected adjudicate artifact");
    }
    const records = adjudicate.payload.records;
    const expected = (label: string, value: number) => ({
      label,
      value: String(value),
    });

    const summary = deriveStageSummary("adjudicate", adjudicate);

    expect(summary.metrics).toEqual(
      expect.arrayContaining([
        expected("Records", records.length),
        expected(
          "Adjudicated",
          records.filter((record) => record.status === "adjudicated").length,
        ),
        expected(
          "F",
          records.filter(
            (record) =>
              record.status === "adjudicated" && record.verdict === "F",
          ).length,
        ),
        expected(
          "Not adjudicated",
          records.filter((record) => record.status === "not_adjudicated")
            .length,
        ),
      ]),
    );
  });

  it("rejects model provenance when Adjudicate has no modeled outcomes", () => {
    const requestArtifact: ArtifactReference = {
      artifactId: buildStableId("request", {
        provider: "anthropic",
        request: "request-1",
      }),
      contentHash: canonicalSha256({ prompt: "prompt text" }),
      role: "model-request",
    };
    const responseArtifact: ArtifactReference = {
      artifactId: buildStableId("response", {
        provider: "anthropic",
        request: "request-1",
      }),
      contentHash: canonicalSha256({ response: "raw immutable response" }),
      role: "model-response",
    };
    const artifacts = buildAllStageArtifacts();
    expect(() =>
      createStageArtifact({
        ...baseEnvelope(),
        stage: "adjudicate",
        inputArtifacts: [
          lineageReference(artifacts.evidence, "evidence-input", "evidence"),
          lineageReference(artifacts.prepare, "prepare-input", "prepare"),
        ],
        provenance: {
          ...provenance,
          prompts: [
            {
              promptId: "adjudication",
              version: "v1",
              contentHash: canonicalSha256("prompt text"),
            },
          ],
          models: [
            {
              provider: "anthropic",
              model: "test-model",
              requestHash: canonicalSha256({ prompt: "prompt text" }),
              requestArtifact,
              responseArtifact,
            },
          ],
        },
        execution: {
          kind: "model",
          implementation: "adjudicator-v1",
          replayableFromInputs: false,
          responseArtifacts: [responseArtifact],
        },
        payload: {
          lineage: {
            runId: "run-contract-test",
            evidenceArtifact: lineageReference(
              artifacts.evidence,
              "evidence-input",
              "evidence",
            ),
            prepareArtifact: lineageReference(
              artifacts.prepare,
              "prepare-input",
              "prepare",
            ),
          },
          method: {
            methodId: "categorical-adjudicate-v2",
            strategy: "single_categorical",
            calibrationStatus: "uncalibrated",
          },
          records: [],
        },
      }),
    ).toThrow(/Fully gated Adjudicate/);
  });
});

describe("scientific identities", () => {
  it("stabilizes seed, occurrence, candidate, and scoped-family identities", () => {
    const seedId = buildSeedId({ doi: "https://doi.org/10.1234/SEED" });
    expect(seedId).toBe(buildSeedId({ doi: "10.1234/seed" }));

    const occurrence = {
      seedId,
      citingPaperId: "citing-paper",
      citedPaperId: "seed-paper",
      mentionIndex: 0,
      refId: "ref-7",
      charOffsetStart: 100,
      charOffsetEnd: 149,
      citationMarker: "[7]",
      rawContext: "Prior work [7] reported the measured effect.",
    };
    const firstMentionId = buildCitationOccurrenceId(occurrence);
    const secondMentionId = buildCitationOccurrenceId({
      ...occurrence,
      charOffsetStart: 200,
      charOffsetEnd: 249,
    });
    expect(secondMentionId).not.toBe(firstMentionId);

    // Distinct citation groups in the same paragraph must not collapse.
    const sameParagraphGroupA = buildCitationOccurrenceId({
      ...occurrence,
      mentionIndex: 0,
      sourceLocator: {
        kind: "block_id",
        value: "body_paragraph-1#cg-0",
      },
    });
    const sameParagraphGroupB = buildCitationOccurrenceId({
      ...occurrence,
      mentionIndex: 1,
      charOffsetStart: 160,
      charOffsetEnd: 190,
      sourceLocator: {
        kind: "block_id",
        value: "body_paragraph-1#cg-1",
      },
    });
    expect(sameParagraphGroupA).not.toBe(sameParagraphGroupB);

    // Locators dominate offsets; mentionIndex remains a final tie-break.
    const withLocator = buildCitationOccurrenceId({
      ...occurrence,
      sourceLocator: {
        kind: "block_id",
        value: "body_paragraph-1#cg-0",
      },
    });
    expect(withLocator).not.toBe(firstMentionId);
    const sameLocatorDifferentIndex = buildCitationOccurrenceId({
      ...occurrence,
      mentionIndex: 1,
      sourceLocator: {
        kind: "block_id",
        value: "body_paragraph-1#cg-0",
      },
    });
    expect(sameLocatorDifferentIndex).not.toBe(withLocator);

    const claimRecordId = buildAttributedClaimRecordId({
      seedId,
      mentionId: firstMentionId,
      duplicateOrdinal: 0,
      extractedClaimText: "The measured effect changed.",
    });
    expect(claimRecordId).toBe(
      buildAttributedClaimRecordId({
        seedId,
        mentionId: firstMentionId,
        duplicateOrdinal: 0,
        extractedClaimText: " The measured effect changed. ",
      }),
    );
    expect(claimRecordId).not.toBe(
      buildAttributedClaimRecordId({
        seedId,
        mentionId: secondMentionId,
        duplicateOrdinal: 0,
        extractedClaimText: "The measured effect changed.",
      }),
    );
    expect(claimRecordId).not.toBe(
      buildAttributedClaimRecordId({
        seedId,
        mentionId: firstMentionId,
        duplicateOrdinal: 0,
        extractedClaimText: "A different attributed claim.",
      }),
    );

    const candidateId = buildClaimCandidateId({
      seedId,
      normalizedClaim: "The measured effect changed.",
      sourceClaimRecordIds: [secondMentionId, firstMentionId],
    });
    expect(candidateId).toBe(
      buildClaimCandidateId({
        seedId,
        normalizedClaim: "  The measured effect changed. ",
        sourceClaimRecordIds: [firstMentionId, secondMentionId],
      }),
    );
    expect(candidateId).not.toBe(
      buildClaimCandidateId({
        seedId,
        normalizedClaim: "A different measured effect changed.",
        sourceClaimRecordIds: [firstMentionId, secondMentionId],
      }),
    );

    const anotherCandidateId = buildStableId("candidate", {
      identityKind: "fixture",
    });
    const familyId = buildScopedFamilyId({
      seedId,
      normalizedClaim: "The measured effect changed.",
    });
    expect(familyId).toBe(
      buildScopedFamilyId({
        seedId,
        normalizedClaim: " The measured effect changed. ",
      }),
    );
    const family = {
      familyId,
      seedId,
      candidateIds: [candidateId],
      sourceClaimRecordIds: [claimRecordId],
      claim: "The measured effect changed.",
      normalizedClaim: "The measured effect changed.",
      grounding: {
        status: "seed_text_unavailable" as const,
        evidenceSpans: [],
        detailReason: "Unavailable for identity testing.",
        quoteVerification: {
          status: "not_applicable" as const,
          failures: [],
        },
      },
      includedCitationOccurrenceIds: [firstMentionId],
      provenanceArtifacts: [
        {
          artifactId: buildStableId("input", { family: true }),
          contentHash: canonicalSha256({ family: true }),
          role: "identity-test",
        },
      ],
    };
    expect(scopedFamilySchema.safeParse(family).success).toBe(true);
    expect(
      scopedFamilySchema.safeParse({
        ...family,
        candidateIds: [anotherCandidateId],
      }).success,
    ).toBe(true);
    expect(familyId).not.toBe(
      buildScopedFamilyId({
        seedId,
        normalizedClaim: "A different family claim.",
      }),
    );
  });
});

describe("citation-instance and decision provenance", () => {
  const familyId = buildStableId("family", { claim: "measured effect" });
  const citationOccurrenceId = buildStableId("mention", { offset: 100 });
  const recordId = buildCitationInstanceRecordId({
    familyId,
    citationOccurrenceId,
  });

  it("uses exactly family and occurrence for prepared-record identity", () => {
    expect(
      buildCitationInstanceRecordId({ familyId, citationOccurrenceId }),
    ).toBe(recordId);
    expect(
      buildCitationInstanceRecordId({
        familyId: buildStableId("family", { claim: "different" }),
        citationOccurrenceId,
      }),
    ).not.toBe(recordId);
    expect(
      buildCitationInstanceRecordId({
        familyId,
        citationOccurrenceId: buildStableId("mention", { offset: 200 }),
      }),
    ).not.toBe(recordId);
  });

  it("uses append-only, reasoned decisions with stable IDs", () => {
    const firstDecision = createAppendOnlyDecision({
      recordId,
      decisionType: "scope",
      outcome: "include",
      reason: "The citation instance directly addresses the family claim.",
      recordedAt: "2026-07-16T12:01:00.000Z",
      actor: {
        kind: "deterministic",
        identifier: "scope-policy-v1",
      },
      evidenceArtifacts: [],
    });
    const revisedDecision = createAppendOnlyDecision({
      recordId,
      decisionType: "scope",
      outcome: "manual_review",
      reason: "A later check found an ambiguous bundled attribution.",
      recordedAt: "2026-07-16T12:02:00.000Z",
      actor: {
        kind: "human",
        identifier: "reviewer-1",
      },
      evidenceArtifacts: [],
      supersedesDecisionId: firstDecision.decisionId,
    });
    expect(appendOnlyDecisionSchema.safeParse(firstDecision).success).toBe(
      true,
    );
    expect(appendOnlyDecisionSchema.safeParse(revisedDecision).success).toBe(
      true,
    );
    expect(revisedDecision.decisionId).not.toBe(firstDecision.decisionId);
    const retimedDecision = createAppendOnlyDecision({
      recordId,
      decisionType: "scope",
      outcome: "include",
      reason: "The citation instance directly addresses the family claim.",
      recordedAt: "2026-07-17T12:01:00.000Z",
      actor: {
        kind: "deterministic",
        identifier: "scope-policy-v1",
      },
      evidenceArtifacts: [],
    });
    expect(retimedDecision.decisionId).toBe(firstDecision.decisionId);
  });
});
