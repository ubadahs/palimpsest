import { describe, expect, it } from "vitest";

import {
  adjudicateArtifactSchema,
  appendOnlyDecisionSchema,
  appendOnlyExclusionSchema,
  buildAttributedClaimRecordId,
  buildClaimCandidateId,
  buildCitationOccurrenceId,
  buildCitationInstanceRecordId,
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
  prepareArtifactPayloadSchema,
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
  const seedId = buildSeedId({ doi: "10.1234/seed" });
  const mentionIdentity = {
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
  const mentionId = buildCitationOccurrenceId(mentionIdentity);
  const sourceClaimRecordIdentity = {
    seedId,
    mentionId,
    extractedClaimText: "The intervention changed the measured outcome.",
  };
  const sourceClaimRecordId = buildAttributedClaimRecordId(
    sourceClaimRecordIdentity,
  );
  const candidateIdentity = {
    seedId,
    canonicalClaim: "The intervention changed the measured outcome.",
    memberMentionIds: [mentionId],
  };
  const candidateId = buildClaimCandidateId(candidateIdentity);
  const familyId = buildScopedFamilyId({
    seedId,
    normalizedClaim: candidateIdentity.canonicalClaim,
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
          provenanceArtifacts: [rawInputReference],
        },
      ],
      citationMentions: [
        {
          mentionId,
          ...mentionIdentity,
          observationProvenance: {
            sourceType: "jats_xml",
            parser: "jats-v1",
            artifacts: [rawInputReference],
          },
        },
      ],
      attributedClaimRecords: [
        {
          claimRecordId: sourceClaimRecordId,
          ...sourceClaimRecordIdentity,
          provenanceArtifacts: [rawInputReference],
        },
      ],
      claimCandidates: [
        {
          candidateId,
          ...candidateIdentity,
          sourceClaimRecordIds: [sourceClaimRecordId],
          provenanceArtifacts: [rawInputReference],
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
  const scope = createLeanStageArtifact({
    ...baseEnvelope(),
    canonicalStage: "scope",
    inputArtifacts: [asReference(discover, "discovery-ledger")],
    payload: {
      families: [
        {
          familyId,
          seedId,
          candidateIds: [candidateId],
          trackedClaim: candidateIdentity.canonicalClaim,
          normalizedClaim: candidateIdentity.canonicalClaim,
          grounding: {
            status: "grounded",
            evidenceSpans: [
              {
                text: "The intervention changed the measured outcome.",
                sectionTitle: "Results",
                blockKind: "body_paragraph",
              },
            ],
            detailReason: "The claim is supported by a verbatim result span.",
          },
          includedCitationOccurrenceIds: [mentionId],
          provenanceArtifacts: [asReference(discover, "discovery-ledger")],
        },
      ],
    },
  });
  const prepare = createLeanStageArtifact({
    ...baseEnvelope(),
    canonicalStage: "prepare",
    inputArtifacts: [asReference(scope, "scope-decisions")],
    payload: { records: [] },
  });
  const evidence = createLeanStageArtifact({
    ...baseEnvelope(),
    canonicalStage: "evidence",
    inputArtifacts: [asReference(prepare, "prepared-records")],
    payload: { records: [] },
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
    const secondMentionIdentity = {
      seedId: secondSeedId,
      citingPaperId: "second-citing-paper",
      citedPaperId: "second-seed-paper",
      mentionIndex: 0,
      refId: "ref-2",
      charOffsetStart: 200,
      charOffsetEnd: 240,
      citationMarker: "[2]",
      rawContext: "A second citing occurrence [2].",
    };
    const secondMentionId = buildCitationOccurrenceId(secondMentionIdentity);
    const secondClaimIdentity = {
      seedId: secondSeedId,
      mentionId: secondMentionId,
      extractedClaimText: "A claim attributed to the second seed.",
    };
    const secondClaimRecordId =
      buildAttributedClaimRecordId(secondClaimIdentity);
    const provenanceArtifact =
      discover.payload.seeds[0]!.provenanceArtifacts[0]!;
    const crossSeed = discoverArtifactPayloadSchema.safeParse({
      ...discover.payload,
      seeds: [
        ...discover.payload.seeds,
        {
          seedId: secondSeedId,
          doi: "10.1234/second-seed",
          provenanceArtifacts: [provenanceArtifact],
        },
      ],
      citationMentions: [
        ...discover.payload.citationMentions,
        {
          mentionId: secondMentionId,
          ...secondMentionIdentity,
          observationProvenance: {
            sourceType: "jats_xml",
            parser: "jats-v1",
            artifacts: [provenanceArtifact],
          },
        },
      ],
      attributedClaimRecords: [
        ...discover.payload.attributedClaimRecords,
        {
          claimRecordId: secondClaimRecordId,
          ...secondClaimIdentity,
          provenanceArtifacts: [provenanceArtifact],
        },
      ],
      claimCandidates: discover.payload.claimCandidates.map((candidate) => ({
        ...candidate,
        sourceClaimRecordIds: [secondClaimRecordId],
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
      extractedClaimText: "The measured effect changed.",
    });
    expect(claimRecordId).toBe(
      buildAttributedClaimRecordId({
        seedId,
        mentionId: firstMentionId,
        extractedClaimText: " The measured effect changed. ",
      }),
    );
    expect(claimRecordId).not.toBe(
      buildAttributedClaimRecordId({
        seedId,
        mentionId: secondMentionId,
        extractedClaimText: "The measured effect changed.",
      }),
    );
    expect(claimRecordId).not.toBe(
      buildAttributedClaimRecordId({
        seedId,
        mentionId: firstMentionId,
        extractedClaimText: "A different attributed claim.",
      }),
    );

    const candidateId = buildClaimCandidateId({
      seedId,
      canonicalClaim: "The measured effect changed.",
      memberMentionIds: [secondMentionId, firstMentionId],
    });
    expect(candidateId).toBe(
      buildClaimCandidateId({
        seedId,
        canonicalClaim: "  The measured effect changed. ",
        memberMentionIds: [firstMentionId, secondMentionId],
      }),
    );
    expect(candidateId).not.toBe(
      buildClaimCandidateId({
        seedId,
        canonicalClaim: "A different measured effect changed.",
        memberMentionIds: [firstMentionId, secondMentionId],
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
      trackedClaim: "The measured effect changed.",
      normalizedClaim: "The measured effect changed.",
      grounding: {
        status: "grounded" as const,
        evidenceSpans: [],
        detailReason: "Grounded for identity testing.",
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
  const mention = {
    mentionIndex: 2,
    rawContext: "Prior work [7] reported the measured effect.",
    citationMarker: "[7]",
    sectionTitle: "Discussion",
    refId: "ref-7",
    charOffsetStart: 100,
    charOffsetEnd: 149,
    isBundledCitation: false,
    bundleSize: 1,
    bundleRefIds: ["ref-7"],
    bundlePattern: "single" as const,
    sourceType: "jats_xml" as const,
    parser: "jats-v1",
    isDuplicate: false,
    contextLength: 49,
    markerStyle: "numeric" as const,
    contextType: "narrative_like" as const,
    confidence: "high" as const,
    provenance: {
      sourceType: "jats_xml" as const,
      parser: "jats-v1",
      refId: "ref-7",
      charOffsetStart: 100,
      charOffsetEnd: 149,
    },
  };
  const seedId = buildSeedId({ doi: "10.1234/seed" });
  const citationInstanceIdentity = {
    seedDoi: "https://doi.org/10.1234/SEED",
    citingPaperId: "citing-paper",
    citedPaperId: "seed-paper",
    mentionIndex: mention.mentionIndex,
    refId: mention.refId,
    charOffsetStart: mention.charOffsetStart,
    charOffsetEnd: mention.charOffsetEnd,
    citationMarker: mention.citationMarker,
    rawContext: mention.rawContext,
  };
  const citationOccurrenceId = buildCitationOccurrenceId({
    ...citationInstanceIdentity,
    seedId,
  });
  const recordId = buildCitationInstanceRecordId(citationInstanceIdentity);
  const preparedRecord = {
    recordId,
    citationOccurrenceId,
    seed: {
      seedId,
      doi: "10.1234/seed",
      trackedClaim: "The measured effect changed.",
    },
    citingPaper: {
      paperId: "citing-paper",
      title: "Citing paper",
      doi: "10.1234/citing",
    },
    citedPaper: {
      paperId: "seed-paper",
      title: "Seed paper",
      doi: "10.1234/seed",
    },
    mention,
    classification: {
      citationRole: "background_context" as const,
      evaluationMode: "fidelity_background_framing" as const,
      modifiers: {
        isBundled: false,
        isReviewMediated: false,
      },
      signals: ["discussion-context"],
    },
  };

  it("ignores parser metadata but changes identity with the occurrence location", () => {
    const alternateParserRecord = {
      ...preparedRecord,
      mention: {
        ...preparedRecord.mention,
        sourceType: "grobid_tei" as const,
        parser: "grobid-v2",
        provenance: {
          ...preparedRecord.mention.provenance,
          sourceType: "grobid_tei" as const,
          parser: "grobid-v2",
        },
      },
    };
    expect(
      prepareArtifactPayloadSchema.safeParse({
        records: [preparedRecord, alternateParserRecord],
      }).success,
    ).toBe(true);
    expect(alternateParserRecord.recordId).toBe(preparedRecord.recordId);

    const movedRecordId = buildCitationInstanceRecordId({
      seedDoi: preparedRecord.seed.doi,
      citingPaperId: preparedRecord.citingPaper.paperId,
      citedPaperId: preparedRecord.citedPaper.paperId,
      mentionIndex: mention.mentionIndex,
      refId: mention.refId,
      charOffsetStart: mention.charOffsetStart + 1,
      charOffsetEnd: mention.charOffsetEnd + 1,
      citationMarker: mention.citationMarker,
      rawContext: mention.rawContext,
    });
    expect(movedRecordId).not.toBe(recordId);
  });

  it("keeps citation identity stable while classification content changes", () => {
    const changedClassification = {
      ...preparedRecord,
      classification: {
        ...preparedRecord.classification,
        citationRole: "substantive_attribution" as const,
        evaluationMode: "fidelity_specific_claim" as const,
      },
    };

    expect(
      prepareArtifactPayloadSchema.safeParse({
        records: [preparedRecord, changedClassification],
      }).success,
    ).toBe(true);
    expect(changedClassification.recordId).toBe(preparedRecord.recordId);

    const first = createLeanStageArtifact({
      ...baseEnvelope(),
      canonicalStage: "prepare",
      payload: { records: [preparedRecord] },
    });
    const second = createLeanStageArtifact({
      ...baseEnvelope(),
      canonicalStage: "prepare",
      payload: { records: [changedClassification] },
    });
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.artifactId).not.toBe(first.artifactId);
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

    const firstDecisionArtifact = createLeanStageArtifact({
      ...baseEnvelope(),
      canonicalStage: "prepare",
      decisions: [firstDecision],
      payload: { records: [preparedRecord] },
    });
    const retimedDecisionArtifact = createLeanStageArtifact({
      ...baseEnvelope(),
      canonicalStage: "prepare",
      decisions: [retimedDecision],
      payload: { records: [preparedRecord] },
    });
    expect(retimedDecisionArtifact.contentHash).toBe(
      firstDecisionArtifact.contentHash,
    );
    expect(retimedDecisionArtifact.artifactId).toBe(
      firstDecisionArtifact.artifactId,
    );

    const artifact = createLeanStageArtifact({
      ...baseEnvelope(),
      canonicalStage: "prepare",
      decisions: [firstDecision, revisedDecision],
      exclusions: [exclusion],
      payload: { records: [preparedRecord] },
    });
    expect(artifact.decisions).toHaveLength(2);
    expect(artifact.decisions[1]?.supersedesDecisionId).toBe(
      firstDecision.decisionId,
    );
    expect(artifact.exclusions[0]?.reason).toContain("cannot be isolated");

    expect(() =>
      createLeanStageArtifact({
        ...baseEnvelope(),
        canonicalStage: "prepare",
        decisions: [firstDecision, firstDecision],
        payload: { records: [preparedRecord] },
      }),
    ).toThrow(/Duplicate append-only decision ID/);
  });
});
