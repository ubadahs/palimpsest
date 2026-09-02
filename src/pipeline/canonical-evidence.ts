import { z } from "zod";

import { uniqueSortedArtifactReferences } from "../contract/lean-artifact-primitives.js";
import {
  compareCodeUnits,
  uniqueSorted,
  uniqueSortedById,
} from "../shared/order.js";
import { createBoundaryParser } from "../shared/boundary.js";

import {
  buildEvidenceBm25RunId,
  buildEvidenceRerankRunId,
  buildEvidenceSelectionId,
  createAppendOnlyDecision,
  createLeanStageArtifact,
  evidenceArtifactPayloadSchema,
  evidenceArtifactSchema,
  evidenceChunkConfigurationSchema,
  evidenceBm25RunSchema,
  evidenceRerankFailureCodeSchema,
  evidenceRerankFatalFailureCodeSchema,
  evidenceRerankNonfatalFailureCodeSchema,
  evidenceRerankOutputSchema,
  evidenceRerankRunSchema,
  evidenceRerankingPolicySchema,
  evidenceSelectionSchema,
  leanArtifactSchemaVersion,
  leanArtifactVersion,
  prepareArtifactSchema,
  scopeArtifactSchema,
  type AppendOnlyDecision,
  type ArtifactReference,
  type EvidenceArtifact,
  type EvidenceArtifactPayload,
  type EvidenceBm25Run,
  type EvidenceChunkCorpus,
  type EvidenceLineage,
  type EvidenceQuery,
  type EvidenceRecordOutcome,
  type EvidenceRerankRun,
  type EvidenceRerankStatus,
  type EvidenceSelection,
  type LeanArtifactProvenance,
  type PrepareArtifact,
  type PreparedCitationInstance,
  type ScopeArtifact,
  type ScopeSeedMaterialization,
  type ScopedFamily,
} from "../contract/lean-artifacts.js";
import {
  modelExecutionSchema,
  type ModelExecution,
} from "../contract/model-execution.js";
import {
  buildOccurrenceLocalEvidenceQuery,
  buildScopedFamilyEvidenceQuery,
  canonicalEvidenceChunkConfiguration,
  chunkScopeSeedText,
  retrieveEvidenceByBm25,
  selectEvidenceChunkIds,
  unionBm25Candidates,
} from "../retrieval/canonical-evidence-retrieval.js";
import {
  canonicalSerialize,
  canonicalSha256,
} from "../shared/stable-identity.js";

const canonicalEvidenceOptionsSchema = z
  .object({
    recordedAt: z.string().datetime({ offset: true }),
    prepareArtifactUri: z.string().min(1).optional(),
    scopeArtifactUri: z.string().min(1).optional(),
    chunkConfiguration: evidenceChunkConfigurationSchema.optional(),
    bm25CandidateLimit: z.number().int().positive().default(20),
    selectionLimit: z.number().int().positive().default(5),
    reranking: evidenceRerankingPolicySchema,
  })
  .strict()
  .superRefine((options, context) => {
    if (options.selectionLimit > options.bm25CandidateLimit) {
      context.addIssue({
        code: "custom",
        path: ["selectionLimit"],
        message: "Evidence selection limit cannot exceed BM25 candidate limit",
      });
    }
  });
export type CanonicalEvidenceOptions = z.input<
  typeof canonicalEvidenceOptionsSchema
>;

const canonicalEvidenceRerankerResultSchema = z.discriminatedUnion("status", [
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
      reasonCode: evidenceRerankFailureCodeSchema,
      reason: z.string().min(1),
      execution: modelExecutionSchema,
    })
    .strict(),
]);
type CanonicalEvidenceRerankerResult = z.infer<
  typeof canonicalEvidenceRerankerResultSchema
>;

export type CanonicalEvidenceRerankerInput = {
  purpose: "relevance_only";
  familyId: string;
  bm25RunId: string;
  query: Pick<
    EvidenceQuery,
    "queryId" | "familyId" | "text" | "contentHash" | "source"
  >;
  topN: number;
  candidates: Array<{
    chunkId: string;
    text: string;
    sourceBlockId: string;
    sourceBlockKind: EvidenceChunkCorpus["chunks"][number]["sourceBlockKind"];
    sourceSectionTitle?: string | undefined;
    sourceSectionRole?:
      | EvidenceChunkCorpus["chunks"][number]["sourceSectionRole"]
      | undefined;
    sourceCitesOtherWork?: boolean | undefined;
    charOffsetStart: number;
    charOffsetEnd: number;
    bm25Score: number;
    bm25Rank: number;
  }>;
};

export type CanonicalEvidenceAdapters = {
  rerank?: (input: CanonicalEvidenceRerankerInput) => Promise<unknown>;
};

type CanonicalEvidenceProvenanceInputs = {
  prompts: LeanArtifactProvenance["prompts"];
  models: LeanArtifactProvenance["models"];
  responseArtifacts: ArtifactReference[];
};

export type CanonicalEvidenceResult = {
  payload: EvidenceArtifactPayload;
  decisions: AppendOnlyDecision[];
  provenanceInputs: CanonicalEvidenceProvenanceInputs;
};

export class CanonicalEvidenceBoundaryError extends Error {
  override readonly name = "CanonicalEvidenceBoundaryError";
}

export class CanonicalEvidenceFatalError extends Error {
  override readonly name = "CanonicalEvidenceFatalError";

  constructor(
    readonly failureCode: z.infer<typeof evidenceRerankFatalFailureCodeSchema>,
    message: string,
  ) {
    super(message);
  }
}

type RecordEvidenceComputation = {
  query: EvidenceQuery;
  fallbackQuery: EvidenceQuery;
  componentBm25Runs: EvidenceBm25Run[];
  retrievalStatus: EvidenceRecordOutcome["retrievalStatus"];
  rerankStatus: EvidenceRerankStatus;
  corpus?: EvidenceChunkCorpus | undefined;
  bm25Run?: EvidenceBm25Run | undefined;
  rerankRun?: EvidenceRerankRun | undefined;
  selection?: EvidenceSelection | undefined;
  failure?: EvidenceRecordOutcome["failure"] | undefined;
};

export async function runCanonicalEvidence(
  prepareArtifactInput: unknown,
  scopeArtifactInput: unknown,
  adapters: CanonicalEvidenceAdapters,
  optionsInput: CanonicalEvidenceOptions,
): Promise<CanonicalEvidenceResult> {
  const prepareArtifact = parseBoundary(
    prepareArtifactSchema,
    prepareArtifactInput,
    "canonical Prepare input",
  );
  const scopeArtifact = parseBoundary(
    scopeArtifactSchema,
    scopeArtifactInput,
    "canonical Scope ancestor",
  );
  const options = parseBoundary(
    canonicalEvidenceOptionsSchema,
    optionsInput,
    "canonical Evidence options",
  );
  verifyEvidenceAncestors(prepareArtifact, scopeArtifact);
  if (options.reranking.enabled && !adapters.rerank) {
    throw new CanonicalEvidenceBoundaryError(
      "Enabled canonical Evidence reranking requires a reranker adapter",
    );
  }

  const lineage = buildEvidenceLineage(prepareArtifact, scopeArtifact, options);
  const materializationsBySeedId = new Map(
    scopeArtifact.payload.seedMaterializations.map((materialization) => [
      materialization.seedId,
      materialization,
    ]),
  );
  const corporaBySeedId = new Map<string, EvidenceChunkCorpus>();
  const bm25WorkByContent = new Map<string, EvidenceBm25Run>();
  const unionRunsByComponents = new Map<string, EvidenceBm25Run>();
  const familiesById = new Map(
    scopeArtifact.payload.families.map((family) => [family.familyId, family]),
  );
  const computations: RecordEvidenceComputation[] = [];
  for (const record of prepareArtifact.payload.records) {
    const family = familiesById.get(record.familyId);
    if (!family) {
      throw new CanonicalEvidenceBoundaryError(
        `Prepare record has no Scope family: ${record.recordId}`,
      );
    }
    const materialization = materializationsBySeedId.get(family.seedId);
    if (!materialization) {
      throw new CanonicalEvidenceBoundaryError(
        `Scope family has no seed materialization: ${family.familyId}`,
      );
    }
    computations.push(
      await retrieveRecordEvidence({
        record,
        family,
        materialization,
        corporaBySeedId,
        bm25WorkByContent,
        unionRunsByComponents,
        adapters,
        options,
      }),
    );
  }

  const preparedRecords = prepareArtifact.payload.records.map((record) => ({
    recordId: record.recordId,
    familyId: record.familyId,
    citationOccurrenceId: record.citationOccurrenceId,
    seedId: record.seed.seedId,
  }));
  const records: EvidenceRecordOutcome[] = prepareArtifact.payload.records.map(
    (record, index) => {
      const computation = computations[index];
      if (!computation) throw new Error("Evidence record computation was lost");
      return {
        recordId: record.recordId,
        familyId: record.familyId,
        citationOccurrenceId: record.citationOccurrenceId,
        seedId: record.seed.seedId,
        queryId: computation.query.queryId,
        fallbackQueryId: computation.fallbackQuery.queryId,
        ...(computation.componentBm25Runs.length > 0
          ? {
              componentBm25RunIds: computation.componentBm25Runs.map(
                (run) => run.bm25RunId,
              ),
            }
          : {}),
        primaryQuerySource: computation.query.source,
        retrievalStatus: computation.retrievalStatus,
        rerankStatus: computation.rerankStatus,
        ...(computation.corpus
          ? { corpusId: computation.corpus.corpusId }
          : {}),
        ...(computation.bm25Run
          ? { bm25RunId: computation.bm25Run.bm25RunId }
          : {}),
        ...(computation.rerankRun
          ? { rerankRunId: computation.rerankRun.rerankRunId }
          : {}),
        ...(computation.selection
          ? { finalSelectionId: computation.selection.selectionId }
          : {}),
        ...(computation.failure ? { failure: computation.failure } : {}),
      };
    },
  );

  const payload = parseBoundary(
    evidenceArtifactPayloadSchema,
    {
      lineage,
      rerankingPolicy: options.reranking,
      preparedRecords,
      queries: uniqueSortedById(
        computations.flatMap((computation) => [
          computation.query,
          computation.fallbackQuery,
        ]),
        (query) => query.queryId,
      ),
      corpora: uniqueSortedById(
        computations.flatMap((computation) =>
          computation.corpus ? [computation.corpus] : [],
        ),
        (corpus) => corpus.corpusId,
      ),
      bm25Runs: uniqueSortedById(
        computations.flatMap((computation) => [
          ...computation.componentBm25Runs,
          ...(computation.bm25Run ? [computation.bm25Run] : []),
        ]),
        (run) => run.bm25RunId,
      ),
      rerankRuns: uniqueSortedById(
        computations.flatMap((computation) =>
          computation.rerankRun ? [computation.rerankRun] : [],
        ),
        (run) => run.rerankRunId,
      ),
      selections: uniqueSortedById(
        computations.flatMap((computation) =>
          computation.selection ? [computation.selection] : [],
        ),
        (selection) => selection.selectionId,
      ),
      records,
    },
    "canonical Evidence payload",
  );
  const decisions = createEvidenceDecisions(
    payload,
    options.recordedAt,
    lineage,
  );
  const executions = payload.rerankRuns.map((run) => run.execution);
  return {
    payload,
    decisions,
    provenanceInputs: {
      prompts: uniqueSorted(
        executions.map((execution) => ({
          promptId: execution.promptId,
          version: execution.promptVersion,
          contentHash: execution.promptContentHash,
        })),
      ),
      models: uniqueSorted(
        executions.map((execution) => ({
          provider: execution.provider,
          model: execution.model,
          requestHash: execution.requestHash,
          requestArtifact: execution.requestArtifact,
          responseArtifact: execution.responseArtifact,
        })),
      ),
      responseArtifacts: uniqueSortedArtifactReferences(
        executions.map((execution) => execution.responseArtifact),
      ),
    },
  };
}

export function buildCanonicalEvidenceArtifact(input: {
  result: CanonicalEvidenceResult;
  runId: string;
  createdAt: string;
  implementation?: string | undefined;
  configuration?: LeanArtifactProvenance["configuration"] | undefined;
  code?: LeanArtifactProvenance["code"] | undefined;
}): EvidenceArtifact {
  if (input.runId !== input.result.payload.lineage.runId) {
    throw new CanonicalEvidenceBoundaryError(
      "Evidence artifact run ID differs from its verified Prepare and Scope inputs",
    );
  }
  const provenance: LeanArtifactProvenance = {
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(input.code ? { code: input.code } : {}),
    prompts: input.result.provenanceInputs.prompts,
    models: input.result.provenanceInputs.models,
  };
  const hasModelExecution = input.result.provenanceInputs.models.length > 0;
  const artifact = createLeanStageArtifact({
    schemaVersion: leanArtifactSchemaVersion,
    artifactVersion: leanArtifactVersion,
    runId: input.runId,
    createdAt: input.createdAt,
    canonicalStage: "evidence",
    inputArtifacts: [
      input.result.payload.lineage.prepareArtifact,
      input.result.payload.lineage.scopeArtifact,
    ],
    provenance,
    execution: hasModelExecution
      ? {
          kind: "model",
          implementation: input.implementation ?? "canonical-evidence-v1",
          replayableFromInputs: false,
          responseArtifacts: input.result.provenanceInputs.responseArtifacts,
        }
      : {
          kind: "deterministic",
          implementation: input.implementation ?? "canonical-evidence-v1",
          replayableFromInputs: true,
        },
    decisions: input.result.decisions,
    payload: input.result.payload,
  });
  return parseBoundary(
    evidenceArtifactSchema,
    artifact,
    "canonical Evidence artifact",
  );
}

async function retrieveRecordEvidence(input: {
  record: PreparedCitationInstance;
  family: ScopedFamily;
  materialization: ScopeSeedMaterialization;
  corporaBySeedId: Map<string, EvidenceChunkCorpus>;
  bm25WorkByContent: Map<string, EvidenceBm25Run>;
  unionRunsByComponents: Map<string, EvidenceBm25Run>;
  adapters: CanonicalEvidenceAdapters;
  options: z.output<typeof canonicalEvidenceOptionsSchema>;
}): Promise<RecordEvidenceComputation> {
  const {
    record,
    family,
    materialization,
    corporaBySeedId,
    bm25WorkByContent,
    unionRunsByComponents,
    adapters,
    options,
  } = input;
  const query = buildOccurrenceLocalEvidenceQuery(record, family);
  const fallbackQuery = buildScopedFamilyEvidenceQuery(family);
  if (materialization.status !== "materialized") {
    return {
      query,
      fallbackQuery,
      componentBm25Runs: [],
      retrievalStatus:
        materialization.status === "seed_text_unavailable"
          ? "seed_text_unavailable"
          : "seed_acquisition_failed",
      rerankStatus: options.reranking.enabled
        ? "not_attempted_unavailable"
        : "disabled",
    };
  }

  let corpus = corporaBySeedId.get(materialization.seedId);
  if (!corpus) {
    try {
      corpus = chunkScopeSeedText(
        materialization,
        options.chunkConfiguration ?? canonicalEvidenceChunkConfiguration,
      );
      verifyCorpusAgainstScope(corpus, materialization);
      corporaBySeedId.set(materialization.seedId, corpus);
    } catch (error) {
      return {
        query,
        fallbackQuery,
        componentBm25Runs: [],
        retrievalStatus: "retrieval_failed",
        rerankStatus: options.reranking.enabled
          ? "not_attempted_retrieval_failure"
          : "disabled",
        failure: {
          code: "chunking_failed",
          reason: errorMessage(error),
        },
      };
    }
  }

  let componentBm25Runs: EvidenceBm25Run[];
  let bm25Run: EvidenceBm25Run;
  try {
    const localRun = retrieveEvidenceByBm25Cached({
      family,
      query,
      corpus,
      candidateLimit: options.bm25CandidateLimit,
      bm25WorkByContent,
    });
    if (query.contentHash === fallbackQuery.contentHash) {
      componentBm25Runs = [localRun];
      bm25Run = localRun;
    } else {
      const fallbackRun = retrieveEvidenceByBm25Cached({
        family,
        query: fallbackQuery,
        corpus,
        candidateLimit: options.bm25CandidateLimit,
        bm25WorkByContent,
      });
      componentBm25Runs = uniqueSortedById(
        [localRun, fallbackRun],
        (run) => run.bm25RunId,
      );
      bm25Run = buildUnionBm25Run({
        query,
        corpus,
        componentRuns: componentBm25Runs,
        unionRunsByComponents,
      });
    }
  } catch (error) {
    return {
      query,
      fallbackQuery,
      componentBm25Runs: [],
      corpus,
      retrievalStatus: "retrieval_failed",
      rerankStatus: options.reranking.enabled
        ? "not_attempted_retrieval_failure"
        : "disabled",
      failure: {
        code: "bm25_failed",
        reason: errorMessage(error),
      },
    };
  }

  if (bm25Run.candidates.length === 0) {
    return {
      query,
      fallbackQuery,
      componentBm25Runs,
      corpus,
      bm25Run,
      retrievalStatus: "no_lexical_matches",
      rerankStatus: options.reranking.enabled
        ? "not_attempted_no_candidates"
        : "disabled",
    };
  }

  if (!options.reranking.enabled) {
    const selection = buildFinalSelection(
      bm25Run,
      undefined,
      options.selectionLimit,
      family,
      corpus,
    );
    return {
      query,
      fallbackQuery,
      componentBm25Runs,
      corpus,
      bm25Run,
      selection,
      retrievalStatus: "retrieved",
      rerankStatus: "disabled",
    };
  }

  const reranker = adapters.rerank;
  if (!reranker) {
    throw new Error("Enabled reranker disappeared after boundary validation");
  }
  const chunksById = new Map(
    corpus.chunks.map((chunk) => [chunk.chunkId, chunk]),
  );
  const adapterResult = parseBoundary(
    canonicalEvidenceRerankerResultSchema,
    await reranker({
      purpose: "relevance_only",
      familyId: family.familyId,
      bm25RunId: bm25Run.bm25RunId,
      query: {
        queryId: query.queryId,
        familyId: query.familyId,
        text: query.text,
        contentHash: query.contentHash,
        source: query.source,
      },
      topN: options.reranking.topN,
      candidates: bm25Run.candidates.map((candidate) => {
        const chunk = chunksById.get(candidate.chunkId);
        if (!chunk) {
          throw new Error("BM25 returned a chunk outside its corpus");
        }
        return {
          chunkId: chunk.chunkId,
          text: chunk.text,
          sourceBlockId: chunk.sourceBlockId,
          sourceBlockKind: chunk.sourceBlockKind,
          ...(chunk.sourceSectionTitle
            ? { sourceSectionTitle: chunk.sourceSectionTitle }
            : {}),
          ...(chunk.sourceSectionRole
            ? { sourceSectionRole: chunk.sourceSectionRole }
            : {}),
          ...(chunk.sourceCitesOtherWork != null
            ? { sourceCitesOtherWork: chunk.sourceCitesOtherWork }
            : {}),
          charOffsetStart: chunk.charOffsetStart,
          charOffsetEnd: chunk.charOffsetEnd,
          bm25Score: candidate.rawScore,
          bm25Rank: candidate.rank,
        };
      }),
    }),
    `reranker result for ${family.familyId}`,
  );
  throwIfFatalRerankFailure(adapterResult);
  const rerankRun = buildRerankRun(
    adapterResult,
    query,
    bm25Run,
    options.reranking.topN,
  );
  const selection = buildFinalSelection(
    bm25Run,
    rerankRun.status === "completed" ? rerankRun : undefined,
    options.selectionLimit,
    family,
    corpus,
  );
  return {
    query,
    fallbackQuery,
    componentBm25Runs,
    corpus,
    bm25Run,
    rerankRun,
    selection,
    retrievalStatus: "retrieved",
    rerankStatus: rerankRun.status === "completed" ? "completed" : "failed",
  };
}

function retrieveEvidenceByBm25Cached(input: {
  family: ScopedFamily;
  query: EvidenceQuery;
  corpus: EvidenceChunkCorpus;
  candidateLimit: number;
  bm25WorkByContent: Map<string, EvidenceBm25Run>;
}): EvidenceBm25Run {
  const cacheKey = canonicalSerialize({
    corpusId: input.corpus.corpusId,
    queryContentHash: input.query.contentHash,
  });
  const cached = input.bm25WorkByContent.get(cacheKey);
  if (cached) return cached;
  const run = retrieveEvidenceByBm25({
    familyId: input.family.familyId,
    query: input.query,
    corpus: input.corpus,
    candidateLimit: input.candidateLimit,
  });
  input.bm25WorkByContent.set(cacheKey, run);
  return run;
}

function buildUnionBm25Run(input: {
  query: EvidenceQuery;
  corpus: EvidenceChunkCorpus;
  componentRuns: EvidenceBm25Run[];
  unionRunsByComponents: Map<string, EvidenceBm25Run>;
}): EvidenceBm25Run {
  const componentBm25RunIds = input.componentRuns
    .map((run) => run.bm25RunId)
    .sort(compareCodeUnits);
  const cacheKey = canonicalSerialize(componentBm25RunIds);
  const cached = input.unionRunsByComponents.get(cacheKey);
  if (cached) return cached;
  // The fused union honors the configured candidate limit so the reranker
  // never receives more candidates than the run asked for.
  const configuration = input.componentRuns[0]!.configuration;
  const candidates = unionBm25Candidates(
    input.componentRuns,
    configuration.candidateLimit,
  );
  const queryTerms = uniqueSorted(
    input.componentRuns.flatMap((run) => run.queryTerms),
  );
  const rankingContentHash = canonicalSha256({
    queryTerms,
    candidates,
    componentBm25RunIds,
  });
  const run = evidenceBm25RunSchema.parse({
    bm25RunId: buildEvidenceBm25RunId({
      queryText: input.query.text,
      corpusId: input.corpus.corpusId,
      corpusChunkIds: input.corpus.chunks.map((chunk) => chunk.chunkId),
      configuration,
      rankingContentHash,
      componentBm25RunIds,
    }),
    familyId: input.query.familyId,
    queryId: input.query.queryId,
    queryText: input.query.text,
    queryTerms,
    corpusId: input.corpus.corpusId,
    corpusChunkIds: input.corpus.chunks.map((chunk) => chunk.chunkId),
    configuration,
    status: candidates.length > 0 ? "matched" : "no_lexical_matches",
    candidates,
    componentBm25RunIds,
    rankingContentHash,
  });
  input.unionRunsByComponents.set(cacheKey, run);
  return run;
}

function buildRerankRun(
  adapterResult: CanonicalEvidenceRerankerResult,
  query: EvidenceQuery,
  bm25Run: EvidenceBm25Run,
  topN: number,
): EvidenceRerankRun {
  const candidateChunkIds = bm25Run.candidates.map(
    (candidate) => candidate.chunkId,
  );
  if (adapterResult.status === "failed") {
    const code = evidenceRerankNonfatalFailureCodeSchema.parse(
      adapterResult.reasonCode,
    );
    return failedRerankRun({
      bm25Run,
      query,
      candidateChunkIds,
      topN,
      execution: adapterResult.execution,
      code,
      reason: adapterResult.reason,
    });
  }

  const parsedOutput = evidenceRerankOutputSchema.safeParse(
    adapterResult.rawOutput,
  );
  if (!parsedOutput.success) {
    return failedRerankRun({
      bm25Run,
      query,
      candidateChunkIds,
      topN,
      execution: adapterResult.execution,
      code: "invalid_response",
      reason: formatZodFailure("reranker output", parsedOutput.error),
    });
  }
  const rankingContentHash = canonicalSha256({
    status: "completed",
    results: parsedOutput.data.results,
  });
  const rerankRunId = buildEvidenceRerankRunId({
    bm25RunId: bm25Run.bm25RunId,
    candidateChunkIds,
    topN,
    execution: adapterResult.execution,
    outcomeContentHash: rankingContentHash,
  });
  const completed = evidenceRerankRunSchema.safeParse({
    rerankRunId,
    bm25RunId: bm25Run.bm25RunId,
    queryId: query.queryId,
    queryText: query.text,
    candidateChunkIds,
    topN,
    execution: adapterResult.execution,
    status: "completed",
    results: parsedOutput.data.results,
    rankingContentHash,
  });
  if (completed.success) return completed.data;
  return failedRerankRun({
    bm25Run,
    query,
    candidateChunkIds,
    topN,
    execution: adapterResult.execution,
    code: "invalid_response",
    reason: formatZodFailure("reranker output", completed.error),
  });
}

function failedRerankRun(input: {
  bm25Run: EvidenceBm25Run;
  query: EvidenceQuery;
  candidateChunkIds: string[];
  topN: number;
  execution: ModelExecution;
  code: z.infer<typeof evidenceRerankNonfatalFailureCodeSchema>;
  reason: string;
}): EvidenceRerankRun {
  const failure = { code: input.code, reason: input.reason };
  const rankingContentHash = canonicalSha256({
    status: "failed",
    results: [],
    failure,
  });
  const rerankRunId = buildEvidenceRerankRunId({
    bm25RunId: input.bm25Run.bm25RunId,
    candidateChunkIds: input.candidateChunkIds,
    topN: input.topN,
    execution: input.execution,
    outcomeContentHash: rankingContentHash,
  });
  return evidenceRerankRunSchema.parse({
    rerankRunId,
    bm25RunId: input.bm25Run.bm25RunId,
    queryId: input.query.queryId,
    queryText: input.query.text,
    candidateChunkIds: input.candidateChunkIds,
    topN: input.topN,
    execution: input.execution,
    status: "failed",
    results: [],
    failure,
    rankingContentHash,
  });
}

function buildFinalSelection(
  bm25Run: EvidenceBm25Run,
  rerankRun: EvidenceRerankRun | undefined,
  selectionLimit: number,
  family: ScopedFamily,
  corpus: EvidenceChunkCorpus,
): EvidenceSelection {
  // Scope grounding pins apply in both branches so that turning reranking on
  // changes one variable, not two.
  const usesRerank = rerankRun?.status === "completed";
  if (usesRerank) {
    const selected = selectEvidenceChunkIds({
      family,
      corpus,
      rankedCandidates: rerankRun.results,
      baseSource: "reranked",
      selectionLimit,
    });
    const identity = {
      bm25RunId: bm25Run.bm25RunId,
      rerankRunId: rerankRun.rerankRunId,
      rankingSource: selected.rankingSource,
      rankingId: rerankRun.rerankRunId,
      selectionLimit,
      selectedChunkIds: selected.selectedChunkIds,
      ...(selected.pinnedChunkIds.length > 0
        ? { pinnedChunkIds: selected.pinnedChunkIds }
        : {}),
    };
    return evidenceSelectionSchema.parse({
      selectionId: buildEvidenceSelectionId(identity),
      ...identity,
      selectionContentHash: canonicalSha256(selected.selectedChunkIds),
    });
  }

  const selected = selectEvidenceChunkIds({
    family,
    corpus,
    rankedCandidates: bm25Run.candidates,
    baseSource: "bm25",
    selectionLimit,
  });
  const identity = {
    bm25RunId: bm25Run.bm25RunId,
    rankingSource: selected.rankingSource,
    rankingId: bm25Run.bm25RunId,
    selectionLimit,
    selectedChunkIds: selected.selectedChunkIds,
    ...(selected.pinnedChunkIds.length > 0
      ? { pinnedChunkIds: selected.pinnedChunkIds }
      : {}),
  };
  return evidenceSelectionSchema.parse({
    selectionId: buildEvidenceSelectionId(identity),
    ...identity,
    selectionContentHash: canonicalSha256(selected.selectedChunkIds),
  });
}

function verifyEvidenceAncestors(
  prepareArtifact: PrepareArtifact,
  scopeArtifact: ScopeArtifact,
): void {
  if (
    prepareArtifact.runId !== scopeArtifact.runId ||
    prepareArtifact.payload.lineage.runId !== scopeArtifact.runId
  ) {
    throw new CanonicalEvidenceBoundaryError(
      "Canonical Prepare and Scope inputs belong to different runs",
    );
  }
  const scopeReference = prepareArtifact.payload.lineage.scopeArtifact;
  if (
    scopeReference.artifactId !== scopeArtifact.artifactId ||
    scopeReference.contentHash !== scopeArtifact.contentHash
  ) {
    throw new CanonicalEvidenceBoundaryError(
      "Canonical Prepare does not reference the supplied Scope artifact ID and content hash",
    );
  }
  if (
    canonicalSerialize(prepareArtifact.payload.scopedFamilies) !==
    canonicalSerialize(scopeArtifact.payload.families)
  ) {
    throw new CanonicalEvidenceBoundaryError(
      "Canonical Prepare does not preserve the supplied Scope family ledger",
    );
  }
  const familiesById = new Map(
    scopeArtifact.payload.families.map((family) => [family.familyId, family]),
  );
  for (const record of prepareArtifact.payload.records) {
    const family = familiesById.get(record.familyId);
    if (
      !family ||
      canonicalSerialize(record.family) !== canonicalSerialize(family)
    ) {
      throw new CanonicalEvidenceBoundaryError(
        `Prepare record differs from its exact Scope family: ${record.recordId}`,
      );
    }
  }
}

function verifyCorpusAgainstScope(
  corpus: EvidenceChunkCorpus,
  materialization: ScopeSeedMaterialization & { status: "materialized" },
): void {
  const blocksById = new Map(
    materialization.blocks.map((block) => [block.blockId, block]),
  );
  for (const chunk of corpus.chunks) {
    const block = blocksById.get(chunk.sourceBlockId);
    if (!block) {
      throw new CanonicalEvidenceBoundaryError(
        `Evidence chunk references an unknown Scope seed-text block: ${chunk.chunkId}`,
      );
    }
    const relativeStart = chunk.charOffsetStart - block.charOffsetStart;
    const relativeEnd = chunk.charOffsetEnd - block.charOffsetStart;
    if (
      relativeStart < 0 ||
      relativeEnd > block.text.length ||
      block.text.slice(relativeStart, relativeEnd) !== chunk.text ||
      chunk.sourceBlockKind !== block.blockKind ||
      chunk.sourceSectionTitle !== block.sectionTitle ||
      canonicalSerialize(chunk.sourceArtifact) !==
        canonicalSerialize(materialization.seedTextArtifact)
    ) {
      throw new CanonicalEvidenceBoundaryError(
        `Evidence chunk is not an exact span of its Scope seed-text block: ${chunk.chunkId}`,
      );
    }
  }
}

function buildEvidenceLineage(
  prepareArtifact: PrepareArtifact,
  scopeArtifact: ScopeArtifact,
  options: z.output<typeof canonicalEvidenceOptionsSchema>,
): EvidenceLineage {
  return {
    runId: prepareArtifact.runId,
    prepareArtifact: {
      artifactId: prepareArtifact.artifactId,
      contentHash: prepareArtifact.contentHash,
      role: "canonical-prepare-input",
      canonicalStage: "prepare",
      ...(options.prepareArtifactUri
        ? { uri: options.prepareArtifactUri }
        : {}),
    },
    scopeArtifact: {
      artifactId: scopeArtifact.artifactId,
      contentHash: scopeArtifact.contentHash,
      role: "canonical-scope-input",
      canonicalStage: "scope",
      ...(options.scopeArtifactUri ? { uri: options.scopeArtifactUri } : {}),
    },
  };
}

function createEvidenceDecisions(
  payload: EvidenceArtifactPayload,
  recordedAt: string,
  lineage: EvidenceLineage,
): AppendOnlyDecision[] {
  const rerankRunsById = new Map(
    payload.rerankRuns.map((run) => [run.rerankRunId, run]),
  );
  return payload.records
    .flatMap((record) => {
      const rerankRun = record.rerankRunId
        ? rerankRunsById.get(record.rerankRunId)
        : undefined;
      const baseArtifacts = [lineage.prepareArtifact, lineage.scopeArtifact];
      const rerankArtifacts = rerankRun
        ? [
            rerankRun.execution.requestArtifact,
            rerankRun.execution.responseArtifact,
          ]
        : [];
      return [
        createAppendOnlyDecision({
          recordId: record.recordId,
          decisionType: "evidence_retrieval_outcome",
          outcome: record.retrievalStatus,
          reason: retrievalReason(record),
          recordedAt,
          actor: {
            kind: "deterministic",
            identifier: "canonical-evidence-bm25-v1",
          },
          evidenceArtifacts: baseArtifacts,
        }),
        createAppendOnlyDecision({
          recordId: record.recordId,
          decisionType: "evidence_rerank_outcome",
          outcome: record.rerankStatus,
          reason: rerankReason(record, rerankRun),
          recordedAt,
          actor: rerankRun
            ? {
                kind: "model",
                identifier: `${rerankRun.execution.provider}/${rerankRun.execution.model}`,
              }
            : {
                kind: "deterministic",
                identifier: "canonical-evidence-rerank-policy-v1",
              },
          evidenceArtifacts: uniqueSortedArtifactReferences([
            ...baseArtifacts,
            ...rerankArtifacts,
          ]),
        }),
        createAppendOnlyDecision({
          recordId: record.recordId,
          decisionType: "evidence_final_selection",
          outcome: record.finalSelectionId ? "selected" : "not_available",
          reason: selectionReason(record, payload),
          recordedAt,
          actor: {
            kind: "deterministic",
            identifier: "canonical-evidence-selection-v1",
          },
          evidenceArtifacts: uniqueSortedArtifactReferences([
            ...baseArtifacts,
            ...rerankArtifacts,
          ]),
        }),
      ];
    })
    .sort((left, right) => compareCodeUnits(left.decisionId, right.decisionId));
}

function retrievalReason(record: EvidenceRecordOutcome): string {
  switch (record.retrievalStatus) {
    case "retrieved":
      return "Deterministic BM25 produced lexical evidence candidates from the exact Scope seed text.";
    case "no_lexical_matches":
      return "Deterministic BM25 produced no positive lexical matches; seed text was available and retrieval completed.";
    case "seed_text_unavailable":
      return "Scope recorded that no inspectable seed manuscript text was available.";
    case "seed_acquisition_failed":
      return "Scope recorded an operational seed-manuscript acquisition failure.";
    case "retrieval_failed":
      return `Deterministic evidence retrieval failed (${record.failure?.code ?? "unknown"}): ${record.failure?.reason ?? "No failure reason was preserved."}`;
  }
}

function rerankReason(
  record: EvidenceRecordOutcome,
  rerankRun: EvidenceRerankRun | undefined,
): string {
  switch (record.rerankStatus) {
    case "disabled":
      return "Optional model reranking was explicitly disabled; no reranker call was made.";
    case "not_attempted_no_candidates":
      return "Reranking was enabled but BM25 supplied no candidates, so no reranker call was made.";
    case "not_attempted_unavailable":
      return "Reranking was enabled but exact Scope seed text was unavailable, so no reranker call was made.";
    case "not_attempted_retrieval_failure":
      return "Reranking was enabled but deterministic retrieval failed before candidates existed.";
    case "completed":
      return "The relevance-only reranker produced a separate immutable ranking of the supplied BM25 candidates.";
    case "failed":
      return rerankRun?.status === "failed"
        ? `The relevance-only reranker failed nonfatally (${rerankRun.failure.code}): ${rerankRun.failure.reason} BM25 remained available and unchanged.`
        : "The relevance-only reranker failed nonfatally; BM25 remained available and unchanged.";
  }
}

function selectionReason(
  record: EvidenceRecordOutcome,
  payload: EvidenceArtifactPayload,
): string {
  if (!record.finalSelectionId) {
    switch (record.retrievalStatus) {
      case "no_lexical_matches":
        return "No final evidence selection exists because BM25 produced no lexical candidates.";
      case "seed_text_unavailable":
        return "No final evidence selection was possible because Scope seed text was unavailable.";
      case "seed_acquisition_failed":
        return "No final evidence selection was possible because Scope seed acquisition failed.";
      case "retrieval_failed":
        return "No final evidence selection was possible because deterministic retrieval failed.";
      case "retrieved":
        return "No final evidence selection was recorded despite retrieved candidates.";
    }
  }
  const selection = payload.selections.find(
    (entry) => entry.selectionId === record.finalSelectionId,
  );
  return selection?.rankingSource === "reranked"
    ? "Final evidence references the top exact chunks from the separate relevance-reranked version."
    : "Final evidence references the top exact chunks from the immutable BM25 version.";
}

function throwIfFatalRerankFailure(
  result: CanonicalEvidenceRerankerResult,
): void {
  if (result.status !== "failed") return;
  const fatal = evidenceRerankFatalFailureCodeSchema.safeParse(
    result.reasonCode,
  );
  if (fatal.success) {
    throw new CanonicalEvidenceFatalError(fatal.data, result.reason);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const parseBoundary = createBoundaryParser(CanonicalEvidenceBoundaryError);

function formatZodFailure(label: string, error: z.ZodError): string {
  const issue = error.issues[0];
  return `${label} at ${issue?.path.join(".") || "<root>"}: ${issue?.message ?? error.message}`;
}
