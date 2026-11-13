/** Pure, versioned Jev task construction and answer validation. */
import { z } from "zod";
import {
  CITATION_ROLE_DEFINITIONS,
  CITATION_ROLE_GUIDANCE,
  rubricCriteria,
} from "../domain/rubric.js";
import { canonicalSha256, buildStableId } from "../shared/stable-identity.js";
import { compareCodeUnits } from "../shared/order.js";
import type { ProviderConfig } from "./config.js";
import type { EvaluationCase } from "./types.js";
import { evaluationRoleSchema } from "./types.js";
import type {
  JevRequestSpec,
  JevResult,
  JevVariant,
} from "./optimization-contract.js";

/** Part of every request hash; v3 took the role rubric from production. */
const RUBRIC_REVISION = "jev-citation-tasks-v3";
const ROLE_CRITERIA = rubricCriteria(CITATION_ROLE_DEFINITIONS);
const RELEVANCE_CRITERIA = [
  "Irrelevant to the query, including material that cannot resolve it.",
  "Contextual information related to the query but not direct evidence.",
  "Direct evidence about the query, including contradictory findings and qualifying conditions.",
] as const;
const RELEVANCE_INSTRUCTION =
  "Score this cited-paper passage for relevance to the query only; do not decide citation fidelity. Contradictory findings and qualifying conditions are directly relevant. Prefer the seed paper's own results, figures, and tables over background prose. A passage that cites other work may summarize prior findings rather than report the seed's own. Candidate order carries no information.";

type RerankCase = Extract<EvaluationCase, { task: "rerank" }>;
type Passage = RerankCase["candidates"][number];

function scientificPassage(candidate: Passage) {
  return {
    text: candidate.text,
    sourceBlockKind: candidate.sourceBlockKind,
    sectionTitle: candidate.sectionTitle ?? null,
    sectionRole: candidate.sectionRole ?? null,
    citesOtherWork: candidate.citesOtherWork ?? null,
  };
}

function endpointIdentity(provider: ProviderConfig): string {
  return (
    provider.endpoint ??
    (provider.endpointEnv ? process.env[provider.endpointEnv] : undefined) ??
    "https://api.typesafe.ai/v1/systemone"
  );
}

function spec(input: {
  caseId: string;
  variant: JevVariant;
  provider: ProviderConfig;
  batchIndex: number;
  body: unknown;
  answerMap: Record<string, string>;
  candidateIds: string[];
}): JevRequestSpec {
  const requestHash = canonicalSha256({
    rubricRevision: RUBRIC_REVISION,
    endpoint: endpointIdentity(input.provider),
    model: input.provider.model,
    inferenceSettings: input.provider.inferenceSettings ?? null,
    body: input.body,
    batchComposition: input.candidateIds,
  });
  return {
    requestId: buildStableId("jev-request", {
      caseId: input.caseId,
      variantId: input.variant.id,
      repetition: input.variant.repetition,
      batchIndex: input.batchIndex,
      requestHash,
    }),
    requestHash,
    variantId: input.variant.id,
    caseId: input.caseId,
    batchIndex: input.batchIndex,
    body: input.body,
    answerMap: input.answerMap,
    candidateIds: input.candidateIds,
  };
}

/** One role request or all fixed-size batches of a complete reranking case. */
export function buildJevRequestSpecs(
  caseInput: EvaluationCase,
  variant: JevVariant,
  provider: ProviderConfig,
): JevRequestSpec[] {
  if (provider.kind !== "jev")
    throw new Error("Jev task builder requires a Jev provider");
  if (caseInput.task !== variant.task)
    throw new Error("Variant and case task differ");
  if (caseInput.task === "role") {
    if (variant.layout !== "role-v2")
      throw new Error("Role requires role-v2 layout");
    if (!caseInput.roleInput)
      throw new Error("Role-v2 requires a v2 frozen role input");
    const body = {
      model: provider.model,
      state: {
        markedCitingContext: caseInput.roleInput.markedContext,
        verifiedSupportSpans: caseInput.roleInput.supportSpans,
        extractedClaims: caseInput.claims,
        sectionHeading: caseInput.roleInput.sectionTitle,
        seedReference: caseInput.roleInput.seedRefLabel,
        citationMarker: caseInput.roleInput.citationMarker,
        bundledCitation: {
          isBundled: caseInput.roleInput.isBundledCitation,
          numberOfReferences: caseInput.roleInput.bundleSize,
        },
      },
      questions: {
        decision: {
          type: "choice",
          instructions: {
            task: "Classify what the citing paper does with this cited reference.",
            scope:
              "Only sentences marked ▶ ... ◀ are attributed to this reference; use the full context to interpret them.",
            guidance: CITATION_ROLE_GUIDANCE,
          },
          criteria: ROLE_CRITERIA,
        },
      },
    };
    return [
      spec({
        caseId: caseInput.caseId,
        variant,
        provider,
        batchIndex: 0,
        body,
        answerMap: { decision: "role" },
        candidateIds: [],
      }),
    ];
  }
  if (caseInput.task !== "rerank" || variant.layout === "role-v2")
    throw new Error("Unsupported Jev task/layout");
  const batchSize = variant.batchSize ?? provider.rerankBatchSize ?? 20;
  const candidates = [...caseInput.candidates].sort((a, b) =>
    compareCodeUnits(a.chunkId, b.chunkId),
  );
  const batches = Array.from(
    { length: Math.ceil(candidates.length / batchSize) },
    (_, index) => candidates.slice(index * batchSize, (index + 1) * batchSize),
  );
  return batches.map((batch, batchIndex) => {
    const ordered =
      variant.questionOrder === "reversed" ? [...batch].reverse() : batch;
    const answerMap = Object.fromEntries(
      ordered.map((candidate, index) => [
        `passage_${String(index + 1)}`,
        candidate.chunkId,
      ]),
    );
    const passages = ordered.map(scientificPassage);
    const questions = Object.fromEntries(
      ordered.map((candidate, index) => [
        `passage_${String(index + 1)}`,
        {
          type: "score",
          instructions:
            variant.layout === "shared-passages"
              ? {
                  task: RELEVANCE_INSTRUCTION,
                  passage: `passages[${String(index)}]`,
                }
              : {
                  task: RELEVANCE_INSTRUCTION,
                  passage: scientificPassage(candidate),
                },
          criteria: RELEVANCE_CRITERIA,
        },
      ]),
    );
    const body = {
      model: provider.model,
      state:
        variant.layout === "shared-passages"
          ? { query: caseInput.query, passages }
          : { query: caseInput.query },
      questions,
    };
    return spec({
      caseId: caseInput.caseId,
      variant,
      provider,
      batchIndex,
      body,
      answerMap,
      candidateIds: ordered.map((candidate) => candidate.chunkId),
    });
  });
}

const answerBase = z.object({
  confidence: z.number().min(0).max(1).optional(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
});
const choiceAnswer = answerBase.extend({
  type: z.literal("choice"),
  choice: evaluationRoleSchema,
});
const scoreAnswer = answerBase.extend({
  type: z.literal("score"),
  score: z.number().min(0).max(2),
});
const responseSchema = z.object({ answers: z.record(z.string(), z.unknown()) });

function assertDistribution(
  values: Record<string, number> | undefined,
  keys: readonly string[],
): void {
  if (!values) return;
  if (
    Object.keys(values).length !== keys.length ||
    keys.some((key) => values[key] == null)
  )
    throw new Error("Answer distribution has unexpected levels");
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 0.05)
    throw new Error("Answer distribution does not sum to one");
}

/** Require every expected answer exactly once; preserve scores and uncertainty separately. */
export function parseJevResult(
  request: JevRequestSpec,
  response: unknown,
  attemptId = request.requestId,
): JevResult {
  const parsed = responseSchema.parse(response);
  const expected = Object.keys(request.answerMap);
  const actual = Object.keys(parsed.answers);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(parsed.answers, key))
  )
    throw new Error("Jev answer keys do not match request questions");
  const common = {
    requestId: request.requestId,
    requestHash: request.requestHash,
    variantId: request.variantId,
    caseId: request.caseId,
    attemptId,
  };
  if (request.answerMap.decision === "role") {
    const answer = choiceAnswer.parse(parsed.answers.decision);
    assertDistribution(answer.probabilities, evaluationRoleSchema.options);
    return {
      ...common,
      role: answer.choice,
      ...(answer.probabilities
        ? { roleProbabilities: answer.probabilities }
        : {}),
      ...(answer.confidence != null
        ? { roleConfidence: answer.confidence }
        : {}),
    };
  }
  const scores: NonNullable<JevResult["scores"]> = {};
  for (const key of expected) {
    const chunkId = request.answerMap[key];
    if (!chunkId || !request.candidateIds.includes(chunkId))
      throw new Error("Question maps to an unknown passage");
    const answer = scoreAnswer.parse(parsed.answers[key]);
    assertDistribution(answer.probabilities, ["0", "1", "2"]);
    scores[chunkId] = {
      score: answer.score,
      ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
      ...(answer.confidence != null ? { confidence: answer.confidence } : {}),
    };
  }
  if (Object.keys(scores).length !== request.candidateIds.length)
    throw new Error("Passage coverage is incomplete");
  return { ...common, scores };
}

/** Six invented calls check both question layouts, role context, and answer coverage. */
export function buildJevFixtureRequestSpecs(
  provider: ProviderConfig,
): JevRequestSpec[] {
  const base = {
    runId: "fixture",
    seedDoi: "10.fixture/example",
    recordId: "fixture",
    sourceArtifactHashes: { fixture: "invented" },
  };
  const roleCases: Extract<EvaluationCase, { task: "role" }>[] = [
    {
      ...base,
      caseId: "fixture-role-bundled",
      task: "role",
      occurrenceId: "fixture-role-bundled",
      context: "Prior work found the effect (Ada, 2024; Bea, 2024).",
      claims: ["Prior work found the effect"],
      deterministicRole: "unclear",
      deterministicUnclear: true,
      anthropicPrompt: "fixture",
      roleInput: {
        markedContext:
          "▶ Prior work found the effect (Ada, 2024; Bea, 2024). ◀",
        citationMarker: "(Ada, 2024; Bea, 2024)",
        supportSpans: ["Prior work found the effect"],
        sectionTitle: "Results",
        seedRefLabel: "Ada, 2024",
        isBundledCitation: true,
        bundleSize: 2,
      },
    },
    {
      ...base,
      caseId: "fixture-role-method",
      task: "role",
      occurrenceId: "fixture-role-method",
      context: "We followed the protocol of Ada (2024).",
      claims: ["followed the protocol"],
      deterministicRole: "methods_materials",
      deterministicUnclear: false,
      anthropicPrompt: "fixture",
      roleInput: {
        markedContext: "▶ We followed the protocol of Ada (2024). ◀",
        citationMarker: "Ada (2024)",
        supportSpans: ["followed the protocol"],
        sectionTitle: "Methods",
        seedRefLabel: "Ada, 2024",
        isBundledCitation: false,
        bundleSize: 1,
      },
    },
  ];
  const rerankCases: RerankCase[] = [
    {
      ...base,
      caseId: "fixture-rerank-contradiction",
      task: "rerank",
      query: "The treatment increased survival",
      candidates: [
        {
          chunkId: "fixture-a",
          text: "Survival was unchanged after treatment.",
          sourceBlockKind: "body_paragraph",
          sectionRole: "results",
          citesOtherWork: false,
        },
        {
          chunkId: "fixture-b",
          text: "The introduction discusses survival in earlier trials.",
          sourceBlockKind: "body_paragraph",
          sectionRole: "introduction",
          citesOtherWork: true,
        },
      ],
      pinnedPassages: [],
      bm25Order: ["fixture-a", "fixture-b"],
      pinnedChunkIds: [],
      selectionLimit: 2,
    },
    {
      ...base,
      caseId: "fixture-rerank-qualification",
      task: "rerank",
      query: "The treatment increased survival",
      candidates: [
        {
          chunkId: "fixture-c",
          text: "Survival increased only at the high dose.",
          sourceBlockKind: "table",
          sectionRole: "results",
          citesOtherWork: false,
        },
        {
          chunkId: "fixture-d",
          text: "Methods for administering the treatment.",
          sourceBlockKind: "body_paragraph",
          sectionRole: "methods",
          citesOtherWork: false,
        },
      ],
      pinnedPassages: [],
      bm25Order: ["fixture-c", "fixture-d"],
      pinnedChunkIds: [],
      selectionLimit: 2,
    },
  ];
  const role = roleCases.flatMap((item) =>
    buildJevRequestSpecs(
      item,
      {
        id: `fixture-${item.caseId}`,
        task: "role",
        layout: "role-v2",
        questionOrder: "stable",
        repetition: 1,
        phase: "fixture",
      },
      provider,
    ),
  );
  const rerank = rerankCases.flatMap((item) =>
    (["shared-passages", "passage-per-question"] as const).flatMap((layout) =>
      buildJevRequestSpecs(
        item,
        {
          id: `fixture-${layout}-${item.caseId}`,
          task: "rerank",
          layout,
          batchSize: 2,
          questionOrder: "stable",
          repetition: 1,
          phase: "fixture",
        },
        provider,
      ),
    ),
  );
  return [...role, ...rerank];
}

/** Endpoint fixtures must show the intended task behavior before corpus work starts. */
export function validateJevFixtureResult(
  request: JevRequestSpec,
  result: JevResult,
): boolean {
  if (request.caseId === "fixture-role-bundled")
    return result.role === "substantive_attribution";
  if (request.caseId === "fixture-role-method")
    return result.role === "methods_materials";
  if (request.caseId === "fixture-rerank-contradiction")
    return (
      (result.scores?.["fixture-a"]?.score ?? -1) >= 1 &&
      (result.scores?.["fixture-a"]?.score ?? -1) >
        (result.scores?.["fixture-b"]?.score ?? -1)
    );
  if (request.caseId === "fixture-rerank-qualification")
    return (
      (result.scores?.["fixture-c"]?.score ?? -1) >= 1 &&
      (result.scores?.["fixture-c"]?.score ?? -1) >
        (result.scores?.["fixture-d"]?.score ?? -1)
    );
  throw new Error(`Unknown Jev fixture ${request.caseId}`);
}
