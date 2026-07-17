import { z } from "zod";

import {
  buildScopedFamilyId,
  createAppendOnlyDecision,
  createLeanStageArtifact,
  discoverArtifactSchema,
  leanArtifactSchemaVersion,
  leanArtifactVersion,
  scopeArtifactPayloadSchema,
  scopeArtifactSchema,
  scopeFailureCodeSchema,
  scopeFatalFailureCodeSchema,
  scopeGroundingModelExecutionSchema,
  scopeNonfatalFailureCodeSchema,
  scopeSeedMaterializationSchema,
  type AppendOnlyDecision,
  type AppendOnlyExclusion,
  type ArtifactReference,
  type DiscoverArtifact,
  type DiscoverClaimCandidate,
  type DiscoverSeed,
  type LeanArtifactProvenance,
  type ScopeArtifact,
  type ScopeArtifactPayload,
  type ScopeCandidateDecision,
  type ScopeGrounding,
  type ScopeGroundingModelExecution,
  type ScopeNonfatalFailureCode,
  type ScopeSeedMaterialization,
  type ScopeVerifiedEvidenceSpan,
} from "../contract/lean-artifacts.js";
import { canonicalSerialize } from "../shared/stable-identity.js";

export const canonicalScopeOptionsSchema = z
  .object({
    recordedAt: z.string().datetime({ offset: true }),
    discoverArtifactUri: z.string().min(1).optional(),
  })
  .strict();
export type CanonicalScopeOptions = z.infer<typeof canonicalScopeOptionsSchema>;

export const canonicalScopeSeedMaterializationResultSchema =
  scopeSeedMaterializationSchema;
export type CanonicalScopeSeedMaterializationResult = z.infer<
  typeof canonicalScopeSeedMaterializationResultSchema
>;

const groundingSupportSpanOutputSchema = z
  .object({
    verbatimQuote: z.string().min(1),
    blockId: z.string().min(1),
  })
  .strict();

export const canonicalScopeGroundingOutputSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("grounded"),
        detailReason: z.string().min(1),
        supportSpans: z.array(groundingSupportSpanOutputSchema).min(1),
      })
      .strict(),
    z
      .object({
        status: z.literal("ambiguous"),
        detailReason: z.string().min(1),
        supportSpans: z.array(groundingSupportSpanOutputSchema).min(1),
      })
      .strict(),
    z
      .object({
        status: z.literal("not_found"),
        detailReason: z.string().min(1),
        supportSpans: z.array(groundingSupportSpanOutputSchema).length(0),
      })
      .strict(),
  ],
);
export type CanonicalScopeGroundingOutput = z.infer<
  typeof canonicalScopeGroundingOutputSchema
>;

export const canonicalScopeGroundingResultSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("completed"),
        rawOutput: z.unknown(),
        execution: scopeGroundingModelExecutionSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        reasonCode: scopeFailureCodeSchema,
        reason: z.string().min(1),
        execution: scopeGroundingModelExecutionSchema,
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if (
      result.status === "completed" &&
      !Object.prototype.hasOwnProperty.call(result, "rawOutput")
    ) {
      context.addIssue({
        code: "custom",
        path: ["rawOutput"],
        message: "Completed grounding requires the exact parsed model output",
      });
    }
  });
export type CanonicalScopeGroundingResult = z.infer<
  typeof canonicalScopeGroundingResultSchema
>;

export type CanonicalScopeFamilyInput = {
  familyId: string;
  seedId: string;
  candidateIds: string[];
  sourceClaimRecordIds: string[];
  trackedClaim: string;
  normalizedClaim: string;
  includedCitationOccurrenceIds: string[];
};

export type CanonicalScopeAdapters = {
  materializeSeed: (input: { seed: DiscoverSeed }) => Promise<unknown>;
  groundFamily: (input: {
    seed: DiscoverSeed;
    family: CanonicalScopeFamilyInput;
    seedText: ScopeSeedMaterialization & { status: "materialized" };
  }) => Promise<unknown>;
};

export type CanonicalScopeProvenanceInputs = {
  prompts: LeanArtifactProvenance["prompts"];
  models: LeanArtifactProvenance["models"];
  responseArtifacts: ArtifactReference[];
};

export type CanonicalScopeResult = {
  payload: ScopeArtifactPayload;
  decisions: AppendOnlyDecision[];
  exclusions: AppendOnlyExclusion[];
  provenanceInputs: CanonicalScopeProvenanceInputs;
};

export class CanonicalScopeBoundaryError extends Error {
  override readonly name = "CanonicalScopeBoundaryError";
}

export class CanonicalScopeFatalError extends Error {
  override readonly name = "CanonicalScopeFatalError";

  constructor(
    readonly failureCode: z.infer<typeof scopeFatalFailureCodeSchema>,
    message: string,
  ) {
    super(message);
  }
}

type FamilyConstruction = CanonicalScopeFamilyInput & {
  candidates: DiscoverClaimCandidate[];
};

export async function runCanonicalScope(
  discoverArtifactInput: unknown,
  adapters: CanonicalScopeAdapters,
  optionsInput: CanonicalScopeOptions,
): Promise<CanonicalScopeResult> {
  const discoverArtifact = parseBoundary(
    discoverArtifactSchema,
    discoverArtifactInput,
    "canonical Discover input",
  );
  const options = parseBoundary(
    canonicalScopeOptionsSchema,
    optionsInput,
    "canonical Scope options",
  );
  const discoverReference = buildDiscoverReference(
    discoverArtifact,
    options.discoverArtifactUri,
  );
  const { familyConstructions, candidateDecisions } =
    buildFamilyConstructions(discoverArtifact);

  const decisions = candidateDecisions.map((candidate) =>
    createAppendOnlyDecision({
      recordId: candidate.candidateId,
      decisionType: "scope_candidate_disposition",
      outcome:
        candidate.disposition === "scoped" ? "scoped" : "deferred_upstream",
      reason: candidate.discoverReason,
      recordedAt: options.recordedAt,
      actor: {
        kind: "deterministic",
        identifier: "canonical-scope-membership-freeze-v1",
      },
      evidenceArtifacts: [discoverReference],
    }),
  );
  const prompts: LeanArtifactProvenance["prompts"] = [];
  const models: LeanArtifactProvenance["models"] = [];
  const responseArtifacts: ArtifactReference[] = [];
  const materializationsBySeedId = new Map<string, ScopeSeedMaterialization>();
  const selectedSeedIds = [
    ...new Set(familyConstructions.map((construction) => construction.seedId)),
  ].sort(compareCodeUnits);

  for (const seedId of selectedSeedIds) {
    const seed = discoverArtifact.payload.seeds.find(
      (entry) => entry.seedId === seedId,
    );
    if (!seed) {
      throw new CanonicalScopeBoundaryError(
        `Selected Scope family references an unknown Discover seed: ${seedId}`,
      );
    }
    const materialization = parseBoundary(
      canonicalScopeSeedMaterializationResultSchema,
      await adapters.materializeSeed({ seed }),
      `seed materialization for ${seedId}`,
    );
    if (materialization.seedId !== seedId) {
      throw new CanonicalScopeBoundaryError(
        `Seed materialization returned ${materialization.seedId} for ${seedId}`,
      );
    }
    throwIfFatal(materialization);
    materializationsBySeedId.set(seedId, materialization);
    responseArtifacts.push(...executionResponseArtifacts(materialization));
  }

  const families: ScopeArtifactPayload["families"] = [];
  for (const construction of familyConstructions) {
    const seed = discoverArtifact.payload.seeds.find(
      (entry) => entry.seedId === construction.seedId,
    );
    const materialization = materializationsBySeedId.get(construction.seedId);
    if (!seed || !materialization) {
      throw new Error(
        "Scope family construction lost its seed materialization",
      );
    }

    let grounding: ScopeGrounding;
    const groundingArtifacts: ArtifactReference[] = [];
    if (materialization.status !== "materialized") {
      grounding = {
        status: materialization.status,
        detailReason: materialization.reason,
        evidenceSpans: [],
        quoteVerification: {
          status: "not_applicable",
          failures: [],
        },
      };
    } else {
      const groundingResult = parseBoundary(
        canonicalScopeGroundingResultSchema,
        await adapters.groundFamily({
          seed,
          family: construction,
          seedText: materialization,
        }),
        `claim grounding for ${construction.familyId}`,
      );
      if (groundingResult.status === "failed") {
        throwIfFatal(groundingResult);
      }
      recordModelExecution(
        groundingResult.execution,
        prompts,
        models,
        responseArtifacts,
      );
      groundingArtifacts.push(
        groundingResult.execution.requestArtifact,
        groundingResult.execution.responseArtifact,
      );
      grounding =
        groundingResult.status === "failed"
          ? failedGrounding(
              groundingResult.execution,
              parseBoundary(
                scopeNonfatalFailureCodeSchema,
                groundingResult.reasonCode,
                "nonfatal grounding failure code",
              ),
              groundingResult.reason,
            )
          : mapGroundingOutput(
              groundingResult.rawOutput,
              groundingResult.execution,
              materialization,
            );
    }

    families.push({
      familyId: construction.familyId,
      seedId: construction.seedId,
      candidateIds: construction.candidateIds,
      sourceClaimRecordIds: construction.sourceClaimRecordIds,
      trackedClaim: construction.trackedClaim,
      normalizedClaim: construction.normalizedClaim,
      grounding,
      includedCitationOccurrenceIds: construction.includedCitationOccurrenceIds,
      provenanceArtifacts: uniqueSortedArtifactReferences([
        discoverReference,
        ...construction.candidates.flatMap(
          (candidate) => candidate.provenanceArtifacts,
        ),
        ...materializationArtifacts(materialization),
        ...groundingArtifacts,
      ]),
    });
  }

  const payload = scopeArtifactPayloadSchema.parse({
    discoverArtifact: discoverReference,
    candidateDecisions,
    seedMaterializations: [...materializationsBySeedId.values()].sort(
      (left, right) => compareCodeUnits(left.seedId, right.seedId),
    ),
    families: families.sort((left, right) =>
      compareCodeUnits(left.familyId, right.familyId),
    ),
  });

  return {
    payload,
    decisions: decisions.sort((left, right) =>
      compareCodeUnits(left.decisionId, right.decisionId),
    ),
    exclusions: [],
    provenanceInputs: {
      prompts: uniqueSorted(prompts),
      models: uniqueSorted(models),
      responseArtifacts: uniqueSortedArtifactReferences(responseArtifacts),
    },
  };
}

export function buildCanonicalScopeArtifact(input: {
  result: CanonicalScopeResult;
  runId: string;
  createdAt: string;
  implementation?: string | undefined;
  configuration?: LeanArtifactProvenance["configuration"] | undefined;
  code?: LeanArtifactProvenance["code"] | undefined;
}): ScopeArtifact {
  const provenance: LeanArtifactProvenance = {
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(input.code ? { code: input.code } : {}),
    prompts: input.result.provenanceInputs.prompts,
    models: input.result.provenanceInputs.models,
  };
  const hasExternalExecution =
    input.result.provenanceInputs.responseArtifacts.length > 0;
  const artifact = createLeanStageArtifact({
    schemaVersion: leanArtifactSchemaVersion,
    artifactVersion: leanArtifactVersion,
    runId: input.runId,
    createdAt: input.createdAt,
    canonicalStage: "scope",
    inputArtifacts: [input.result.payload.discoverArtifact],
    provenance,
    execution: hasExternalExecution
      ? {
          kind: "hybrid",
          implementation: input.implementation ?? "canonical-scope-v1",
          replayableFromInputs: false,
          responseArtifacts: input.result.provenanceInputs.responseArtifacts,
        }
      : {
          kind: "deterministic",
          implementation: input.implementation ?? "canonical-scope-v1",
          replayableFromInputs: true,
        },
    decisions: input.result.decisions,
    exclusions: input.result.exclusions,
    payload: input.result.payload,
  });
  return scopeArtifactSchemaForBuild(artifact);
}

function buildFamilyConstructions(discoverArtifact: DiscoverArtifact): {
  familyConstructions: FamilyConstruction[];
  candidateDecisions: ScopeCandidateDecision[];
} {
  const dispositionByCandidateId = new Map(
    discoverArtifact.payload.candidateDispositions.map((disposition) => [
      disposition.candidateId,
      disposition,
    ]),
  );
  const groupsByFamilyId = new Map<string, DiscoverClaimCandidate[]>();
  const candidateDecisions: ScopeCandidateDecision[] = [];

  for (const candidate of discoverArtifact.payload.claimCandidates) {
    const disposition = dispositionByCandidateId.get(candidate.candidateId);
    if (!disposition) {
      throw new CanonicalScopeBoundaryError(
        `Discover candidate has no disposition: ${candidate.candidateId}`,
      );
    }
    if (!disposition.selectedForScope) {
      candidateDecisions.push({
        candidateId: candidate.candidateId,
        seedId: candidate.seedId,
        disposition: "deferred_upstream",
        discoverRank: disposition.rank,
        discoverReason: disposition.reason,
      });
      continue;
    }

    const familyId = buildScopedFamilyId(candidate);
    const group = groupsByFamilyId.get(familyId) ?? [];
    group.push(candidate);
    groupsByFamilyId.set(familyId, group);
    candidateDecisions.push({
      candidateId: candidate.candidateId,
      seedId: candidate.seedId,
      disposition: "scoped",
      familyId,
      discoverRank: disposition.rank,
      discoverReason: disposition.reason,
      sourceClaimRecordIds: sortedUnique(candidate.sourceClaimRecordIds),
      memberMentionIds: sortedUnique(candidate.memberMentionIds),
    });
  }

  const familyConstructions = [...groupsByFamilyId.entries()]
    .map(([familyId, candidates]): FamilyConstruction => {
      const orderedCandidates = [...candidates].sort((left, right) =>
        compareCodeUnits(left.candidateId, right.candidateId),
      );
      const first = orderedCandidates[0];
      if (!first) {
        throw new Error("Scope candidate grouping produced an empty family");
      }
      if (
        orderedCandidates.some((candidate) => candidate.seedId !== first.seedId)
      ) {
        throw new CanonicalScopeBoundaryError(
          `Scope family would merge candidates across seeds: ${familyId}`,
        );
      }
      return {
        familyId,
        seedId: first.seedId,
        candidateIds: orderedCandidates.map(
          (candidate) => candidate.candidateId,
        ),
        sourceClaimRecordIds: sortedUnique(
          orderedCandidates.flatMap(
            (candidate) => candidate.sourceClaimRecordIds,
          ),
        ),
        trackedClaim: orderedCandidates
          .map((candidate) => normalizeWhitespace(candidate.canonicalClaim))
          .sort(compareCodeUnits)[0]!,
        normalizedClaim: first.normalizedClaim,
        includedCitationOccurrenceIds: sortedUnique(
          orderedCandidates.flatMap((candidate) => candidate.memberMentionIds),
        ),
        candidates: orderedCandidates,
      };
    })
    .sort((left, right) => compareCodeUnits(left.familyId, right.familyId));

  return {
    familyConstructions,
    candidateDecisions: candidateDecisions.sort((left, right) =>
      compareCodeUnits(left.candidateId, right.candidateId),
    ),
  };
}

function mapGroundingOutput(
  rawOutput: unknown,
  execution: ScopeGroundingModelExecution,
  materialization: ScopeSeedMaterialization & { status: "materialized" },
): ScopeGrounding {
  const parsed = canonicalScopeGroundingOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return invalidGrounding(
      execution,
      `Invalid grounding output at ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? parsed.error.message}`,
    );
  }

  const verifiedSpans: ScopeVerifiedEvidenceSpan[] = [];
  const failures: ScopeGrounding["quoteVerification"]["failures"] = [];
  const blocksById = new Map(
    materialization.blocks.map((block) => [block.blockId, block]),
  );
  const proposedSpans = [...parsed.data.supportSpans].sort((left, right) =>
    compareCodeUnits(canonicalSerialize(left), canonicalSerialize(right)),
  );
  for (const proposed of proposedSpans) {
    const block = blocksById.get(proposed.blockId);
    if (!block) {
      failures.push({
        proposedText: proposed.verbatimQuote,
        proposedBlockId: proposed.blockId,
        reason: "The model referenced a seed-text block that does not exist.",
      });
      continue;
    }
    const relativeStart = block.text.indexOf(proposed.verbatimQuote);
    if (relativeStart < 0) {
      failures.push({
        proposedText: proposed.verbatimQuote,
        proposedBlockId: proposed.blockId,
        reason:
          "The proposed quote is not a contiguous exact substring of the referenced seed-text block.",
      });
      continue;
    }
    verifiedSpans.push({
      text: proposed.verbatimQuote,
      blockId: block.blockId,
      blockKind: block.blockKind,
      ...(block.sectionTitle ? { sectionTitle: block.sectionTitle } : {}),
      charOffsetStart: block.charOffsetStart + relativeStart,
      charOffsetEnd:
        block.charOffsetStart + relativeStart + proposed.verbatimQuote.length,
      verificationStatus: "verified_exact",
      sourceArtifact: materialization.seedTextArtifact,
    });
  }

  if (failures.length > 0) {
    return {
      status: "invalid_grounding_output",
      detailReason: `${parsed.data.detailReason} Quote verification rejected model-proposed evidence.`,
      evidenceSpans: [],
      quoteVerification: {
        status: "failed",
        failures: failures.sort((left, right) =>
          compareCodeUnits(canonicalSerialize(left), canonicalSerialize(right)),
        ),
      },
      modelExecution: execution,
    };
  }

  return {
    status: parsed.data.status,
    detailReason: parsed.data.detailReason,
    evidenceSpans: verifiedSpans.sort((left, right) =>
      compareCodeUnits(canonicalSerialize(left), canonicalSerialize(right)),
    ),
    quoteVerification: {
      status: verifiedSpans.length > 0 ? "verified_exact" : "not_applicable",
      failures: [],
    },
    modelExecution: execution,
  };
}

function invalidGrounding(
  execution: ScopeGroundingModelExecution,
  detailReason: string,
): ScopeGrounding {
  return {
    status: "invalid_grounding_output",
    detailReason,
    evidenceSpans: [],
    quoteVerification: {
      status: "not_applicable",
      failures: [],
    },
    modelExecution: execution,
  };
}

function failedGrounding(
  execution: ScopeGroundingModelExecution,
  code: ScopeNonfatalFailureCode,
  reason: string,
): ScopeGrounding {
  return {
    status: "grounding_failed",
    detailReason: `Grounding provider failed (${code}): ${reason}`,
    evidenceSpans: [],
    quoteVerification: {
      status: "not_applicable",
      failures: [],
    },
    modelExecution: execution,
    failure: {
      code,
      reason,
    },
  };
}

function recordModelExecution(
  execution: ScopeGroundingModelExecution,
  prompts: LeanArtifactProvenance["prompts"],
  models: LeanArtifactProvenance["models"],
  responseArtifacts: ArtifactReference[],
): void {
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
  responseArtifacts.push(execution.responseArtifact);
}

function materializationArtifacts(
  materialization: ScopeSeedMaterialization,
): ArtifactReference[] {
  const contentArtifacts =
    materialization.status === "materialized"
      ? [materialization.seedTextArtifact, ...materialization.sourceArtifacts]
      : materialization.provenanceArtifacts;
  return uniqueSortedArtifactReferences([
    ...contentArtifacts,
    ...executionArtifacts(materialization.execution),
  ]);
}

function executionArtifacts(
  execution: ScopeSeedMaterialization["execution"],
): ArtifactReference[] {
  return execution.kind === "external"
    ? [execution.requestArtifact, execution.responseArtifact]
    : execution.sourceArtifacts;
}

function executionResponseArtifacts(
  materialization: ScopeSeedMaterialization,
): ArtifactReference[] {
  return materialization.execution.kind === "external"
    ? [materialization.execution.responseArtifact]
    : [];
}

function throwIfFatal(input: {
  reasonCode?: z.infer<typeof scopeFailureCodeSchema> | undefined;
  reason?: string | undefined;
}): void {
  const parsed = scopeFatalFailureCodeSchema.safeParse(input.reasonCode);
  if (parsed.success) {
    throw new CanonicalScopeFatalError(
      parsed.data,
      input.reason ?? parsed.data,
    );
  }
}

function buildDiscoverReference(
  discoverArtifact: DiscoverArtifact,
  uri: string | undefined,
): ScopeArtifactPayload["discoverArtifact"] {
  return {
    artifactId: discoverArtifact.artifactId,
    contentHash: discoverArtifact.contentHash,
    role: "canonical-discover-input",
    canonicalStage: "discover",
    ...(uri ? { uri } : {}),
  };
}

function parseBoundary<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new CanonicalScopeBoundaryError(
    `Invalid ${label} at ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? parsed.error.message}`,
  );
}

function scopeArtifactSchemaForBuild(value: unknown): ScopeArtifact {
  const parsed = scopeArtifactSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new CanonicalScopeBoundaryError(
    `Invalid canonical Scope artifact at ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? parsed.error.message}`,
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

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
