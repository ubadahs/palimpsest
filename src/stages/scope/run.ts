import { z } from "zod";

import { uniqueSortedArtifactReferences } from "../../contract/artifacts/primitives.js";
import {
  compareCodeUnits,
  sortedUnique,
  uniqueSorted,
} from "../../shared/order.js";
import { normalizeWhitespace } from "../../contract/artifacts/checks.js";
import { pMap } from "../../shared/concurrency.js";
import { createBoundaryParser } from "../../shared/boundary.js";

import {
  buildScopedFamilyId,
  createAppendOnlyDecision,
  createStageArtifact,
  discoverArtifactSchema,
  currentArtifactSchemaVersion,
  currentArtifactVersion,
  scopeArtifactPayloadSchema,
  scopeArtifactSchema,
  scopeFailureCodeSchema,
  scopeFatalFailureCodeSchema,
  scopeNonfatalFailureCodeSchema,
  scopeSeedMaterializationSchema,
  type AppendOnlyDecision,
  type ArtifactReference,
  type DiscoverArtifact,
  type DiscoverClaimCandidate,
  type DiscoverSeed,
  type ArtifactProvenance,
  type ScopeArtifact,
  type ScopeArtifactPayload,
  type ScopeCandidateDecision,
  type ScopeGrounding,
  type ScopeNonfatalFailureCode,
  type ScopeSeedMaterialization,
  type ScopeVerifiedEvidenceSpan,
} from "../../contract/artifacts/index.js";
import {
  buildSeedTextHash,
  isUsableCodebook,
  scopeSeedCodebookSchema,
  type ScopeClaimTag,
  type ScopeSeedCodebook,
  type UsableScopeSeedCodebook,
} from "../../contract/artifacts/codebook.js";
import {
  codebookTaggingReplySchema,
  normalizeTaggingReply,
} from "./seed-codebook.js";
import {
  modelExecutionSchema,
  type ModelExecution,
} from "../../contract/model-execution.js";
import { canonicalSerialize } from "../../shared/stable-identity.js";

const scopeOptionsSchema = z
  .object({
    recordedAt: z.string().datetime({ offset: true }),
    discoverArtifactUri: z.string().min(1).optional(),
    /** Model requests in flight at once; results keep input order. */
    concurrency: z.number().int().positive().optional(),
  })
  .strict();
export type ScopeOptions = z.infer<typeof scopeOptionsSchema>;

const scopeSeedMaterializationResultSchema = scopeSeedMaterializationSchema;

const groundingSupportSpanOutputSchema = z
  .object({
    verbatimQuote: z.string().min(1),
    blockId: z.string().min(1),
  })
  .strict();

export const scopeGroundingOutputSchema = z.discriminatedUnion("status", [
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
      // Model may propose junk spans; Scope ignores them for not_found.
      supportSpans: z.array(groundingSupportSpanOutputSchema).default([]),
    })
    .strict(),
]);
export type ScopeGroundingOutput = z.infer<typeof scopeGroundingOutputSchema>;

const scopeGroundingResultSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("completed"),
        rawOutput: z.unknown(),
        execution: modelExecutionSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        reasonCode: scopeFailureCodeSchema,
        reason: z.string().min(1),
        execution: modelExecutionSchema,
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
type ScopeFamilyInput = {
  familyId: string;
  seedId: string;
  candidateIds: string[];
  sourceClaimRecordIds: string[];
  claim: string;
  normalizedClaim: string;
  includedCitationOccurrenceIds: string[];
};

const scopeTaggingResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      rawOutput: z.unknown(),
      execution: modelExecutionSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reasonCode: scopeFailureCodeSchema,
      reason: z.string().min(1),
      execution: modelExecutionSchema,
    })
    .strict(),
]);

export type ScopeAdapters = {
  materializeSeed: (input: { seed: DiscoverSeed }) => Promise<unknown>;
  /**
   * The seed's codebook: the stored one for this seed text and procedure
   * version, or a newly generated one. Never excludes anything.
   */
  buildCodebook: (input: {
    seed: DiscoverSeed;
    seedText: ScopeSeedMaterialization & { status: "materialized" };
    seedTextHash: string;
  }) => Promise<unknown>;
  /** Tags one citing claim against its seed codebook; one request per claim. */
  tagClaim: (input: {
    seed: DiscoverSeed;
    codebook: UsableScopeSeedCodebook;
    claimText: string;
  }) => Promise<unknown>;
  groundFamily: (input: {
    seed: DiscoverSeed;
    family: ScopeFamilyInput;
    seedText: ScopeSeedMaterialization & { status: "materialized" };
  }) => Promise<unknown>;
};

type ScopeProvenanceInputs = {
  prompts: ArtifactProvenance["prompts"];
  models: ArtifactProvenance["models"];
  responseArtifacts: ArtifactReference[];
};

export type ScopeResult = {
  payload: ScopeArtifactPayload;
  decisions: AppendOnlyDecision[];
  provenanceInputs: ScopeProvenanceInputs;
};

export class ScopeBoundaryError extends Error {
  override readonly name = "ScopeBoundaryError";
}

export class ScopeFatalError extends Error {
  override readonly name = "ScopeFatalError";

  constructor(
    readonly failureCode: z.infer<typeof scopeFatalFailureCodeSchema>,
    message: string,
  ) {
    super(message);
  }
}

type FamilyConstruction = ScopeFamilyInput & {
  candidates: DiscoverClaimCandidate[];
};

export async function runScope(
  discoverArtifactInput: unknown,
  adapters: ScopeAdapters,
  optionsInput: ScopeOptions,
): Promise<ScopeResult> {
  const discoverArtifact = parseBoundary(
    discoverArtifactSchema,
    discoverArtifactInput,
    "Discover input",
  );
  const options = parseBoundary(
    scopeOptionsSchema,
    optionsInput,
    "Scope options",
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
        identifier: "scope-membership-freeze-v1",
      },
      evidenceArtifacts: [discoverReference],
    }),
  );
  const prompts: ArtifactProvenance["prompts"] = [];
  const models: ArtifactProvenance["models"] = [];
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
      throw new ScopeBoundaryError(
        `Selected Scope family references an unknown Discover seed: ${seedId}`,
      );
    }
    const materialization = parseBoundary(
      scopeSeedMaterializationResultSchema,
      await adapters.materializeSeed({ seed }),
      `seed materialization for ${seedId}`,
    );
    if (materialization.seedId !== seedId) {
      throw new ScopeBoundaryError(
        `Seed materialization returned ${materialization.seedId} for ${seedId}`,
      );
    }
    throwIfFatal(materialization);
    materializationsBySeedId.set(seedId, materialization);
    responseArtifacts.push(...executionResponseArtifacts(materialization));
  }

  // The seed text is a provider-cached prompt prefix. The first grounding
  // call for a seed writes that cache; the others wait for it, then fan out,
  // so every family after the first reads the seed from cache.
  const primedSeeds = new Map<string, Promise<unknown>>();
  async function groundWithPrimedSeed<T>(
    seedId: string,
    call: () => Promise<T>,
  ): Promise<T> {
    const primer = primedSeeds.get(seedId);
    if (primer) {
      await primer;
      return call();
    }
    const first = call();
    primedSeeds.set(
      seedId,
      first.catch(() => undefined),
    );
    return first;
  }

  async function groundConstruction(
    construction: (typeof familyConstructions)[number],
  ): Promise<{
    family: ScopeArtifactPayload["families"][number];
    execution: ModelExecution | undefined;
  }> {
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
    let execution: ModelExecution | undefined;
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
        scopeGroundingResultSchema,
        await groundWithPrimedSeed(construction.seedId, () =>
          adapters.groundFamily({
            seed,
            family: construction,
            seedText: materialization,
          }),
        ),
        `claim grounding for ${construction.familyId}`,
      );
      if (groundingResult.status === "failed") {
        throwIfFatal(groundingResult);
      }
      execution = groundingResult.execution;
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

    return {
      family: {
        familyId: construction.familyId,
        seedId: construction.seedId,
        candidateIds: construction.candidateIds,
        sourceClaimRecordIds: construction.sourceClaimRecordIds,
        claim: construction.claim,
        normalizedClaim: construction.normalizedClaim,
        grounding,
        includedCitationOccurrenceIds:
          construction.includedCitationOccurrenceIds,
        provenanceArtifacts: uniqueSortedArtifactReferences([
          discoverReference,
          ...construction.candidates.flatMap(
            (candidate) => candidate.provenanceArtifacts,
          ),
          ...materializationArtifacts(materialization),
          ...groundingArtifacts,
        ]),
      },
      execution,
    };
  }

  // Codebooks before grounding: each seed's three calls run in order so the
  // seed text is cached once, and seeds run side by side.
  const codebooks = await pMap(
    [...materializationsBySeedId.values()].sort((left, right) =>
      compareCodeUnits(left.seedId, right.seedId),
    ),
    async (materialization): Promise<ScopeSeedCodebook> => {
      if (materialization.status !== "materialized") {
        return {
          status: "seed_text_unavailable",
          seedId: materialization.seedId,
          reason: materialization.reason,
        };
      }
      const seed = discoverSeedById(discoverArtifact, materialization.seedId);
      const codebook = parseBoundary(
        scopeSeedCodebookSchema,
        await adapters.buildCodebook({
          seed,
          seedText: materialization,
          seedTextHash: buildSeedTextHash(materialization.blocks),
        }),
        `seed codebook for ${materialization.seedId}`,
      );
      if (codebook.seedId !== materialization.seedId) {
        throw new ScopeBoundaryError(
          `Seed codebook returned ${codebook.seedId} for ${materialization.seedId}`,
        );
      }
      return codebook;
    },
    { concurrency: options.concurrency ?? 1 },
  );
  for (const codebook of codebooks) {
    if (codebook.status === "generated" || codebook.status === "failed") {
      for (const execution of codebook.executions) {
        recordModelExecution(execution, prompts, models, responseArtifacts);
      }
    }
  }

  const grounded = await pMap(familyConstructions, groundConstruction, {
    concurrency: options.concurrency ?? 1,
  });
  const families: ScopeArtifactPayload["families"] = [];
  for (const { family, execution } of grounded) {
    families.push(family);
    if (execution) {
      recordModelExecution(execution, prompts, models, responseArtifacts);
    }
  }

  const claimTags = await tagDiscoverClaims({
    discoverArtifact,
    codebooks,
    adapters,
    concurrency: options.concurrency ?? 1,
  });
  for (const execution of claimTags.executions) {
    recordModelExecution(execution, prompts, models, responseArtifacts);
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
    codebooks,
    claimTags: claimTags.tags,
  });

  return {
    payload,
    decisions: decisions.sort((left, right) =>
      compareCodeUnits(left.decisionId, right.decisionId),
    ),
    provenanceInputs: {
      prompts: uniqueSorted(prompts),
      models: uniqueSorted(models),
      responseArtifacts: uniqueSortedArtifactReferences(responseArtifacts),
    },
  };
}

export function buildScopeArtifact(input: {
  result: ScopeResult;
  runId: string;
  createdAt: string;
  implementation?: string | undefined;
  configuration?: ArtifactProvenance["configuration"] | undefined;
  code?: ArtifactProvenance["code"] | undefined;
}): ScopeArtifact {
  const provenance: ArtifactProvenance = {
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(input.code ? { code: input.code } : {}),
    prompts: input.result.provenanceInputs.prompts,
    models: input.result.provenanceInputs.models,
  };
  const hasExternalExecution =
    input.result.provenanceInputs.responseArtifacts.length > 0;
  const artifact = createStageArtifact({
    schemaVersion: currentArtifactSchemaVersion,
    artifactVersion: currentArtifactVersion,
    runId: input.runId,
    createdAt: input.createdAt,
    stage: "scope",
    inputArtifacts: [input.result.payload.discoverArtifact],
    provenance,
    execution: hasExternalExecution
      ? {
          kind: "hybrid",
          implementation: input.implementation ?? "scope-v1",
          replayableFromInputs: false,
          responseArtifacts: input.result.provenanceInputs.responseArtifacts,
        }
      : {
          kind: "deterministic",
          implementation: input.implementation ?? "scope-v1",
          replayableFromInputs: true,
        },
    decisions: input.result.decisions,
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
      throw new ScopeBoundaryError(
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
        throw new ScopeBoundaryError(
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
        claim: orderedCandidates
          .map((candidate) => normalizeWhitespace(candidate.claim))
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

function discoverSeedById(
  discoverArtifact: DiscoverArtifact,
  seedId: string,
): DiscoverSeed {
  const seed = discoverArtifact.payload.seeds.find(
    (entry) => entry.seedId === seedId,
  );
  if (!seed) {
    throw new ScopeBoundaryError(`Unknown Discover seed: ${seedId}`);
  }
  return seed;
}

/**
 * Tags every Discover claim, not only claims in selected families. Claims of
 * a seed with the same whitespace-normalized text share one request, so a
 * text is always tagged the same way within a run, and across runs through
 * the exact-result cache. Each request carries only its claim beside the
 * seed's codebook; the first per seed goes alone so it writes the prompt
 * cache. A failed request is a typed outcome on its claims, never a stage
 * failure (fatal provider errors excepted).
 */
async function tagDiscoverClaims(input: {
  discoverArtifact: DiscoverArtifact;
  codebooks: readonly ScopeSeedCodebook[];
  adapters: ScopeAdapters;
  concurrency: number;
}): Promise<{ tags: ScopeClaimTag[]; executions: ModelExecution[] }> {
  const codebookBySeedId = new Map(
    input.codebooks.map((codebook) => [codebook.seedId, codebook]),
  );
  type Unit = {
    seedId: string;
    claimText: string;
    claimRecordIds: string[];
  };
  const units = new Map<string, Unit>();
  const tags: ScopeClaimTag[] = [];
  const claims = [
    ...input.discoverArtifact.payload.attributedClaimRecords,
  ].sort((left, right) =>
    compareCodeUnits(left.claimRecordId, right.claimRecordId),
  );
  for (const claim of claims) {
    const codebook = codebookBySeedId.get(claim.seedId);
    if (!codebook || !isUsableCodebook(codebook)) {
      tags.push({
        claimRecordId: claim.claimRecordId,
        seedId: claim.seedId,
        status: "not_tagged",
        reason: "codebook_unavailable",
      });
      continue;
    }
    const claimText = normalizeWhitespace(claim.extractedClaimText);
    const key = `${claim.seedId}\u0000${claimText}`;
    const unit = units.get(key) ?? {
      seedId: claim.seedId,
      claimText,
      claimRecordIds: [],
    };
    unit.claimRecordIds.push(claim.claimRecordId);
    units.set(key, unit);
  }

  const orderedUnits = [...units.values()].sort(
    (left, right) =>
      compareCodeUnits(left.seedId, right.seedId) ||
      compareCodeUnits(left.claimText, right.claimText),
  );
  const primedSeeds = new Map<string, Promise<unknown>>();
  async function withPrimedCodebook<T>(
    seedId: string,
    call: () => Promise<T>,
  ): Promise<T> {
    const primer = primedSeeds.get(seedId);
    if (primer) {
      await primer;
      return call();
    }
    const first = call();
    primedSeeds.set(
      seedId,
      first.catch(() => undefined),
    );
    return first;
  }

  const outcomes = await pMap(
    orderedUnits,
    async (unit) => {
      const codebook = codebookBySeedId.get(unit.seedId);
      if (!codebook || !isUsableCodebook(codebook)) {
        throw new Error("Tagging unit lost its codebook");
      }
      const seed = discoverSeedById(input.discoverArtifact, unit.seedId);
      const result = parseBoundary(
        scopeTaggingResultSchema,
        await withPrimedCodebook(unit.seedId, () =>
          input.adapters.tagClaim({
            seed,
            codebook,
            claimText: unit.claimText,
          }),
        ),
        `codebook tagging for ${unit.claimRecordIds[0]!}`,
      );
      if (result.status === "failed") {
        throwIfFatal(result);
        const code = scopeNonfatalFailureCodeSchema.parse(result.reasonCode);
        return {
          unit,
          execution: result.execution,
          outcome: {
            status: "tagging_failed" as const,
            failure: {
              code:
                code === "not_found" || code === "unavailable"
                  ? ("provider_failure" as const)
                  : code,
              reason: result.reason,
            },
          },
        };
      }
      const parsed = codebookTaggingReplySchema(codebook).safeParse(
        result.rawOutput,
      );
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          unit,
          execution: result.execution,
          outcome: {
            status: "tagging_failed" as const,
            failure: {
              code: "invalid_response" as const,
              reason: `Invalid tagging output at ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? parsed.error.message}`,
            },
          },
        };
      }
      return {
        unit,
        execution: result.execution,
        outcome: {
          status: "tagged" as const,
          ...normalizeTaggingReply(parsed.data),
          reason: parsed.data.reason,
        },
      };
    },
    { concurrency: input.concurrency },
  );

  const executions: ModelExecution[] = [];
  for (const { unit, execution, outcome } of outcomes) {
    executions.push(execution);
    for (const claimRecordId of unit.claimRecordIds) {
      tags.push(
        outcome.status === "tagged"
          ? {
              claimRecordId,
              seedId: unit.seedId,
              status: "tagged",
              kind: outcome.kind,
              tags: outcome.tags,
              reason: outcome.reason,
              execution,
            }
          : {
              claimRecordId,
              seedId: unit.seedId,
              status: "tagging_failed",
              failure: outcome.failure,
              execution,
            },
      );
    }
  }
  return {
    tags: tags.sort((left, right) =>
      compareCodeUnits(left.claimRecordId, right.claimRecordId),
    ),
    executions,
  };
}

function mapGroundingOutput(
  rawOutput: unknown,
  execution: ModelExecution,
  materialization: ScopeSeedMaterialization & { status: "materialized" },
): ScopeGrounding {
  const parsed = scopeGroundingOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return invalidGrounding(
      execution,
      `Invalid grounding output at ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? parsed.error.message}`,
    );
  }

  if (parsed.data.status === "not_found") {
    return {
      status: "not_found",
      detailReason: parsed.data.detailReason,
      evidenceSpans: [],
      quoteVerification: {
        status: "not_applicable",
        failures: [],
      },
      modelExecution: execution,
    };
  }

  const verifiedSpans: ScopeVerifiedEvidenceSpan[] = [];
  let droppedProposals = 0;
  const blocksById = new Map(
    materialization.blocks.map((block) => [block.blockId, block]),
  );
  const proposedSpans = [...parsed.data.supportSpans].sort((left, right) =>
    compareCodeUnits(canonicalSerialize(left), canonicalSerialize(right)),
  );
  for (const proposed of proposedSpans) {
    const block = blocksById.get(proposed.blockId);
    if (!block) {
      droppedProposals += 1;
      continue;
    }
    const relativeStart = block.text.indexOf(proposed.verbatimQuote);
    if (relativeStart < 0) {
      droppedProposals += 1;
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

  if (verifiedSpans.length === 0) {
    return {
      status: "invalid_grounding_output",
      detailReason: `${parsed.data.detailReason} Quote verification rejected model-proposed evidence.`,
      evidenceSpans: [],
      quoteVerification: {
        status: "failed",
        failures: proposedSpans.map((proposed) => ({
          proposedText: proposed.verbatimQuote,
          ...(proposed.blockId ? { proposedBlockId: proposed.blockId } : {}),
          reason:
            "No proposed quote was a contiguous exact substring of a seed-text block.",
        })),
      },
      modelExecution: execution,
    };
  }

  const detailReason =
    droppedProposals > 0
      ? `${parsed.data.detailReason} Dropped ${String(droppedProposals)} unverifiable support span proposal(s).`
      : parsed.data.detailReason;

  return {
    status: parsed.data.status,
    detailReason,
    evidenceSpans: verifiedSpans.sort((left, right) =>
      compareCodeUnits(canonicalSerialize(left), canonicalSerialize(right)),
    ),
    quoteVerification: {
      status: "verified_exact",
      failures: [],
    },
    modelExecution: execution,
  };
}

function invalidGrounding(
  execution: ModelExecution,
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
  execution: ModelExecution,
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
  execution: ModelExecution,
  prompts: ArtifactProvenance["prompts"],
  models: ArtifactProvenance["models"],
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
    throw new ScopeFatalError(parsed.data, input.reason ?? parsed.data);
  }
}

function buildDiscoverReference(
  discoverArtifact: DiscoverArtifact,
  uri: string | undefined,
): ScopeArtifactPayload["discoverArtifact"] {
  return {
    artifactId: discoverArtifact.artifactId,
    contentHash: discoverArtifact.contentHash,
    role: "discover-input",
    stage: "discover",
    ...(uri ? { uri } : {}),
  };
}

function scopeArtifactSchemaForBuild(value: unknown): ScopeArtifact {
  const parsed = scopeArtifactSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new ScopeBoundaryError(
    `Invalid Scope artifact at ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? parsed.error.message}`,
  );
}

const parseBoundary = createBoundaryParser(ScopeBoundaryError);
