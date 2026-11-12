import { z } from "zod";

import { uniqueSortedArtifactReferences } from "../contract/lean-artifact-primitives.js";
import { createBoundaryParser } from "../shared/boundary.js";
import { pMap } from "../shared/concurrency.js";
import { compareCodeUnits, uniqueSorted } from "../shared/order.js";
import { findDuplicate } from "../contract/artifacts/checks.js";

import { normalizeDiscoverClaimText } from "../contract/claim-unit.js";

import {
  candidateSelectionPolicySchema,
  selectCandidates,
} from "../contract/candidate-selection-policy.js";
import { paperTypeSchema } from "../domain/common.js";
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
  sha256DigestSchema,
  type AppendOnlyDecision,
  type ArtifactReference,
  type DiscoverArtifact,
  type DiscoverArtifactPayload,
  type DiscoverAttributedClaimRecord,
  type DiscoverCitationOccurrence,
  type DiscoverCitingPaperRecord,
  type DiscoverClaimCandidate,
  type DiscoverProbeStratum,
  isInSamplingFrame,
  type LeanArtifactProvenance,
  probeStratumKeyOf,
  probeTypeGroupOf,
  type ProbeTypeGroup,
} from "../contract/lean-artifacts.js";
import {
  modelExecutionSchema,
  type ModelExecution,
} from "../contract/model-execution.js";
import { verifyClaimSupportSpan } from "../shared/claim-support-span.js";
import { canonicalSerialize } from "../shared/stable-identity.js";
import { clusterSeedClaims, type ClaimGroup } from "./claim-clustering.js";

const fatalProviderFailureCodeSchema = z.enum([
  "authentication",
  "authorization",
  "billing",
  "quota",
]);

const canonicalDiscoverFailureCodeSchema = z.union([
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

const canonicalDiscoverOptionsSchema = z
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
    /** Citing works to probe; `"all"` probes the whole enumerated neighborhood. */
    probeBudget: z.union([z.number().int().nonnegative(), z.literal("all")]),
    candidateSelection: candidateSelectionPolicySchema,
    recordedAt: z.string().datetime({ offset: true }),
    /** Model requests in flight at once; results keep input order. */
    concurrency: z.number().int().positive().optional(),
    /** Citing papers harvested at once; results keep neighborhood order. */
    fetchConcurrency: z.number().int().positive().optional(),
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
    paperType: paperTypeSchema.optional(),
    referencedWorksCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const canonicalSeedResolutionResultSchema = z.discriminatedUnion("status", [
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
]);
type CanonicalSeedResolutionResult = z.infer<
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
    paperType: paperTypeSchema.optional(),
    referencedWorksCount: z.number().int().nonnegative().optional(),
    fullTextAvailability: z.enum([
      "available",
      "abstract_only",
      "unavailable",
      "unknown",
    ]),
    provenanceArtifacts: z.array(artifactReferenceSchema).min(1),
  })
  .strict();

const canonicalNeighborhoodResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      providerReportedTotal: z.number().int().nonnegative().optional(),
      coverage: z.enum(["complete", "truncated", "unknown"]),
      papers: z.array(citingPaperInputSchema),
      execution: externalExecutionSchema,
      /** Per-page request/response provenance when the provider paginates. */
      pageArtifacts: z.array(artifactReferenceSchema).optional(),
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
]);
type CanonicalNeighborhoodResult = z.infer<
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
    targetRefIds: z.array(z.string().min(1)).default([]),
    charOffsetStart: z.number().int().nonnegative().optional(),
    charOffsetEnd: z.number().int().nonnegative().optional(),
    sourceLocator: citationSourceLocatorSchema.optional(),
    citationGroupOrdinal: z.number().int().nonnegative().optional(),
    locationQuality: z.enum(["exact_dom", "approximate", "missing"]).optional(),
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
        .extend({
          status: z.literal("no_mentions"),
          /**
           * Why a materialized paper yielded nothing: the seed was not in its
           * bibliography at all, or was there but never cited in the text.
           * The Report counts harvest losses by this code.
           */
          reasonCode: z.enum(["not_found", "no_in_text_mentions"]),
        })
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
    /** How the text was obtained; absent when materialization did not succeed. */
    acquisition: z
      .object({
        accessChannel: z.enum(["open_access", "institutional_proxy"]),
        fullTextFormat: z.string().min(1).optional(),
        selectedUrl: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /** Which bibliography entry was taken to be the seed, and how. */
    bibliographyMatch: z
      .object({
        method: z.enum([
          "doi",
          "author_year_exact_title",
          "author_year_title_overlap",
        ]),
        refId: z.string().min(1),
      })
      .strict()
      .optional(),
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
        execution: modelExecutionSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        reasonCode: canonicalDiscoverFailureCodeSchema,
        reason: z.string().min(1),
        execution: modelExecutionSchema,
      })
      .strict(),
  ],
);
/**
 * Cross-citer claim equivalence. One call per seed clusters the extracted
 * claims that attribute the same underlying seed finding, so a family is one
 * finding rather than one wording. Differences in strength, scope, or
 * certainty stay inside a cluster; they are what Adjudicate measures.
 */
export const canonicalClaimCanonicalizationResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("completed"),
        clusters: z.array(
          z
            .object({
              canonicalClaim: z.string().trim().min(1),
              claimRecordIds: z.array(z.string().min(1)).min(1),
            })
            .strict(),
        ),
        execution: modelExecutionSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        reasonCode: canonicalDiscoverFailureCodeSchema,
        reason: z.string().min(1),
        execution: modelExecutionSchema,
      })
      .strict(),
  ],
);

export type CanonicalClaimCanonicalizationInput = {
  seed: CanonicalSeedResolutionResult & { status: "resolved" };
  claims: Array<{
    claimRecordId: string;
    extractedClaimText: string;
    citingPaperTitle: string;
    sectionTitle?: string | undefined;
  }>;
};

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
  /** Optional; without it candidates group by exact normalized text only. */
  canonicalizeClaims?: (
    input: CanonicalClaimCanonicalizationInput,
  ) => Promise<unknown>;
};

type CanonicalDiscoverProvenanceInputs = {
  inputArtifacts: ArtifactReference[];
  prompts: LeanArtifactProvenance["prompts"];
  models: LeanArtifactProvenance["models"];
  responseArtifacts: ArtifactReference[];
};

export type CanonicalDiscoverResult = {
  payload: DiscoverArtifactPayload;
  decisions: AppendOnlyDecision[];
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
  const pendingExtractions: Array<{
    seedId: string;
    request: Parameters<
      CanonicalDiscoverAdapters["extractAttributedClaims"]
    >[0];
  }> = [];
  const decisions: AppendOnlyDecision[] = [];
  const inputArtifacts: ArtifactReference[] = [];
  const responseArtifacts: ArtifactReference[] = [];
  const prompts: LeanArtifactProvenance["prompts"] = [];
  const models: LeanArtifactProvenance["models"] = [];
  const resolvedSeedsById = new Map<
    string,
    CanonicalSeedResolutionResult & { status: "resolved" }
  >();

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
    if (resolution.status === "resolved") {
      resolvedSeedsById.set(seedId, resolution);
    }

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
        probeStrata: [],
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
        probeStrata: [],
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
    const pageArtifacts = neighborhood.pageArtifacts ?? [];
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
    const probeSelection = selectDeterministicProbeSet(
      paperObservations,
      options.probeBudget === "all"
        ? paperObservations.length
        : options.probeBudget,
    );
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
      probeStrata: probeSelection.strata,
      requestHash: neighborhood.execution.requestHash,
      requestArtifact: neighborhood.execution.requestArtifact,
      responseArtifact: neighborhood.execution.responseArtifact,
      provenanceArtifacts: uniqueSortedArtifactReferences([
        neighborhood.execution.requestArtifact,
        neighborhood.execution.responseArtifact,
        ...pageArtifacts,
      ]),
    });
    responseArtifacts.push(...pageArtifacts);

    // Fetching and parsing citing papers dominates Discover's wall time on a
    // large neighborhood, so probed papers are harvested side by side. pMap
    // returns results in neighborhood order, and everything below appends
    // in that order, so the artifact is identical at any concurrency.
    const harvests = await pMap(
      paperObservations,
      async (observation) => {
        if (!probeSelection.selectedIds.has(observation.citingPaperRecordId)) {
          return undefined;
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
        return harvest;
      },
      { concurrency: options.fetchConcurrency ?? 1 },
    );

    for (const [observationIndex, observation] of paperObservations.entries()) {
      const isSelected = probeSelection.selectedIds.has(
        observation.citingPaperRecordId,
      );
      const stratum = probeSelection.stratumById.get(
        observation.citingPaperRecordId,
      )!;
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
          ...(observation.paper.paperType
            ? { paperType: observation.paper.paperType }
            : {}),
          ...(observation.paper.referencedWorksCount != null
            ? {
                referencedWorksCount: observation.paper.referencedWorksCount,
              }
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
          stratum,
          reason: probeReason({
            isSelected,
            inFrame: isInSamplingFrame(observation.paper.fullTextAvailability),
            stratumKey: probeStratumKeyOf(stratum),
          }),
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

      const harvest = harvests[observationIndex];
      if (!isSelected || harvest == null) {
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
        ...(harvest.acquisition ? { acquisition: harvest.acquisition } : {}),
        ...(harvest.bibliographyMatch
          ? { bibliographyMatch: harvest.bibliographyMatch }
          : {}),
        materialization: harvest.materialization,
        harvest: {
          ...harvest.harvest,
          observedMentionCount: paperMentions.length,
        },
      });

      pendingExtractions.push(
        ...paperMentions.map((mention) => ({
          seedId,
          request: {
            seed: resolution,
            citingPaper: observation.paper,
            mention,
          },
        })),
      );
    }
  }

  // Extraction fans out only after every paper is harvested, with its own
  // model bound. Results keep input order, so the artifact is the same at any
  // concurrency.
  const extractions = await pMap(
    pendingExtractions,
    async ({ seedId, request }) => {
      const extraction = parseAdapterOutput(
        canonicalClaimExtractionResultSchema,
        await adapters.extractAttributedClaims(request),
        `attributed-claim extraction for ${request.mention.mentionId}`,
      );
      throwIfFatal(extraction);
      return { seedId, mention: request.mention, extraction };
    },
    { concurrency: options.concurrency ?? 1 },
  );
  for (const { seedId, mention, extraction } of extractions) {
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
        execution,
      });
      continue;
    }

    const records = buildAttributedClaimRecords({
      claims: extraction.claims,
      seedId,
      mentionId: mention.mentionId,
      extractionId,
      rawContext: mention.rawContext,
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
      execution,
    });
  }

  const citingTitleByMentionId = new Map<string, string>();
  const sectionByMentionId = new Map<string, string | undefined>();
  const citingPaperById = new Map(
    citingPapers.map((paper) => [paper.citingPaperRecordId, paper]),
  );
  for (const mention of citationMentions) {
    citingTitleByMentionId.set(
      mention.mentionId,
      citingPaperById.get(mention.citingPaperRecordId)?.paper.title ?? "",
    );
    sectionByMentionId.set(mention.mentionId, mention.sectionTitle);
  }
  const claimGroups = await buildClaimGroups({
    records: attributedClaimRecords,
    resolvedSeedsById,
    adapters,
    concurrency: options.concurrency ?? 1,
    describeClaim: (record) => ({
      claimRecordId: record.claimRecordId,
      extractedClaimText: record.extractedClaimText,
      citingPaperTitle: citingTitleByMentionId.get(record.mentionId) ?? "",
      sectionTitle: sectionByMentionId.get(record.mentionId),
    }),
    onExecution: (execution) => {
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
    },
  });
  const claimCandidates = buildClaimCandidates(claimGroups);
  const candidateDispositions = selectCandidates({
    candidates: claimCandidates,
    mentions: citationMentions,
    claims: attributedClaimRecords,
    policy: options.candidateSelection,
  });
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
          identifier: "canonical-discover-adaptive-portfolio-v3",
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
      implementation: input.implementation ?? "canonical-discover-v2",
      replayableFromInputs: false,
      responseArtifacts: input.result.provenanceInputs.responseArtifacts,
    },
    decisions: input.result.decisions,
    payload: input.result.payload,
  });
  return discoverArtifactSchema.parse(artifact);
}

function buildAttributedClaimRecords(input: {
  claims: z.infer<typeof extractedClaimInputSchema>[];
  seedId: string;
  mentionId: string;
  extractionId: string;
  rawContext: string;
  provenanceArtifacts: ArtifactReference[];
}): DiscoverAttributedClaimRecord[] {
  const indexedClaims = input.claims.map((claim, sourceClaimIndex) => {
    const supportSpan = verifyClaimSupportSpan(
      input.rawContext,
      claim.supportSpanText,
    );
    return {
      claim,
      supportSpan,
      sourceClaimIndex,
      normalizedClaim: normalizeDiscoverClaimText(claim.text),
    };
  });
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
        canonicalSerialize(
          claimDuplicateOrderingContent(left.claim, left.supportSpan?.text),
        ),
        canonicalSerialize(
          claimDuplicateOrderingContent(right.claim, right.supportSpan?.text),
        ),
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
    ({
      claim,
      supportSpan,
      sourceClaimIndex,
    }): DiscoverAttributedClaimRecord => {
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
        ...(supportSpan ? { supportSpan } : {}),
        ...(claim.confidence ? { confidence: claim.confidence } : {}),
        provenanceArtifacts: input.provenanceArtifacts,
      };
    },
  );
}

function claimDuplicateOrderingContent(
  claim: z.infer<typeof extractedClaimInputSchema>,
  verifiedSupportSpanText: string | undefined,
) {
  return {
    originalClaimText: claim.text,
    supportSpanText: verifiedSupportSpanText ?? claim.supportSpanText,
    confidence: claim.confidence,
  };
}

async function buildClaimGroups(input: {
  records: readonly DiscoverAttributedClaimRecord[];
  resolvedSeedsById: ReadonlyMap<
    string,
    CanonicalSeedResolutionResult & { status: "resolved" }
  >;
  adapters: CanonicalDiscoverAdapters;
  describeClaim: (
    record: DiscoverAttributedClaimRecord,
  ) => CanonicalClaimCanonicalizationInput["claims"][number];
  concurrency: number;
  onExecution: (execution: ModelExecution) => void;
}): Promise<ClaimGroup[]> {
  const recordsBySeed = new Map<string, DiscoverAttributedClaimRecord[]>();
  for (const record of input.records) {
    const list = recordsBySeed.get(record.seedId);
    if (list) list.push(record);
    else recordsBySeed.set(record.seedId, [record]);
  }

  const groups: ClaimGroup[] = [];
  for (const seedId of [...recordsBySeed.keys()].sort(compareCodeUnits)) {
    const seed = input.resolvedSeedsById.get(seedId);
    const canonicalize = input.adapters.canonicalizeClaims;
    groups.push(
      ...(await clusterSeedClaims({
        records: recordsBySeed.get(seedId)!,
        call:
          canonicalize && seed
            ? async (records) => {
                const result = parseAdapterOutput(
                  canonicalClaimCanonicalizationResultSchema,
                  await canonicalize({
                    seed,
                    claims: records.map(input.describeClaim),
                  }),
                  `claim canonicalization for ${seedId}`,
                );
                if (result.status === "failed") throwIfFatal(result);
                return result;
              }
            : undefined,
        concurrency: input.concurrency,
        onExecution: input.onExecution,
      })),
    );
  }
  return groups;
}

function buildClaimCandidates(
  groups: readonly ClaimGroup[],
): DiscoverClaimCandidate[] {
  return groups
    .map((group): DiscoverClaimCandidate => {
      const normalizedClaim = normalizeDiscoverClaimText(group.canonicalClaim);
      const sourceClaimRecordIds = group.records.map(
        (record) => record.claimRecordId,
      );
      const memberMentionIds = [
        ...new Set(group.records.map((record) => record.mentionId)),
      ].sort(compareCodeUnits);
      return {
        candidateId: buildClaimCandidateId({
          seedId: group.seedId,
          normalizedClaim,
          sourceClaimRecordIds,
        }),
        seedId: group.seedId,
        canonicalClaim: group.canonicalClaim,
        normalizedClaim,
        memberMentionIds,
        sourceClaimRecordIds,
        provenanceArtifacts: uniqueSortedArtifactReferences(
          group.records.flatMap((record) => record.provenanceArtifacts),
        ),
        equivalence: group.equivalence,
      };
    })
    .sort((left, right) =>
      compareCodeUnits(left.candidateId, right.candidateId),
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
  return {
    mentionId: buildCitationOccurrenceId(identity),
    ...identity,
    targetRefIds:
      input.mention.targetRefIds.length > 0
        ? input.mention.targetRefIds
        : input.mention.refId
          ? [input.mention.refId]
          : [],
    ...(input.mention.citationGroupOrdinal != null
      ? { citationGroupOrdinal: input.mention.citationGroupOrdinal }
      : {}),
    locationQuality: input.mention.locationQuality ?? "missing",
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

/**
 * Deterministic 5-year publication band, e.g. "2020-2024". Papers with no
 * known publication year fall into a distinct "unknown" band rather than
 * being silently dropped from stratification.
 */
function probeYearBand(publicationYear: number | undefined): string {
  if (publicationYear == null) return "unknown";
  const bandStart = Math.floor(publicationYear / 5) * 5;
  return `${String(bandStart)}-${String(bandStart + 4)}`;
}

type ProbeStratum = { yearBand: string; typeGroup: ProbeTypeGroup };

function probeStratumOf(paper: {
  publicationYear?: number | undefined;
  paperType?: string | undefined;
}): ProbeStratum {
  return {
    yearBand: probeYearBand(paper.publicationYear),
    typeGroup: probeTypeGroupOf(paper.paperType),
  };
}

type ProbeObservation = {
  citingPaperRecordId: string;
  providerPosition: number;
  paper: z.infer<typeof citingPaperInputSchema>;
};

/**
 * Select which enumerated citing papers to probe within `probeBudget`.
 *
 * Inference covers the sampling frame (`isInSamplingFrame`), stratified by
 * year band × type group. `allocateProbes` splits the budget across the
 * frame's strata, and each stratum takes its papers in record-ID order: the
 * record ID is a content hash, so that is a fixed pseudo-random order, where
 * the provider's own order is skewed (OpenAlex returns older citers first).
 * Budget left once the whole frame is probed goes to papers outside it,
 * abstract-only before closed; they add records but carry no weight.
 */
function selectDeterministicProbeSet<T extends ProbeObservation>(
  observations: readonly T[],
  probeBudget: number,
): {
  selectedIds: Set<string>;
  stratumById: Map<string, ProbeStratum>;
  strata: DiscoverProbeStratum[];
} {
  const byRecordId = [...observations].sort((left, right) =>
    compareCodeUnits(left.citingPaperRecordId, right.citingPaperRecordId),
  );
  const stratumById = new Map(
    byRecordId.map((observation) => [
      observation.citingPaperRecordId,
      probeStratumOf(observation.paper),
    ]),
  );
  const frameByStratum = new Map<string, T[]>();
  const outsideFrame: T[] = [];
  for (const observation of byRecordId) {
    if (!isInSamplingFrame(observation.paper.fullTextAvailability)) {
      outsideFrame.push(observation);
      continue;
    }
    const key = probeStratumKeyOf(
      stratumById.get(observation.citingPaperRecordId)!,
    );
    const members = frameByStratum.get(key) ?? [];
    members.push(observation);
    frameByStratum.set(key, members);
  }

  const allocation = allocateProbes(
    new Map([...frameByStratum].map(([key, members]) => [key, members.length])),
    probeBudget,
  );
  const selected = [...frameByStratum].flatMap(([key, members]) =>
    members.slice(0, allocation.get(key) ?? 0),
  );
  // Leftover budget goes to abstract-only papers before closed ones, as the
  // likelier to yield text; the sort is stable, so record-ID order holds
  // within each.
  const leftoverRank = (observation: T): number =>
    observation.paper.fullTextAvailability === "abstract_only" ? 0 : 1;
  outsideFrame.sort((left, right) => leftoverRank(left) - leftoverRank(right));
  selected.push(...outsideFrame.slice(0, probeBudget - selected.length));
  const selectedIds = new Set(
    selected.map((observation) => observation.citingPaperRecordId),
  );
  return {
    selectedIds,
    stratumById,
    strata: summarizeProbeStrata(byRecordId, selectedIds),
  };
}

function probeReason(input: {
  isSelected: boolean;
  inFrame: boolean;
  stratumKey: string;
}): string {
  if (input.inFrame) {
    return input.isSelected
      ? `Selected within stratum ${input.stratumKey}'s share of the probe budget.`
      : `Not selected: stratum ${input.stratumKey}'s share of the probe budget was used.`;
  }
  return input.isSelected
    ? "Selected with budget left after the whole sampling frame was probed; outside the frame (provider marks no readable full text), so it carries no weight."
    : "Not selected: outside the sampling frame (provider marks no readable full text), and no budget was left after the frame.";
}

/**
 * Split `budget` probes across strata of the given frame sizes, one probe at
 * a time, each to the stratum where a probed paper would otherwise stand for
 * the most papers: an unprobed stratum first, then the largest size / probes.
 * So every stratum gets a probe before any gets a second, and the weights
 * 1/π end up as even as the budget allows. Ties go to the larger stratum,
 * then key order; no stratum gets more probes than it has papers.
 */
export function allocateProbes(
  sizes: ReadonlyMap<string, number>,
  budget: number,
): Map<string, number> {
  const keys = [...sizes.keys()].sort(compareCodeUnits);
  const total = keys.reduce((sum, key) => sum + sizes.get(key)!, 0);
  if (budget >= total) {
    return new Map(keys.map((key) => [key, sizes.get(key)!]));
  }

  const probes = new Map(keys.map((key) => [key, 0]));
  // Negative when `left` should take the next probe before `right`. Shares
  // size / probes are compared by cross-multiplying, so nothing divides by 0.
  const comparePriority = (left: string, right: string): number => {
    const leftSize = sizes.get(left)!;
    const rightSize = sizes.get(right)!;
    const leftProbes = probes.get(left)!;
    const rightProbes = probes.get(right)!;
    if ((leftProbes === 0) !== (rightProbes === 0)) {
      return leftProbes === 0 ? -1 : 1;
    }
    const byShare = rightSize * leftProbes - leftSize * rightProbes;
    if (byShare !== 0) return byShare;
    if (leftSize !== rightSize) return rightSize - leftSize;
    return compareCodeUnits(left, right);
  };

  for (let remaining = budget; remaining > 0; remaining -= 1) {
    let next: string | undefined;
    for (const key of keys) {
      if (probes.get(key)! >= sizes.get(key)!) continue;
      if (next === undefined || comparePriority(key, next) < 0) next = key;
    }
    if (next === undefined) break;
    probes.set(next, probes.get(next)! + 1);
  }
  return probes;
}

/**
 * Each stratum's enumerated, frame and probed counts, and the inclusion
 * probability probedFrameCount / frameCount that Report weights records by.
 */
function summarizeProbeStrata(
  observations: readonly ProbeObservation[],
  selectedIds: ReadonlySet<string>,
): DiscoverProbeStratum[] {
  const strata = new Map<string, DiscoverProbeStratum>();
  for (const observation of observations) {
    const stratum = probeStratumOf(observation.paper);
    const key = probeStratumKeyOf(stratum);
    const bucket = strata.get(key) ?? {
      ...stratum,
      enumeratedCount: 0,
      frameCount: 0,
      probedCount: 0,
      probedFrameCount: 0,
      inclusionProbability: null,
    };
    const inFrame = isInSamplingFrame(observation.paper.fullTextAvailability);
    const probed = selectedIds.has(observation.citingPaperRecordId);
    bucket.enumeratedCount += 1;
    if (inFrame) bucket.frameCount += 1;
    if (probed) bucket.probedCount += 1;
    if (inFrame && probed) bucket.probedFrameCount += 1;
    strata.set(key, bucket);
  }
  return [...strata.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, bucket]) => ({
      ...bucket,
      inclusionProbability:
        bucket.frameCount === 0
          ? null
          : bucket.probedFrameCount / bucket.frameCount,
    }));
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
  reasonCode?: string | undefined;
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

const parseAdapterOutput = createBoundaryParser(CanonicalDiscoverBoundaryError);
