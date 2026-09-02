import { describe, expect, it } from "vitest";

import {
  adjudicateArtifactSchema,
  artifactReferenceSchema,
  appendOnlyDecisionSchema,
  appendOnlyExclusionSchema,
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
  createAppendOnlyExclusion,
  buildReportCount,
  buildReportRate,
  createLeanStageArtifact,
  discoverArtifactPayloadSchema,
  discoverArtifactSchema,
  evidenceArtifactSchema,
  leanArtifactIdSchema,
  leanArtifactSchemaVersion,
  leanArtifactVersion,
  leanStageArtifactSchema,
  parseLeanStageArtifact,
  prepareArtifactSchema,
  canonicalReportMethodId,
  REPORT_INTERPRETATION_WARNING,
  REPORT_PUBLICATION_REASON,
  reportArtifactSchema,
  sha256DigestSchema,
  scopedFamilySchema,
  scopeArtifactSchema,
  stableIdentifierSchema,
  type AppendOnlyDecision,
  type AppendOnlyExclusion,
  type ArtifactReference,
  type LeanArtifactProvenance,
  type LeanExecutionMetadata,
  type LeanStageArtifact,
} from "../../src/contract/lean-artifacts.js";
import {
  artifactReferenceSchema as primitiveArtifactReferenceSchema,
  leanArtifactIdSchema as primitiveLeanArtifactIdSchema,
  sha256DigestSchema as primitiveSha256DigestSchema,
  stableIdentifierSchema as primitiveStableIdentifierSchema,
} from "../../src/contract/lean-artifact-primitives.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";

const deterministicExecution: LeanExecutionMetadata = {
  kind: "deterministic",
  implementation: "test-fixture-v1",
  replayableFromInputs: true,
};

const provenance: LeanArtifactProvenance = {
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
    schemaVersion: leanArtifactSchemaVersion,
    artifactVersion: leanArtifactVersion,
    runId: "run-contract-test",
    createdAt,
    inputArtifacts: [] as ArtifactReference[],
    provenance,
    execution: deterministicExecution,
    decisions: [] as AppendOnlyDecision[],
    exclusions: [] as AppendOnlyExclusion[],
  };
}

function asReference(
  artifact: LeanStageArtifact,
  role: string,
): ArtifactReference {
  return {
    artifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    role,
    canonicalStage: artifact.canonicalStage,
  };
}

function lineageReference<
  Role extends "canonical-evidence-input" | "canonical-prepare-input",
  Stage extends "evidence" | "prepare",
>(
  artifact: LeanStageArtifact,
  role: Role,
  canonicalStage: Stage,
): {
  artifactId: string;
  contentHash: string;
  role: Role;
  canonicalStage: Stage;
} {
  return {
    artifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    role,
    canonicalStage,
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
  const canonicalClaim = "The intervention changed the measured outcome.";
  const candidateIdentity = {
    seedId,
    normalizedClaim: "the intervention changed the measured outcome.",
    sourceClaimRecordIds: [sourceClaimRecordId],
  };
  const candidateId = buildClaimCandidateId(candidateIdentity);
  const familyId = buildScopedFamilyId({
    seedId,
    normalizedClaim: canonicalClaim,
  });
  const discover = createLeanStageArtifact({
    ...baseEnvelope(),
    canonicalStage: "discover",
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
          identityStrength: "strong_source_offsets",
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
          canonicalClaim,
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
            lexicalFingerprint: {
              wordShingleHash: canonicalSha256("word"),
              charShingleHash: canonicalSha256("char"),
              wordShingles: ["intervention changed measured"],
            },
          },
        },
      ],
    },
  });
  const discoverReference = {
    ...asReference(discover, "canonical-discover-input"),
    role: "canonical-discover-input" as const,
    canonicalStage: "discover" as const,
  };
  const scopeDecision = createAppendOnlyDecision({
    recordId: candidateId,
    decisionType: "scope_candidate_disposition",
    outcome: "scoped",
    reason: "Highest-supported claim candidate.",
    recordedAt: "2026-07-16T12:00:00.000Z",
    actor: {
      kind: "deterministic",
      identifier: "canonical-scope-membership-freeze-v1",
    },
    evidenceArtifacts: [discoverReference],
  });
  const scope = createLeanStageArtifact({
    ...baseEnvelope(),
    canonicalStage: "scope",
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
          trackedClaim: canonicalClaim,
          normalizedClaim: canonicalClaim,
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
    },
  });
  const prepareScopeReference = {
    ...asReference(scope, "canonical-scope-input"),
    role: "canonical-scope-input" as const,
    canonicalStage: "scope" as const,
  };
  if (
    discover.canonicalStage !== "discover" ||
    scope.canonicalStage !== "scope"
  ) {
    throw new Error("Expected canonical Discover and Scope artifacts");
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
  const prepareRecord = {
    recordId: prepareRecordId,
    familyId: family.familyId,
    citationOccurrenceId: citationOccurrence.mentionId,
    family,
    sourceCandidates: discover.payload.claimCandidates.filter((candidate) =>
      family.candidateIds.includes(candidate.candidateId),
    ),
    sourceClaimRecords: discover.payload.attributedClaimRecords.filter(
      (sourceClaim) =>
        family.sourceClaimRecordIds.includes(sourceClaim.claimRecordId),
    ),
    occurrenceSourceCandidates: discover.payload.claimCandidates.filter(
      (candidate) =>
        family.candidateIds.includes(candidate.candidateId) &&
        candidate.memberMentionIds.includes(citationOccurrence.mentionId),
    ),
    occurrenceSourceClaimRecords:
      discover.payload.attributedClaimRecords.filter(
        (sourceClaim) =>
          family.sourceClaimRecordIds.includes(sourceClaim.claimRecordId) &&
          sourceClaim.mentionId === citationOccurrence.mentionId,
      ),
    seed: discover.payload.seeds[0]!,
    citingPaper: discover.payload.citingPapers[0]!,
    citationOccurrence,
    context: {
      verbatim: {
        text: citationOccurrence.rawContext,
        sourceOccurrenceId: citationOccurrence.mentionId,
        sourceArtifacts: citationOccurrence.observationProvenance.artifacts,
      },
      derived: [],
    },
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
    lineage: prepareLineage,
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
  const prepare = createLeanStageArtifact({
    ...baseEnvelope(),
    canonicalStage: "prepare",
    inputArtifacts: [prepareScopeReference, discoverReference],
    decisions: [prepareDecision],
    payload: {
      lineage: prepareLineage,
      scopedFamilies: [family],
      records: [prepareRecord],
    },
  });
  const evidencePrepareReference = {
    ...asReference(prepare, "canonical-prepare-input"),
    role: "canonical-prepare-input" as const,
    canonicalStage: "prepare" as const,
  };
  const evidenceScopeReference = {
    ...asReference(scope, "canonical-scope-input"),
    role: "canonical-scope-input" as const,
    canonicalStage: "scope" as const,
  };
  const evidenceQueryText = family.trackedClaim;
  const evidenceQueryId = buildEvidenceQueryId({
    familyId: family.familyId,
    text: evidenceQueryText,
    source: "scope-family-tracked-claim",
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
        identifier: "canonical-evidence-bm25-v1",
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
        identifier: "canonical-evidence-rerank-policy-v1",
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
        identifier: "canonical-evidence-selection-v1",
      },
      evidenceArtifacts: evidenceInputArtifacts,
    }),
  ];
  const evidence = createLeanStageArtifact({
    ...baseEnvelope(),
    canonicalStage: "evidence",
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
          source: "scope-family-tracked-claim",
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
  const adjudicate = createLeanStageArtifact({
    ...baseEnvelope(),
    canonicalStage: "adjudicate",
    inputArtifacts: [
      lineageReference(evidence, "canonical-evidence-input", "evidence"),
      lineageReference(prepare, "canonical-prepare-input", "prepare"),
    ],
    payload: {
      lineage: {
        runId: "run-contract-test",
        evidenceArtifact: lineageReference(
          evidence,
          "canonical-evidence-input",
          "evidence",
        ),
        prepareArtifact: lineageReference(
          prepare,
          "canonical-prepare-input",
          "prepare",
        ),
      },
      method: {
        methodId: "canonical-categorical-adjudicate-v1",
        strategy: "single_categorical",
        calibrationStatus: "uncalibrated",
        routing: "none",
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
    role: "canonical-discover-input" as const,
    canonicalStage: "discover" as const,
  };
  const reportScope = {
    artifactId: scope.artifactId,
    contentHash: scope.contentHash,
    role: "canonical-scope-input" as const,
    canonicalStage: "scope" as const,
  };
  const reportPrepare = {
    artifactId: prepare.artifactId,
    contentHash: prepare.contentHash,
    role: "canonical-prepare-input" as const,
    canonicalStage: "prepare" as const,
  };
  const reportEvidence = {
    artifactId: evidence.artifactId,
    contentHash: evidence.contentHash,
    role: "canonical-evidence-input" as const,
    canonicalStage: "evidence" as const,
  };
  const reportAdjudicate = {
    artifactId: adjudicate.artifactId,
    contentHash: adjudicate.contentHash,
    role: "canonical-adjudicate-input" as const,
    canonicalStage: "adjudicate" as const,
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
        identifier: canonicalReportMethodId,
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
        identifier: canonicalReportMethodId,
      },
      evidenceArtifacts: reportInputs,
    }),
  ];
  const report = createLeanStageArtifact({
    ...baseEnvelope(),
    canonicalStage: "report",
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
        methodId: "canonical-audit-report-v1",
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
      familyMutations: [],
      recordTraces: [],
      decisionSummaries: [],
      exclusionSummaries: [],
    },
  });
  return { discover, scope, prepare, evidence, adjudicate, report };
}

describe("lean stage artifact contracts", () => {
  it("re-exports the single canonical artifact primitive definitions", () => {
    expect(artifactReferenceSchema).toBe(primitiveArtifactReferenceSchema);
    expect(leanArtifactIdSchema).toBe(primitiveLeanArtifactIdSchema);
    expect(sha256DigestSchema).toBe(primitiveSha256DigestSchema);
    expect(stableIdentifierSchema).toBe(primitiveStableIdentifierSchema);
  });

  it("validates a versioned envelope for every canonical stage", () => {
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
      expect(leanStageArtifactSchema.safeParse(artifact).success).toBe(true);
      expect(artifact.schemaVersion).toBe(1);
      expect(artifact.artifactVersion).toBe(1);
      expect(artifact.artifactId).toMatch(/^artifact_[a-f0-9]{64}$/);
      expect(artifact.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("requires dispositions without deleting the complete candidate ledger", () => {
    const discover = buildAllStageArtifacts().discover;
    if (discover.canonicalStage !== "discover") {
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

  it("rejects dangling and cross-seed candidate source records", () => {
    const discover = buildAllStageArtifacts().discover;
    if (discover.canonicalStage !== "discover") {
      throw new Error("Expected discover artifact");
    }
    const dangling = discoverArtifactPayloadSchema.safeParse({
      ...discover.payload,
      claimCandidates: discover.payload.claimCandidates.map((candidate) => ({
        ...candidate,
        sourceClaimRecordIds: [
          buildStableId("claim-record", { missing: true }),
        ],
      })),
    });
    expect(dangling.success).toBe(false);
    if (!dangling.success) {
      expect(
        dangling.error.issues.some((issue) =>
          issue.message.includes("unknown attributed claim record"),
        ),
      ).toBe(true);
    }

    const secondSeedId = buildSeedId({ doi: "10.1234/second-seed" });
    const originalSeed = discover.payload.seeds[0]!;
    const crossSeed = discoverArtifactPayloadSchema.safeParse({
      ...discover.payload,
      seeds: [
        ...discover.payload.seeds,
        {
          ...originalSeed,
          seedId: secondSeedId,
          doi: "10.1234/second-seed",
          resolution: {
            ...originalSeed.resolution,
            paper:
              originalSeed.resolution.status === "resolved"
                ? {
                    ...originalSeed.resolution.paper,
                    paperId: "second-seed-paper",
                    providerRecordId: "provider-second-seed",
                    doi: "10.1234/second-seed",
                  }
                : undefined,
          },
        },
      ],
      claimCandidates: discover.payload.claimCandidates.map((candidate) => ({
        ...candidate,
        candidateId: buildClaimCandidateId({
          seedId: secondSeedId,
          normalizedClaim: candidate.normalizedClaim,
          sourceClaimRecordIds: candidate.sourceClaimRecordIds,
        }),
        seedId: secondSeedId,
      })),
    });
    expect(crossSeed.success).toBe(false);
    if (!crossSeed.success) {
      expect(
        crossSeed.error.issues.some((issue) =>
          issue.message.includes("source record belongs to another seed"),
        ),
      ).toBe(true);
    }
  });

  it("excludes creation time from stable artifact identity", () => {
    const first = buildAllStageArtifacts().discover;
    if (first.canonicalStage !== "discover") {
      throw new Error("Expected discover artifact");
    }
    const second = createLeanStageArtifact({
      ...baseEnvelope("2026-07-17T12:00:00.000Z"),
      canonicalStage: "discover",
      inputArtifacts: first.inputArtifacts,
      payload: first.payload,
    });

    expect(second.contentHash).toBe(first.contentHash);
    expect(second.artifactId).toBe(first.artifactId);
  });

  it("rejects content or identity tampering", () => {
    const artifact = buildAllStageArtifacts().discover;
    if (artifact.canonicalStage !== "discover") {
      throw new Error("Expected discover artifact");
    }
    const tampered = {
      ...artifact,
      payload: {
        ...artifact.payload,
        claimCandidates: artifact.payload.claimCandidates.map((candidate) => ({
          ...candidate,
          canonicalClaim: "A meaningfully different claim.",
        })),
      },
    };

    const parsed = parseLeanStageArtifact(tampered);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/candidateId|contentHash|artifactId/);
    }
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
      createLeanStageArtifact({
        ...baseEnvelope(),
        canonicalStage: "adjudicate",
        inputArtifacts: [
          lineageReference(
            artifacts.evidence,
            "canonical-evidence-input",
            "evidence",
          ),
          lineageReference(
            artifacts.prepare,
            "canonical-prepare-input",
            "prepare",
          ),
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
              "canonical-evidence-input",
              "evidence",
            ),
            prepareArtifact: lineageReference(
              artifacts.prepare,
              "canonical-prepare-input",
              "prepare",
            ),
          },
          method: {
            methodId: "canonical-categorical-adjudicate-v1",
            strategy: "single_categorical",
            calibrationStatus: "uncalibrated",
            routing: "none",
          },
          records: [],
        },
      }),
    ).toThrow(/Fully gated Adjudicate/);
  });
});

describe("canonical scientific identities", () => {
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
      trackedClaim: "The measured effect changed.",
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

  it("uses append-only, reasoned decisions and exclusions with stable IDs", () => {
    const firstDecision = createAppendOnlyDecision({
      recordId,
      decisionType: "scope",
      outcome: "include",
      reason: "The citation instance directly addresses the tracked claim.",
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
    const exclusion = createAppendOnlyExclusion({
      recordId,
      reasonCode: "ambiguous_bundle",
      reason:
        "The seed attribution cannot be isolated from the citation bundle.",
      recordedAt: "2026-07-16T12:03:00.000Z",
      actor: {
        kind: "human",
        identifier: "reviewer-1",
      },
      evidenceArtifacts: [],
      decisionId: revisedDecision.decisionId,
    });

    expect(appendOnlyDecisionSchema.safeParse(firstDecision).success).toBe(
      true,
    );
    expect(appendOnlyDecisionSchema.safeParse(revisedDecision).success).toBe(
      true,
    );
    expect(appendOnlyExclusionSchema.safeParse(exclusion).success).toBe(true);
    expect(revisedDecision.decisionId).not.toBe(firstDecision.decisionId);
    const retimedDecision = createAppendOnlyDecision({
      recordId,
      decisionType: "scope",
      outcome: "include",
      reason: "The citation instance directly addresses the tracked claim.",
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
