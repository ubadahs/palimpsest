import { z } from "zod";

import {
  artifactReferenceSchema,
  buildAttributedClaimRecordId,
  buildCitationOccurrenceId,
  buildCitingPaperRecordId,
  buildClaimCandidateId,
  buildClaimExtractionObservationId,
  buildNeighborhoodQueryId,
  buildSeedId,
  citationSourceLocatorSchema,
  createAppendOnlyDecision,
  createLeanStageArtifact,
  discoverArtifactPayloadSchema,
  discoverArtifactSchema,
  leanArtifactSchemaVersion,
  leanArtifactVersion,
  normalizeDiscoverClaimText,
  sha256DigestSchema,
  type AppendOnlyDecision,
  type AppendOnlyExclusion,
  type ArtifactReference,
  type DiscoverArtifact,
  type DiscoverArtifactPayload,
  type DiscoverAttributedClaimRecord,
  type DiscoverCitationOccurrence,
  type DiscoverCitingPaperRecord,
  type DiscoverClaimCandidate,
  type LeanArtifactProvenance,
} from "../contract/lean-artifacts.js";
import { canonicalSerialize } from "../shared/stable-identity.js";

const fatalProviderFailureCodeSchema = z.enum([
  "authentication",
  "authorization",
  "billing",
  "quota",
]);

export const canonicalDiscoverFailureCodeSchema = z.union([
  fatalProviderFailureCodeSchema,
  z.enum([
    "not_found",
    "unavailable",
    "timeout",
    "rate_limited",
    "transport",
    "invalid_response",
    "extraction_failed",
  ]),
]);
export type CanonicalDiscoverFailureCode = z.infer<
  typeof canonicalDiscoverFailureCodeSchema
>;

const seedInputSchema = z
  .object({
    doi: z.string().min(1),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict();

const yearRangeSchema = z
  .object({
    from: z.number().int().optional(),
    to: z.number().int().optional(),
  })
  .strict()
  .superRefine((range, context) => {
    if (range.from != null && range.to != null && range.from > range.to) {
      context.addIssue({
        code: "custom",
        path: ["from"],
        message: "Neighborhood year range must be ascending",
      });
    }
  });

export const canonicalDiscoverOptionsSchema = z
  .object({
    seeds: z.array(seedInputSchema).min(1),
    neighborhood: z
      .object({
        provider: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().nonnegative(),
        yearRange: yearRangeSchema.optional(),
      })
      .strict(),
    probeBudget: z.number().int().nonnegative(),
    scopeCandidateCap: z.number().int().nonnegative(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CanonicalDiscoverOptions = z.infer<
  typeof canonicalDiscoverOptionsSchema
>;

const externalExecutionSchema = z
  .object({
    provider: z.string().min(1),
    requestHash: sha256DigestSchema,
    requestArtifact: artifactReferenceSchema,
    responseArtifact: artifactReferenceSchema,
  })
  .strict();

const resolvedPaperInputSchema = z
  .object({
    paperId: z.string().min(1),
    providerRecordId: z.string().min(1),
    title: z.string().min(1),
    doi: z.string().min(1).optional(),
    authors: z.array(z.string()),
    publicationYear: z.number().int().optional(),
  })
  .strict();

export const canonicalSeedResolutionResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("resolved"),
        paper: resolvedPaperInputSchema,
        execution: externalExecutionSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        reasonCode: canonicalDiscoverFailureCodeSchema,
        reason: z.string().min(1),
        execution: externalExecutionSchema,
      })
      .strict(),
  ],
);
export type CanonicalSeedResolutionResult = z.infer<
  typeof canonicalSeedResolutionResultSchema
>;

const citingPaperInputSchema = z
  .object({
    providerRecordId: z.string().min(1),
    paperId: z.string().min(1),
    title: z.string().min(1),
    doi: z.string().min(1).optional(),
    authors: z.array(z.string()),
    publicationYear: z.number().int().optional(),
    fullTextAvailability: z.enum([
      "available",
      "abstract_only",
      "unavailable",
      "unknown",
    ]),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict();

export const canonicalNeighborhoodResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("completed"),
        providerReportedTotal: z.number().int().nonnegative().optional(),
        coverage: z.enum(["complete", "truncated", "unknown"]),
        papers: z.array(citingPaperInputSchema),
        execution: externalExecutionSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        reasonCode: canonicalDiscoverFailureCodeSchema,
        reason: z.string().min(1),
        execution: externalExecutionSchema,
      })
      .strict(),
  ],
);
export type CanonicalNeighborhoodResult = z.infer<
  typeof canonicalNeighborhoodResultSchema
>;

const dispositionInputSchema = z
  .object({
    reason: z.string().min(1),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict();

const harvestedMentionInputSchema = z
  .object({
    mentionIndex: z.number().int().nonnegative(),
    refId: z.string().min(1).optional(),
    charOffsetStart: z.number().int().nonnegative().optional(),
    charOffsetEnd: z.number().int().nonnegative().optional(),
    sourceLocator: citationSourceLocatorSchema.optional(),
    citationMarker: z.string(),
    rawContext: z.string(),
    sectionTitle: z.string().optional(),
    seedRefLabel: z.string().optional(),
    isBundledCitation: z.boolean(),
    bundleSize: z.number().int().positive(),
    bundleRefIds: z.array(z.string().min(1)),
    bundlePattern: z.string().min(1),
    sourceType: z.string().min(1),
    parser: z.string().min(1),
    parserVersion: z.string().min(1).optional(),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict()
  .superRefine((mention, context) => {
    if ((mention.charOffsetStart == null) !== (mention.charOffsetEnd == null)) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetStart"],
        message: "Citation source offsets must be both present or both absent",
      });
    } else if (
      mention.charOffsetStart != null &&
      mention.charOffsetEnd != null &&
      mention.charOffsetEnd <= mention.charOffsetStart
    ) {
      context.addIssue({
        code: "custom",
        path: ["charOffsetEnd"],
        message: "Citation source offset end must be greater than start",
      });
    }
  });

export const canonicalMentionHarvestResultSchema = z
  .object({
    materialization: z.discriminatedUnion("status", [
      dispositionInputSchema
        .extend({ status: z.literal("succeeded") })
        .strict(),
      dispositionInputSchema
        .extend({
          status: z.literal("unavailable"),
          reasonCode: canonicalDiscoverFailureCodeSchema,
        })
        .strict(),
      dispositionInputSchema
        .extend({
          status: z.literal("failed"),
          reasonCode: canonicalDiscoverFailureCodeSchema,
        })
        .strict(),
    ]),
    harvest: z.discriminatedUnion("status", [
      dispositionInputSchema
        .extend({ status: z.literal("succeeded") })
        .strict(),
      dispositionInputSchema
        .extend({ status: z.literal("no_mentions") })
        .strict(),
      dispositionInputSchema
        .extend({
          status: z.literal("failed"),
          reasonCode: canonicalDiscoverFailureCodeSchema,
        })
        .strict(),
      dispositionInputSchema
        .extend({ status: z.literal("not_attempted") })
        .strict(),
    ]),
    mentions: z.array(harvestedMentionInputSchema),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.materialization.status !== "succeeded" &&
      result.harvest.status !== "not_attempted"
    ) {
      context.addIssue({
        code: "custom",
        path: ["harvest", "status"],
        message: "Harvest cannot run without successful materialization",
      });
    }
    if (
      result.materialization.status === "succeeded" &&
      result.harvest.status === "not_attempted"
    ) {
      context.addIssue({
        code: "custom",
        path: ["harvest", "status"],
        message: "Successful materialization requires a harvest outcome",
      });
    }
    if (result.harvest.status === "succeeded" && result.mentions.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["mentions"],
        message: "Successful harvest requires at least one citation occurrence",
      });
    }
    if (result.harvest.status !== "succeeded" && result.mentions.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["mentions"],
        message: "Only successful harvests can return citation occurrences",
      });
    }
  });
export type CanonicalMentionHarvestResult = z.infer<
  typeof canonicalMentionHarvestResultSchema
>;

const modelExecutionInputSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    promptId: z.string().min(1),
    promptVersion: z.string().min(1),
    promptContentHash: sha256DigestSchema,
    requestHash: sha256DigestSchema,
    requestArtifact: artifactReferenceSchema,
    responseArtifact: artifactReferenceSchema,
  })
  .strict();

const extractedClaimInputSchema = z
  .object({
    text: z.string().min(1),
    supportSpanText: z.string().min(1).optional(),
    confidence: z.enum(["high", "medium", "low"]).optional(),
  })
  .strict();

export const canonicalClaimExtractionResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("completed"),
        reason: z.string().min(1),
        claims: z.array(extractedClaimInputSchema),
        execution: modelExecutionInputSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        reasonCode: canonicalDiscoverFailureCodeSchema,
        reason: z.string().min(1),
        execution: modelExecutionInputSchema,
      })
      .strict(),
  ],
);
export type CanonicalClaimExtractionResult = z.infer<
  typeof canonicalClaimExtractionResultSchema
>;

export type CanonicalDiscoverAdapters = {
  resolveSeed: (input: { doi: string }) => Promise<unknown>;
  retrieveCitingNeighborhood: (input: {
    seed: CanonicalSeedResolutionResult & { status: "resolved" };
    boundary: CanonicalDiscoverOptions["neighborhood"];
  }) => Promise<unknown>;
  harvestMentions: (input: {
    seed: CanonicalSeedResolutionResult & { status: "resolved" };
    citingPaper: z.infer<typeof citingPaperInputSchema>;
  }) => Promise<unknown>;
  extractAttributedClaims: (input: {
    seed: CanonicalSeedResolutionResult & { status: "resolved" };
    citingPaper: z.infer<typeof citingPaperInputSchema>;
    mention: DiscoverCitationOccurrence;
  }) => Promise<unknown>;
};

export type CanonicalDiscoverProvenanceInputs = {
  inputArtifacts: ArtifactReference[];
  prompts: LeanArtifactProvenance["prompts"];
  models: LeanArtifactProvenance["models"];
  responseArtifacts: ArtifactReference[];
};

export type CanonicalDiscoverResult = {
  payload: DiscoverArtifactPayload;
  decisions: AppendOnlyDecision[];
  exclusions: AppendOnlyExclusion[];
  provenanceInputs: CanonicalDiscoverProvenanceInputs;
};

export class CanonicalDiscoverBoundaryError extends Error {
  override readonly name = "CanonicalDiscoverBoundaryError";
}

export class CanonicalDiscoverFatalError extends Error {
  override readonly name = "CanonicalDiscoverFatalError";

  constructor(
    readonly failureCode: z.infer<typeof fatalProviderFailureCodeSchema>,
    message: string,
  ) {
    super(message);
  }
}

export async function runCanonicalDiscover(
  optionsInput: CanonicalDiscoverOptions,
  adapters: CanonicalDiscoverAdapters,
): Promise<CanonicalDiscoverResult> {
  const options = canonicalDiscoverOptionsSchema.parse(optionsInput);
  assertUniqueSeedDois(options.seeds);

  const seeds: DiscoverArtifactPayload["seeds"] = [];
  const neighborhoodQueries: DiscoverArtifactPayload["neighborhoodQueries"] =
    [];
  const citingPapers: DiscoverCitingPaperRecord[] = [];
  const citationMentions: DiscoverCitationOccurrence[] = [];
  const claimExtractionObservations: DiscoverArtifactPayload["claimExtractionObservations"] =
    [];
  const attributedClaimRecords: DiscoverAttributedClaimRecord[] = [];
  const decisions: AppendOnlyDecision[] = [];
  const inputArtifacts: ArtifactReference[] = [];
  const responseArtifacts: ArtifactReference[] = [];
  const prompts: LeanArtifactProvenance["prompts"] = [];
  const models: LeanArtifactProvenance["models"] = [];

  const orderedSeeds = [...options.seeds].sort((left, right) =>
    compareCodeUnits(buildSeedId(left), buildSeedId(right)),
  );

  for (const seedInput of orderedSeeds) {
    const seedId = buildSeedId(seedInput);
    inputArtifacts.push(...seedInput.provenanceArtifacts);
    const resolution = parseAdapterOutput(
      canonicalSeedResolutionResultSchema,
      await adapters.resolveSeed({ doi: seedInput.doi }),
      `seed resolution for ${seedInput.doi}`,
    );
    if (resolution.status === "failed") {
      throwIfFatal(resolution);
    }
    responseArtifacts.push(resolution.execution.responseArtifact);

    const seed = {
      seedId,
      doi: seedInput.doi,
      provenanceArtifacts: uniqueSortedArtifactReferences([
        ...seedInput.provenanceArtifacts,
        resolution.execution.requestArtifact,
        resolution.execution.responseArtifact,
      ]),
      resolution:
        resolution.status === "resolved"
          ? {
              status: "resolved" as const,
              provider: resolution.execution.provider,
              requestHash: resolution.execution.requestHash,
              requestArtifact: resolution.execution.requestArtifact,
              responseArtifact: resolution.execution.responseArtifact,
              paper: resolution.paper,
            }
          : {
              status: "failed" as const,
              provider: resolution.execution.provider,
              reasonCode: resolution.reasonCode,
              reason: resolution.reason,
              requestHash: resolution.execution.requestHash,
              requestArtifact: resolution.execution.requestArtifact,
              responseArtifact: resolution.execution.responseArtifact,
            },
    };
    seeds.push(seed);

    const neighborhoodId = buildNeighborhoodQueryId({
      seedId,
      provider: options.neighborhood.provider,
      query: options.neighborhood.query,
      limit: options.neighborhood.limit,
      ...(options.neighborhood.yearRange
        ? { yearRange: options.neighborhood.yearRange }
        : {}),
    });
    const boundaryBase = {
      neighborhoodId,
      seedId,
      provider: options.neighborhood.provider,
      query: options.neighborhood.query,
      configuredLimit: options.neighborhood.limit,
      ...(options.neighborhood.yearRange
        ? { configuredYearRange: options.neighborhood.yearRange }
        : {}),
    };

    if (resolution.status === "failed") {
      neighborhoodQueries.push({
        ...boundaryBase,
        status: "not_attempted",
        statusReason: `Seed resolution failed: ${resolution.reason}`,
        returnedCount: 0,
        coverage: "unknown",
        provenanceArtifacts: [resolution.execution.responseArtifact],
      });
      continue;
    }

    const neighborhood = parseAdapterOutput(
      canonicalNeighborhoodResultSchema,
      await adapters.retrieveCitingNeighborhood({
        seed: resolution,
        boundary: options.neighborhood,
      }),
      `citing neighborhood for ${seedInput.doi}`,
    );
    if (neighborhood.status === "failed") {
      throwIfFatal(neighborhood);
    }
    responseArtifacts.push(neighborhood.execution.responseArtifact);

    if (neighborhood.status === "failed") {
      neighborhoodQueries.push({
        ...boundaryBase,
        status: "failed",
        statusReason: neighborhood.reason,
        returnedCount: 0,
        coverage: "unknown",
        requestHash: neighborhood.execution.requestHash,
        requestArtifact: neighborhood.execution.requestArtifact,
        responseArtifact: neighborhood.execution.responseArtifact,
        provenanceArtifacts: [
          neighborhood.execution.requestArtifact,
          neighborhood.execution.responseArtifact,
        ],
      });
      continue;
    }

    validateNeighborhoodBoundary(neighborhood, options.neighborhood.limit);
    neighborhoodQueries.push({
      ...boundaryBase,
      status: "completed",
      statusReason:
        neighborhood.papers.length === 0
          ? "Provider returned no citing papers within the declared boundary"
          : "Provider query completed",
      returnedCount: neighborhood.papers.length,
      ...(neighborhood.providerReportedTotal != null
        ? { providerReportedTotal: neighborhood.providerReportedTotal }
        : {}),
      coverage: neighborhood.coverage,
      requestHash: neighborhood.execution.requestHash,
      requestArtifact: neighborhood.execution.requestArtifact,
      responseArtifact: neighborhood.execution.responseArtifact,
      provenanceArtifacts: [
        neighborhood.execution.requestArtifact,
        neighborhood.execution.responseArtifact,
      ],
    });

    const paperObservations = neighborhood.papers.map(
      (paper, providerPosition) => ({
        paper,
        providerPosition,
        citingPaperRecordId: buildCitingPaperRecordId({
          seedId,
          provider: options.neighborhood.provider,
          providerRecordId: paper.providerRecordId,
        }),
      }),
    );
    const selectedPaperIds = new Set(
      [...paperObservations]
        .sort(comparePaperProbePriority)
        .slice(0, options.probeBudget)
        .map((paper) => paper.citingPaperRecordId),
    );

    for (const observation of paperObservations) {
      const isSelected = selectedPaperIds.has(observation.citingPaperRecordId);
      const paperBase = {
        citingPaperRecordId: observation.citingPaperRecordId,
        seedId,
        neighborhoodId,
        provider: options.neighborhood.provider,
        providerRecordId: observation.paper.providerRecordId,
        providerPosition: observation.providerPosition,
        paper: {
          paperId: observation.paper.paperId,
          title: observation.paper.title,
          ...(observation.paper.doi ? { doi: observation.paper.doi } : {}),
          authors: observation.paper.authors,
          ...(observation.paper.publicationYear != null
            ? { publicationYear: observation.paper.publicationYear }
            : {}),
          fullTextAvailability: observation.paper.fullTextAvailability,
        },
        provenanceArtifacts: uniqueSortedArtifactReferences([
          ...observation.paper.provenanceArtifacts,
          neighborhood.execution.responseArtifact,
        ]),
        probe: {
          status: isSelected
            ? ("selected" as const)
            : ("not_selected" as const),
          reason: isSelected
            ? "Selected within the deterministic probe budget"
            : "Not selected because the probe budget was exhausted",
          provenanceArtifacts: [neighborhood.execution.responseArtifact],
        },
      };

      decisions.push(
        createAppendOnlyDecision({
          recordId: observation.citingPaperRecordId,
          decisionType: "discover_probe_disposition",
          outcome: isSelected ? "selected" : "not_selected",
          reason: paperBase.probe.reason,
          recordedAt: options.recordedAt,
          actor: {
            kind: "deterministic",
            identifier: "canonical-discover-probe-budget-v1",
          },
          evidenceArtifacts: paperBase.probe.provenanceArtifacts,
        }),
      );

      if (!isSelected) {
        citingPapers.push({
          ...paperBase,
          materialization: {
            status: "not_attempted",
            reason: "Paper was outside the configured probe budget",
            provenanceArtifacts: [],
          },
          harvest: {
            status: "not_attempted",
            reason: "Paper was not materialized or harvested",
            provenanceArtifacts: [],
            observedMentionCount: 0,
          },
        });
        continue;
      }

      const harvest = parseAdapterOutput(
        canonicalMentionHarvestResultSchema,
        await adapters.harvestMentions({
          seed: resolution,
          citingPaper: observation.paper,
        }),
        `mention harvest for ${observation.paper.providerRecordId}`,
      );
      throwIfFatal(harvest.materialization);
      throwIfFatal(harvest.harvest);
      responseArtifacts.push(
        ...harvest.materialization.provenanceArtifacts,
        ...harvest.harvest.provenanceArtifacts,
      );

      const paperMentions = harvest.mentions.map((mention) =>
        createCitationOccurrence({
          seedId,
          citedPaperId: resolution.paper.paperId,
          citingPaperRecordId: observation.citingPaperRecordId,
          citingPaperId: observation.paper.paperId,
          mention,
        }),
      );
      citationMentions.push(...paperMentions);
      citingPapers.push({
        ...paperBase,
        materialization: harvest.materialization,
        harvest: {
          ...harvest.harvest,
          observedMentionCount: paperMentions.length,
        },
      });

      for (const mention of paperMentions) {
        const extraction = parseAdapterOutput(
          canonicalClaimExtractionResultSchema,
          await adapters.extractAttributedClaims({
            seed: resolution,
            citingPaper: observation.paper,
            mention,
          }),
          `attributed-claim extraction for ${mention.mentionId}`,
        );
        throwIfFatal(extraction);
        const execution = extraction.execution;
        responseArtifacts.push(execution.responseArtifact);
        prompts.push({
          promptId: execution.promptId,
          version: execution.promptVersion,
          contentHash: execution.promptContentHash,
        });
        models.push({
          provider: execution.provider,
          model: execution.model,
          requestHash: execution.requestHash,
          requestArtifact: execution.requestArtifact,
          responseArtifact: execution.responseArtifact,
        });

        const extractionId = buildClaimExtractionObservationId({
          seedId,
          mentionId: mention.mentionId,
        });
        const provenanceArtifacts = uniqueSortedArtifactReferences([
          execution.requestArtifact,
          execution.responseArtifact,
        ]);
        if (extraction.status === "failed") {
          claimExtractionObservations.push({
            extractionId,
            seedId,
            mentionId: mention.mentionId,
            status: "failed",
            reason: extraction.reason,
            claimRecordIds: [],
            provenanceArtifacts,
            execution: {
              kind: "model",
              ...execution,
            },
          });
          continue;
        }

        const records = buildAttributedClaimRecords({
          claims: extraction.claims,
          seedId,
          mentionId: mention.mentionId,
          extractionId,
          provenanceArtifacts,
        });
        attributedClaimRecords.push(...records);
        claimExtractionObservations.push({
          extractionId,
          seedId,
          mentionId: mention.mentionId,
          status: records.length > 0 ? "claims_extracted" : "no_claims",
          reason: extraction.reason,
          claimRecordIds: records.map((record) => record.claimRecordId),
          provenanceArtifacts,
          execution: {
            kind: "model",
            ...execution,
          },
        });
      }
    }
  }

  const claimCandidates = buildClaimCandidates(attributedClaimRecords);
  const candidateDispositions = rankCandidates(
    claimCandidates,
    options.scopeCandidateCap,
  );
  for (const disposition of candidateDispositions) {
    const candidate = claimCandidates.find(
      (entry) => entry.candidateId === disposition.candidateId,
    );
    if (!candidate) {
      throw new Error("Candidate disposition construction lost its candidate");
    }
    decisions.push(
      createAppendOnlyDecision({
        recordId: candidate.candidateId,
        decisionType: "discover_scope_disposition",
        outcome: disposition.selectedForScope
          ? "selected_for_scope"
          : "deferred_by_cap",
        reason: disposition.reason,
        recordedAt: options.recordedAt,
        actor: {
          kind: "deterministic",
          identifier: "canonical-discover-candidate-ranking-v1",
        },
        evidenceArtifacts: candidate.provenanceArtifacts,
      }),
    );
  }

  const payload = discoverArtifactPayloadSchema.parse({
    seeds,
    neighborhoodQueries,
    citingPapers,
    citationMentions,
    claimExtractionObservations,
    attributedClaimRecords,
    claimCandidates,
    candidateDispositions,
  });

  return {
    payload,
    decisions: [...decisions].sort((left, right) =>
      compareCodeUnits(left.decisionId, right.decisionId),
    ),
    exclusions: [],
    provenanceInputs: {
      inputArtifacts: uniqueSortedArtifactReferences(inputArtifacts),
      prompts: uniqueSorted(prompts),
      models: uniqueSorted(models),
      responseArtifacts: uniqueSortedArtifactReferences(responseArtifacts),
    },
  };
}

export function buildCanonicalDiscoverArtifact(input: {
  result: CanonicalDiscoverResult;
  runId: string;
  createdAt: string;
  implementation?: string | undefined;
  configuration?: LeanArtifactProvenance["configuration"] | undefined;
  code?: LeanArtifactProvenance["code"] | undefined;
}): DiscoverArtifact {
  const provenance: LeanArtifactProvenance = {
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(input.code ? { code: input.code } : {}),
    prompts: input.result.provenanceInputs.prompts,
    models: input.result.provenanceInputs.models,
  };
  const artifact = createLeanStageArtifact({
    schemaVersion: leanArtifactSchemaVersion,
    artifactVersion: leanArtifactVersion,
    runId: input.runId,
    createdAt: input.createdAt,
    canonicalStage: "discover",
    inputArtifacts: input.result.provenanceInputs.inputArtifacts,
    provenance,
    execution: {
      kind:
        input.result.provenanceInputs.models.length > 0 ? "hybrid" : "external",
      implementation: input.implementation ?? "canonical-discover-v1",
      replayableFromInputs: false,
      responseArtifacts: input.result.provenanceInputs.responseArtifacts,
    },
    decisions: input.result.decisions,
    exclusions: input.result.exclusions,
    payload: input.result.payload,
  });
  return discoverArtifactSchema.parse(artifact);
}

export function normalizeClaimForDiscovery(value: string): string {
  return normalizeDiscoverClaimText(value);
}

function buildAttributedClaimRecords(input: {
  claims: z.infer<typeof extractedClaimInputSchema>[];
  seedId: string;
  mentionId: string;
  extractionId: string;
  provenanceArtifacts: ArtifactReference[];
}): DiscoverAttributedClaimRecord[] {
  const indexedClaims = input.claims.map((claim, sourceClaimIndex) => ({
    claim,
    sourceClaimIndex,
    normalizedClaim: normalizeDiscoverClaimText(claim.text),
  }));
  const claimsByNormalizedText = new Map<string, typeof indexedClaims>();
  for (const indexedClaim of indexedClaims) {
    const duplicateGroup =
      claimsByNormalizedText.get(indexedClaim.normalizedClaim) ?? [];
    duplicateGroup.push(indexedClaim);
    claimsByNormalizedText.set(indexedClaim.normalizedClaim, duplicateGroup);
  }

  const duplicateOrdinalBySourceIndex = new Map<number, number>();
  for (const duplicateGroup of claimsByNormalizedText.values()) {
    const deterministicOrder = [...duplicateGroup].sort((left, right) =>
      compareCodeUnits(
        canonicalSerialize(claimDuplicateOrderingContent(left.claim)),
        canonicalSerialize(claimDuplicateOrderingContent(right.claim)),
      ),
    );
    deterministicOrder.forEach((claim, duplicateOrdinal) => {
      duplicateOrdinalBySourceIndex.set(
        claim.sourceClaimIndex,
        duplicateOrdinal,
      );
    });
  }

  return indexedClaims.map(
    ({ claim, sourceClaimIndex }): DiscoverAttributedClaimRecord => {
      const duplicateOrdinal =
        duplicateOrdinalBySourceIndex.get(sourceClaimIndex);
      if (duplicateOrdinal == null) {
        throw new Error("Claim duplicate ordinal construction failed");
      }
      const identity = {
        seedId: input.seedId,
        mentionId: input.mentionId,
        duplicateOrdinal,
        extractedClaimText: claim.text,
      };
      return {
        claimRecordId: buildAttributedClaimRecordId(identity),
        extractionId: input.extractionId,
        ...identity,
        sourceClaimIndex,
        ...(claim.supportSpanText
          ? { supportSpanText: claim.supportSpanText }
          : {}),
        ...(claim.confidence ? { confidence: claim.confidence } : {}),
        provenanceArtifacts: input.provenanceArtifacts,
      };
    },
  );
}

function claimDuplicateOrderingContent(
  claim: z.infer<typeof extractedClaimInputSchema>,
) {
  return {
    originalClaimText: claim.text,
    supportSpanText: claim.supportSpanText,
    confidence: claim.confidence,
  };
}

function buildClaimCandidates(
  records: readonly DiscoverAttributedClaimRecord[],
): DiscoverClaimCandidate[] {
  const groups = new Map<string, DiscoverAttributedClaimRecord[]>();
  for (const record of records) {
    const normalizedClaim = normalizeClaimForDiscovery(
      record.extractedClaimText,
    );
    const key = canonicalSerialize({
      seedId: record.seedId,
      normalizedClaim,
    });
    const group = groups.get(key);
    if (group) {
      group.push(record);
    } else {
      groups.set(key, [record]);
    }
  }

  return [...groups.values()]
    .map((group): DiscoverClaimCandidate => {
      const orderedRecords = [...group].sort((left, right) =>
        compareCodeUnits(left.claimRecordId, right.claimRecordId),
      );
      const first = orderedRecords[0]!;
      const normalizedClaim = normalizeClaimForDiscovery(
        first.extractedClaimText,
      );
      const sourceClaimRecordIds = orderedRecords.map(
        (record) => record.claimRecordId,
      );
      const memberMentionIds = [
        ...new Set(orderedRecords.map((record) => record.mentionId)),
      ].sort(compareCodeUnits);
      const canonicalClaim = orderedRecords
        .map((record) => record.extractedClaimText.trim().replace(/\s+/g, " "))
        .sort(compareCodeUnits)[0]!;
      return {
        candidateId: buildClaimCandidateId({
          seedId: first.seedId,
          normalizedClaim,
          sourceClaimRecordIds,
        }),
        seedId: first.seedId,
        canonicalClaim,
        normalizedClaim,
        memberMentionIds,
        sourceClaimRecordIds,
        provenanceArtifacts: uniqueSortedArtifactReferences(
          orderedRecords.flatMap((record) => record.provenanceArtifacts),
        ),
      };
    })
    .sort((left, right) =>
      compareCodeUnits(left.candidateId, right.candidateId),
    );
}

function rankCandidates(
  candidates: readonly DiscoverClaimCandidate[],
  cap: number,
): DiscoverArtifactPayload["candidateDispositions"] {
  const bySeed = new Map<string, DiscoverClaimCandidate[]>();
  for (const candidate of candidates) {
    const seedCandidates = bySeed.get(candidate.seedId);
    if (seedCandidates) {
      seedCandidates.push(candidate);
    } else {
      bySeed.set(candidate.seedId, [candidate]);
    }
  }

  return [...bySeed.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .flatMap(([, seedCandidates]) =>
      [...seedCandidates]
        .sort((left, right) => {
          const recordDifference =
            right.sourceClaimRecordIds.length -
            left.sourceClaimRecordIds.length;
          if (recordDifference !== 0) return recordDifference;
          const mentionDifference =
            right.memberMentionIds.length - left.memberMentionIds.length;
          if (mentionDifference !== 0) return mentionDifference;
          return compareCodeUnits(left.candidateId, right.candidateId);
        })
        .map((candidate, index) => {
          const rank = index + 1;
          const selectedForScope = index < cap;
          return {
            candidateId: candidate.candidateId,
            selectedForScope,
            rank,
            reason: selectedForScope
              ? `Selected for Scope at deterministic rank ${String(rank)} within cap ${String(cap)}`
              : `Retained but deferred from Scope at deterministic rank ${String(rank)} beyond cap ${String(cap)}`,
          };
        }),
    );
}

function createCitationOccurrence(input: {
  seedId: string;
  citedPaperId: string;
  citingPaperRecordId: string;
  citingPaperId: string;
  mention: z.infer<typeof harvestedMentionInputSchema>;
}): DiscoverCitationOccurrence {
  const identity = {
    seedId: input.seedId,
    citingPaperRecordId: input.citingPaperRecordId,
    citingPaperId: input.citingPaperId,
    citedPaperId: input.citedPaperId,
    mentionIndex: input.mention.mentionIndex,
    ...(input.mention.refId ? { refId: input.mention.refId } : {}),
    ...(input.mention.charOffsetStart != null
      ? { charOffsetStart: input.mention.charOffsetStart }
      : {}),
    ...(input.mention.charOffsetEnd != null
      ? { charOffsetEnd: input.mention.charOffsetEnd }
      : {}),
    ...(input.mention.sourceLocator
      ? { sourceLocator: input.mention.sourceLocator }
      : {}),
    citationMarker: input.mention.citationMarker,
    rawContext: input.mention.rawContext,
  };
  const identityStrength =
    input.mention.charOffsetStart != null && input.mention.charOffsetEnd != null
      ? "strong_source_offsets"
      : input.mention.sourceLocator
        ? "strong_source_locator"
        : "weak_context_fallback";
  return {
    mentionId: buildCitationOccurrenceId(identity),
    ...identity,
    identityStrength,
    ...(input.mention.sectionTitle
      ? { sectionTitle: input.mention.sectionTitle }
      : {}),
    ...(input.mention.seedRefLabel
      ? { seedRefLabel: input.mention.seedRefLabel }
      : {}),
    isBundledCitation: input.mention.isBundledCitation,
    bundleSize: input.mention.bundleSize,
    bundleRefIds: input.mention.bundleRefIds,
    bundlePattern: input.mention.bundlePattern,
    observationProvenance: {
      sourceType: input.mention.sourceType,
      parser: input.mention.parser,
      ...(input.mention.parserVersion
        ? { parserVersion: input.mention.parserVersion }
        : {}),
      artifacts: input.mention.provenanceArtifacts,
    },
  };
}

function comparePaperProbePriority(
  left: {
    citingPaperRecordId: string;
    providerPosition: number;
    paper: z.infer<typeof citingPaperInputSchema>;
  },
  right: {
    citingPaperRecordId: string;
    providerPosition: number;
    paper: z.infer<typeof citingPaperInputSchema>;
  },
): number {
  const availabilityOrder = {
    available: 0,
    unknown: 1,
    abstract_only: 2,
    unavailable: 3,
  } as const;
  const availabilityDifference =
    availabilityOrder[left.paper.fullTextAvailability] -
    availabilityOrder[right.paper.fullTextAvailability];
  if (availabilityDifference !== 0) return availabilityDifference;
  if (left.providerPosition !== right.providerPosition) {
    return left.providerPosition - right.providerPosition;
  }
  return compareCodeUnits(left.citingPaperRecordId, right.citingPaperRecordId);
}

function validateNeighborhoodBoundary(
  result: CanonicalNeighborhoodResult & { status: "completed" },
  configuredLimit: number,
): void {
  if (result.papers.length > configuredLimit) {
    throw new CanonicalDiscoverBoundaryError(
      `Citing-neighborhood adapter returned ${String(result.papers.length)} papers beyond configured limit ${String(configuredLimit)}`,
    );
  }
  if (
    result.providerReportedTotal != null &&
    result.providerReportedTotal < result.papers.length
  ) {
    throw new CanonicalDiscoverBoundaryError(
      "Provider-reported total is smaller than the returned citing-paper count",
    );
  }
  const duplicateProviderRecordId = findDuplicate(
    result.papers.map((paper) => paper.providerRecordId),
  );
  if (duplicateProviderRecordId) {
    throw new CanonicalDiscoverBoundaryError(
      `Citing-neighborhood adapter returned duplicate provider record ID: ${duplicateProviderRecordId}`,
    );
  }
}

function assertUniqueSeedDois(
  seeds: readonly CanonicalDiscoverOptions["seeds"][number][],
): void {
  const duplicate = findDuplicate(seeds.map((seed) => buildSeedId(seed)));
  if (duplicate) {
    throw new CanonicalDiscoverBoundaryError(
      `Canonical Discover input repeats the same normalized seed DOI: ${duplicate}`,
    );
  }
}

function throwIfFatal(input: {
  reasonCode?: CanonicalDiscoverFailureCode | undefined;
  reason?: string | undefined;
}): void {
  if (
    input.reasonCode != null &&
    fatalProviderFailureCodeSchema.safeParse(input.reasonCode).success
  ) {
    throw new CanonicalDiscoverFatalError(
      fatalProviderFailureCodeSchema.parse(input.reasonCode),
      input.reason ?? input.reasonCode,
    );
  }
}

function parseAdapterOutput<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new CanonicalDiscoverBoundaryError(
    `Invalid ${label} adapter output at ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? parsed.error.message}`,
  );
}

function uniqueSortedArtifactReferences(
  references: readonly ArtifactReference[],
): ArtifactReference[] {
  return uniqueSorted(references);
}

function uniqueSorted<T>(values: readonly T[]): T[] {
  const byCanonicalValue = new Map<string, T>();
  for (const value of values) {
    byCanonicalValue.set(canonicalSerialize(value), value);
  }
  return [...byCanonicalValue.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, value]) => value);
}

function findDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
