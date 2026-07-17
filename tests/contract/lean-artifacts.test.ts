import { describe, expect, it } from "vitest";

import {
  adjudicateArtifactSchema,
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
  buildScopedFamilyId,
  buildSeedId,
  createAppendOnlyDecision,
  createAppendOnlyExclusion,
  createLeanStageArtifact,
  discoverArtifactPayloadSchema,
  discoverArtifactSchema,
  evidenceArtifactSchema,
  leanArtifactSchemaVersion,
  leanArtifactVersion,
  leanStageArtifactSchema,
  parseLeanStageArtifact,
  prepareArtifactSchema,
  reportArtifactSchema,
  scopedFamilySchema,
  scopeArtifactSchema,
  type AppendOnlyDecision,
  type AppendOnlyExclusion,
  type ArtifactReference,
  type LeanArtifactProvenance,
  type LeanExecutionMetadata,
  type LeanStageArtifact,
} from "../../src/contract/lean-artifacts.js";
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
    inputArtifacts: [asReference(evidence, "record-evidence")],
    payload: { records: [] },
  });
  const report = createLeanStageArtifact({
    ...baseEnvelope(),
    canonicalStage: "report",
    inputArtifacts: [asReference(adjudicate, "adjudication-results")],
    payload: {
      title: "Citation fidelity report",
      summary: "No records were adjudicated.",
      recordIds: [],
      verdictCounts: {},
      metrics: { records: 0 },
      markdown: "# Citation fidelity report\n",
    },
  });
  return { discover, scope, prepare, evidence, adjudicate, report };
}

describe("lean stage artifact contracts", () => {
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

  it("captures model response artifacts as immutable execution provenance", () => {
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
    const artifact = createLeanStageArtifact({
      ...baseEnvelope(),
      canonicalStage: "adjudicate",
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
      payload: { records: [] },
    });

    expect(adjudicateArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(artifact.execution.kind).toBe("model");
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
