import { z } from "zod";

import { uniqueSortedArtifactReferences } from "../../contract/artifacts/primitives.js";
import {
  compareCodeUnits,
  sortedUnique,
  uniqueSorted,
} from "../../shared/order.js";
import { normalizeWhitespace } from "../../contract/artifacts/checks.js";
import { pMap } from "../../shared/concurrency.js";

import {
  buildScopedFamilyId,
  createAppendOnlyDecision,
  createStageArtifact,
  discoverArtifactSchema,
  currentArtifactSchemaVersion,
  currentArtifactVersion,
  scopeArtifactPayloadSchema,
  scopeArtifactSchema,
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
import type { ModelExecution } from "../../contract/model-execution.js";
import { canonicalSerialize } from "../../shared/stable-identity.js";
import {
  parseScopeBoundary as parseBoundary,
  scopeModelResultSchema,
  ScopeBoundaryError,
  throwIfFatal,
} from "./model-result.js";
import {
  assessCitationStatements,
  buildScopeCitationStatements,
  groundingSupportSpanOutputSchema,
  inspectSeedInventory,
  type ScopeStatementAdapters,
} from "./statements.js";

export { ScopeBoundaryError, ScopeFatalError } from "./model-result.js";

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

type ScopeFamilyInput = {
  familyId: string;
  seedId: string;
  candidateIds: string[];
  sourceClaimRecordIds: string[];
  claim: string;
  normalizedClaim: string;
  includedCitationOccurrenceIds: string[];
};

export type ScopeAdapters = ScopeStatementAdapters & {
  materializeSeed: (input: { seed: DiscoverSeed }) => Promise<unknown>;
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
  const seeds = [...discoverArtifact.payload.seeds].sort((left, right) =>
    compareCodeUnits(left.seedId, right.seedId),
  );
  const seedsById = new Map(seeds.map((seed) => [seed.seedId, seed]));

  for (const seed of seeds) {
    const { seedId } = seed;
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

  const concurrency = options.concurrency ?? 1;
  const seedInventories = await pMap(
    seeds,
    async (seed) => {
      const materialization = materializationsBySeedId.get(seed.seedId);
      if (!materialization)
        throw new Error("Scope lost a seed materialization");
      return inspectSeedInventory(
        seed,
        materialization,
        adapters.inventorySeed,
      );
    },
    { concurrency },
  );
  for (const inventory of seedInventories) {
    if (inventory.modelExecution) {
      recordModelExecution(
        inventory.modelExecution,
        prompts,
        models,
        responseArtifacts,
      );
    }
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
    const seed = seedsById.get(construction.seedId);
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
        scopeModelResultSchema,
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

  const grounded = await pMap(familyConstructions, groundConstruction, {
    concurrency,
  });
  const families: ScopeArtifactPayload["families"] = [];
  for (const { family, execution } of grounded) {
    families.push(family);
    if (execution) {
      recordModelExecution(execution, prompts, models, responseArtifacts);
    }
  }

  const statementsBySeed = new Map<
    string,
    ScopeArtifactPayload["citationStatements"]
  >();
  for (const statement of buildScopeCitationStatements(
    discoverArtifact.payload,
  )) {
    const group = statementsBySeed.get(statement.seedId);
    if (group) group.push(statement);
    else statementsBySeed.set(statement.seedId, [statement]);
  }
  const citationStatements: ScopeArtifactPayload["citationStatements"] = [];
  const statementAssessments: ScopeArtifactPayload["statementAssessments"] = [];
  for (const inventory of seedInventories) {
    const { statements, batches } = await assessCitationStatements({
      inventory,
      statements: statementsBySeed.get(inventory.seedId) ?? [],
      matchStatements: adapters.matchStatements,
      concurrency,
    });
    citationStatements.push(...statements);
    statementAssessments.push(...batches);
    for (const batch of batches) {
      recordModelExecution(
        batch.modelExecution,
        prompts,
        models,
        responseArtifacts,
      );
    }
  }

  const payload = scopeArtifactPayloadSchema.parse({
    discoverArtifact: discoverReference,
    candidateDecisions,
    seedMaterializations: [...materializationsBySeedId.values()].sort(
      (left, right) => compareCodeUnits(left.seedId, right.seedId),
    ),
    seedInventories,
    citationStatements,
    statementAssessments,
    families: families.sort((left, right) =>
      compareCodeUnits(left.familyId, right.familyId),
    ),
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
