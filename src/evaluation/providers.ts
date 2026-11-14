import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  CITATION_ROLE_DEFINITIONS,
  CITATION_ROLE_GUIDANCE,
  FIDELITY_BOUNDARY_GUIDANCE,
  rubricCriteria,
  verdictDefinitionsOnly,
} from "../domain/rubric.js";
import {
  LLMProviderError,
  type LLMCallRecord,
  type LLMClient,
} from "../integrations/llm-client.js";
import { pythonSpanToJs, resolveExactQuote } from "./span.js";
import {
  evaluationRoleSchema,
  evaluationVerdictSchema,
  type EvaluationCase,
} from "./types.js";
import type { ProviderConfig } from "./config.js";
import { priceCall } from "./cost.js";
import {
  fetchJev,
  jevAccessError,
  jevBackoffMs,
  type JevTransport,
} from "./jev-transport.js";
import { adjudicateModelResponseSchema } from "../stages/adjudicate/adapters.js";
import {
  buildRelevanceRerankPrompt,
  rerankModelResponseSchema,
} from "../stages/evidence/prompts.js";
import { citationRoleResponseSchema } from "../stages/prepare/prompts.js";

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
  confidence: z.number().min(0).max(1).optional(),
});
const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
const spanAnswerSchema = z.object({
  type: z.literal("span"),
  found: z.boolean(),
  text: z.string().nullable().optional(),
  start: z.number().int().nullable().optional(),
  end: z.number().int().nullable().optional(),
  confidence: z.number().optional(),
});
const jevResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().nonnegative(),
      output_tokens: z.number().nonnegative(),
    })
    .optional(),
});

export type ProviderPrediction =
  | { role: string }
  | { rankedChunkIds: string[]; relevance: Record<string, number> }
  | { span: { start: number; end: number; text: string } | null }
  | { verdict: string };
export type ProviderCall = {
  servedModel: string;
  latencyMs: number;
  sequence?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  promptCacheReadTokens?: number;
  promptCacheWriteTokens?: number;
};
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly category:
      | "authentication"
      | "quota"
      | "context_limit"
      | "invalid_response"
      | "provider_failure",
    readonly partialCalls: ProviderCall[] = [],
    readonly diagnostics?: unknown,
  ) {
    super(message);
  }
}

export type RequestBudget = {
  call: (
    body: unknown,
    signal: AbortSignal,
  ) => Promise<{
    body: unknown;
    call: ProviderCall;
    retryCalls?: ProviderCall[];
  }>;
};

function httpCategory(status: number): ProviderRequestError["category"] {
  if (status === 401 || status === 403) return "authentication";
  if (status === 402 || status === 429) return "quota";
  if (status === 413) return "context_limit";
  return "provider_failure";
}

/**
 * Sends a provider's Jev requests at most one per
 * `minimumRequestIntervalMs`, retrying a gateway failure (502 to 504) up to
 * `maxTransientRetries` times. Every attempt counts against the experiment.
 */
export function createRequestBudget(
  provider: ProviderConfig,
  countRequest: () => number,
  transport: JevTransport = fetchJev,
): RequestBudget {
  const accessError = jevAccessError(provider);
  if (accessError) throw new Error(accessError);
  let nextDispatchAt = 0;
  return {
    async call(body, signal) {
      const attempts: ProviderCall[] = [];
      for (let retry = 0; ; retry++) {
        const dispatchAt = Math.max(Date.now(), nextDispatchAt);
        nextDispatchAt = dispatchAt + (provider.minimumRequestIntervalMs ?? 0);
        await sleep(dispatchAt - Date.now(), undefined, { signal });
        const sequence = countRequest();
        const started = performance.now();
        const attempt = (): ProviderCall => ({
          servedModel: "unknown",
          latencyMs: performance.now() - started,
          sequence,
        });
        let response: Awaited<ReturnType<JevTransport>>;
        try {
          response = await transport(provider, body, signal);
        } catch (error) {
          throw new ProviderRequestError(
            String(error),
            "provider_failure",
            [...attempts, attempt()],
            { request: body, retry },
          );
        }
        const call = attempt();
        const status = response.httpStatus;
        if (status < 200 || status >= 300) {
          attempts.push(call);
          if (
            [502, 503, 504].includes(status) &&
            retry < (provider.maxTransientRetries ?? 0)
          ) {
            await sleep(
              response.retryAfterMs ?? jevBackoffMs(2000, retry),
              undefined,
              { signal },
            );
            continue;
          }
          throw new ProviderRequestError(
            `HTTP ${status}`,
            httpCategory(status),
            attempts,
            {
              request: body,
              status,
              retries: retry,
              ...(response.diagnostics
                ? { response: response.diagnostics }
                : {}),
            },
          );
        }
        const parsed = jevResponseSchema.safeParse(response.body);
        if (!parsed.success)
          throw new ProviderRequestError(
            `Invalid Jev response: ${parsed.error.message}`,
            "invalid_response",
            [...attempts, call],
            { request: body, response: response.body, retries: retry },
          );
        const usage = parsed.data.usage;
        return {
          body: parsed.data,
          call: {
            ...call,
            servedModel: parsed.data.model,
            ...(usage
              ? {
                  inputTokens: usage.input_tokens,
                  outputTokens: usage.output_tokens,
                }
              : {}),
          },
          ...(attempts.length ? { retryCalls: attempts } : {}),
        };
      }
    },
  };
}

/**
 * The question a Jev provider answers, worded from the production
 * rubric. Changing it needs a new evaluation prompt revision.
 */
function jevQuestion(caseInput: EvaluationCase): {
  state: unknown;
  questions: Record<string, unknown>;
} {
  if (caseInput.task === "role")
    return {
      state: {
        text: caseInput.context,
        claims: caseInput.claims,
        section: caseInput.sectionTitle,
        seedReference: caseInput.seedRefLabel,
      },
      questions: {
        decision: {
          type: "choice",
          instructions: `Classify what the citing paper does with this cited reference. ${CITATION_ROLE_GUIDANCE}`,
          criteria: rubricCriteria(CITATION_ROLE_DEFINITIONS),
        },
      },
    };
  if (caseInput.task === "adjudication")
    return {
      state: caseInput.packet,
      questions: {
        decision: {
          type: "choice",
          instructions: `Compare only the citing attribution with the selected cited-paper evidence; contradictions and qualifying conditions matter. ${FIDELITY_BOUNDARY_GUIDANCE}`,
          criteria: rubricCriteria(verdictDefinitionsOnly()),
        },
      },
    };
  if (caseInput.task === "span")
    return {
      state: { text: caseInput.context, claim: caseInput.claim },
      questions: {
        decision: {
          type: "span",
          instructions:
            "The shortest contiguous text in text that supports the extracted claim. If no valid span exists, return found=false.",
        },
      },
    };
  throw new Error("Rerank uses passage pair questions");
}

function validDistribution(
  values: Record<string, number>,
  expected: readonly string[],
): boolean {
  if (
    Object.keys(values).length !== expected.length ||
    expected.some((key) => values[key] == null)
  )
    return false;
  const sum = Object.values(values).reduce((total, value) => total + value, 0);
  return Math.abs(sum - 1) <= 0.05;
}

/** A Jev request body: the model, the question, and any inference settings. */
function jevBody(provider: ProviderConfig, content: object): object {
  return { model: provider.model, ...content, ...provider.inferenceSettings };
}

async function executeJev(
  input: EvaluationCase,
  provider: ProviderConfig,
  budget: RequestBudget,
  signal: AbortSignal,
): Promise<{
  prediction: ProviderPrediction;
  calls: ProviderCall[];
  diagnostics: unknown;
}> {
  if (input.task === "rerank") {
    const scores: Record<string, number> = {};
    const calls: ProviderCall[] = [];
    const exchanges: { request: unknown; response: unknown }[] = [];
    const batchSize = provider.rerankBatchSize ?? 1;
    const candidates = [...input.candidates].sort((a, b) =>
      a.chunkId.localeCompare(b.chunkId),
    );
    // Passage order is independent of BM25 ranking. Every pair gets its own score question.
    const batches = Array.from(
      { length: Math.ceil(candidates.length / batchSize) },
      (_, index) =>
        candidates.slice(index * batchSize, (index + 1) * batchSize),
    );
    while (batches.length) {
      const batch = batches.shift()!;
      const body =
        batch.length === 1
          ? jevBody(provider, {
              state: {
                query: input.query,
                passage: batch[0]!.text,
                sectionTitle: batch[0]!.sectionTitle,
                sectionRole: batch[0]!.sectionRole,
                citesOtherWork: batch[0]!.citesOtherWork,
              },
              questions: {
                decision: {
                  type: "score",
                  instructions:
                    "How relevant is this cited-paper passage to the claim? Contradictory evidence and qualifying conditions are directly relevant.",
                  criteria: ["irrelevant", "contextual", "directly relevant"],
                },
              },
            })
          : jevBody(provider, {
              state: {
                query: input.query,
                passages: batch.map((candidate) => ({
                  text: candidate.text,
                  sectionTitle: candidate.sectionTitle,
                  sectionRole: candidate.sectionRole,
                  citesOtherWork: candidate.citesOtherWork,
                })),
              },
              questions: Object.fromEntries(
                batch.map((_, index) => [
                  `passage_${index + 1}`,
                  {
                    type: "score",
                    instructions: `Score only passages[${index}] for relevance to the query. Contradictory evidence and qualifying conditions are directly relevant.`,
                    criteria: ["irrelevant", "contextual", "directly relevant"],
                  },
                ]),
              ),
            });
      try {
        if (
          provider.maxContextCharacters != null &&
          JSON.stringify(body).length > provider.maxContextCharacters
        )
          throw new ProviderRequestError(
            "Pair exceeds configured context limit",
            "context_limit",
          );
        const result = await budget.call(body, signal);
        const response = jevResponseSchema.parse(result.body);
        calls.push(
          ...(result.retryCalls ?? []),
          priceCall(result.call, provider),
        );
        exchanges.push({ request: body, response });
        for (const [index, candidate] of batch.entries()) {
          const answer = scoreAnswerSchema.safeParse(
            response.answers[
              batch.length === 1 ? "decision" : `passage_${index + 1}`
            ],
          );
          if (
            !answer.success ||
            answer.data.score < 0 ||
            answer.data.score > 2 ||
            (answer.data.probabilities &&
              !validDistribution(answer.data.probabilities, ["0", "1", "2"]))
          )
            throw new ProviderRequestError(
              "Invalid relevance score",
              "invalid_response",
            );
          scores[candidate.chunkId] = answer.data.score;
        }
      } catch (error) {
        if (
          error instanceof ProviderRequestError &&
          error.message === "HTTP 503" &&
          provider.rerankMinFallbackBatchSize != null &&
          batch.length > provider.rerankMinFallbackBatchSize
        ) {
          calls.push(...error.partialCalls);
          exchanges.push({
            request: body,
            response: {
              error: error.message,
              attempts: error.partialCalls.length,
            },
          });
          const middle = Math.ceil(batch.length / 2);
          batches.unshift(batch.slice(0, middle), batch.slice(middle));
          continue;
        }
        if (error instanceof ProviderRequestError)
          throw new ProviderRequestError(
            error.message,
            error.category,
            [...calls, ...error.partialCalls],
            { exchanges, failed: error.diagnostics ?? { request: body } },
          );
        throw error;
      }
    }
    const rankedChunkIds = input.candidates
      .map((candidate) => candidate.chunkId)
      .sort(
        (a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a.localeCompare(b),
      );
    return {
      prediction: { rankedChunkIds, relevance: scores },
      calls,
      diagnostics: { exchanges },
    };
  }
  const body = jevBody(provider, jevQuestion(input));
  if (
    provider.maxContextCharacters != null &&
    JSON.stringify(body).length > provider.maxContextCharacters
  )
    throw new ProviderRequestError(
      "Case exceeds configured context limit",
      "context_limit",
    );
  const result = await budget.call(body, signal);
  const response = jevResponseSchema.parse(result.body);
  const successfulCalls = [
    ...(result.retryCalls ?? []),
    priceCall(result.call, provider),
  ];
  if (input.task === "span") {
    const answer = spanAnswerSchema.safeParse(response.answers.decision);
    if (!answer.success)
      throw new ProviderRequestError(
        "Invalid native span answer",
        "invalid_response",
      );
    if (!answer.data.found)
      return {
        prediction: { span: null },
        calls: [
          ...successfulCalls.slice(0, -1),
          priceCall(
            {
              ...result.call,
              ...(answer.data.confidence != null
                ? { confidence: answer.data.confidence }
                : {}),
            },
            provider,
          ),
        ],
        diagnostics: { request: body, response },
      };
    if (
      answer.data.start == null ||
      answer.data.end == null ||
      answer.data.text == null
    )
      throw new ProviderRequestError(
        "Incomplete native span",
        "invalid_response",
      );
    const span = pythonSpanToJs(
      input.context,
      answer.data.start,
      answer.data.end,
    );
    if (span.text !== answer.data.text)
      throw new ProviderRequestError(
        "Native span offsets do not match context",
        "invalid_response",
      );
    return {
      prediction: { span },
      calls: [
        ...successfulCalls.slice(0, -1),
        priceCall(
          {
            ...result.call,
            ...(answer.data.confidence != null
              ? { confidence: answer.data.confidence }
              : {}),
          },
          provider,
        ),
      ],
      diagnostics: { request: body, response },
    };
  }
  const answer = choiceAnswerSchema.safeParse(response.answers.decision);
  if (!answer.success)
    throw new ProviderRequestError(
      "Invalid choice answer",
      "invalid_response",
      successfulCalls,
    );
  const allowed =
    input.task === "role"
      ? evaluationRoleSchema.options
      : evaluationVerdictSchema.options;
  if (
    !allowed.includes(answer.data.choice as never) ||
    !validDistribution(answer.data.probabilities, allowed)
  )
    throw new ProviderRequestError(
      "Choice or distribution outside rubric",
      "invalid_response",
      successfulCalls,
    );
  return {
    prediction:
      input.task === "role"
        ? { role: answer.data.choice }
        : { verdict: answer.data.choice },
    calls: [
      ...successfulCalls.slice(0, -1),
      priceCall(
        {
          ...result.call,
          ...(answer.data.confidence != null
            ? { confidence: answer.data.confidence }
            : {}),
          probabilities: answer.data.probabilities,
        },
        provider,
      ),
    ],
    diagnostics: { request: body, response },
  };
}

/** One Anthropic request as the harness records and prices it. */
export function anthropicCall(
  record: LLMCallRecord,
  provider: ProviderConfig,
  requestSequence?: number,
): ProviderCall {
  return priceCall(
    {
      servedModel: record.servedModel ?? record.model,
      latencyMs: record.latencyMs,
      ...(requestSequence != null ? { sequence: requestSequence } : {}),
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      ...(record.cacheReadTokens != null
        ? { promptCacheReadTokens: record.cacheReadTokens }
        : {}),
      ...(record.cacheWriteTokens != null
        ? { promptCacheWriteTokens: record.cacheWriteTokens }
        : {}),
    },
    provider,
  );
}

const anthropicSpanSchema = z.object({
  found: z.boolean(),
  text: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
});

export async function executeProviderCase(
  input: EvaluationCase,
  provider: ProviderConfig,
  budget: RequestBudget | undefined,
  llm: LLMClient | undefined,
  signal: AbortSignal,
  requestSequence?: number,
): Promise<{
  prediction: ProviderPrediction;
  calls: ProviderCall[];
  diagnostics?: unknown;
}> {
  if (provider.kind === "bm25") {
    if (input.task !== "rerank")
      throw new ProviderRequestError(
        "BM25 supports reranking only",
        "provider_failure",
      );
    return {
      prediction: { rankedChunkIds: input.bm25Order, relevance: {} },
      calls: [],
    };
  }
  if (provider.kind === "rules") {
    if (input.task !== "role")
      throw new ProviderRequestError(
        "Rules support role only",
        "provider_failure",
      );
    return { prediction: { role: input.deterministicRole }, calls: [] };
  }
  if (provider.kind === "jev") {
    if (!budget) throw new Error("Missing Jev request budget");
    return executeJev(input, provider, budget, signal);
  }
  if (!llm) throw new Error("Missing Anthropic client");
  const shuffled =
    input.task === "rerank"
      ? [...input.candidates].sort((a, b) => a.chunkId.localeCompare(b.chunkId))
      : [];
  const prompt =
    input.task === "role"
      ? input.anthropicPrompt
      : input.task === "adjudication"
        ? input.anthropicPrompt
        : input.task === "span"
          ? `Locate the shortest contiguous quote in the original citing context that supports the extracted claim. Return the quote verbatim as text, preserving every character and whitespace. Do not compute offsets. If no quote supports the claim, return found=false. If the exact quote occurs more than once, return exact immediately adjacent before and after strings to disambiguate it.\nClaim: ${input.claim}\nOriginal context: ${input.context}`
          : buildRelevanceRerankPrompt({
              query: { text: input.query },
              topN: Math.min(input.selectionLimit, shuffled.length),
              candidates: shuffled.map((candidate) => ({
                text: candidate.text,
                sourceBlockKind: candidate.sourceBlockKind,
                sourceSectionTitle: candidate.sectionTitle,
                sourceSectionRole: candidate.sectionRole,
                sourceCitesOtherWork: candidate.citesOtherWork,
              })),
            });
  if (
    provider.maxContextCharacters != null &&
    prompt.length > provider.maxContextCharacters
  )
    throw new ProviderRequestError(
      "Prompt exceeds configured context limit",
      "context_limit",
    );
  const schema =
    input.task === "role"
      ? citationRoleResponseSchema
      : input.task === "adjudication"
        ? adjudicateModelResponseSchema
        : input.task === "span"
          ? anthropicSpanSchema
          : rerankModelResponseSchema;
  const purpose =
    input.task === "role"
      ? "citation-role-classification"
      : input.task === "adjudication"
        ? "adjudication"
        : input.task === "span"
          ? "attributed-claim-extraction"
          : "evidence-rerank";
  const result = await llm.generateObject({
    purpose,
    model: provider.model,
    prompt,
    schema,
    ...(provider.thinking ? { effort: provider.thinking.effort } : {}),
  });
  const call = anthropicCall(result.record, provider, requestSequence);
  if (input.task === "role")
    return {
      prediction: {
        role: citationRoleResponseSchema.parse(result.object).citationRole,
      },
      calls: [call],
      diagnostics: { request: prompt, response: result.object },
    };
  if (input.task === "adjudication") {
    const answer = adjudicateModelResponseSchema.parse(result.object);
    const verdict = evaluationVerdictSchema.safeParse(answer.verdict);
    if (
      !verdict.success ||
      answer.citedChunks.some(
        (number) => number > input.packet.selectedChunks.length,
      )
    )
      throw new ProviderRequestError(
        "Invalid adjudication verdict or cited chunk reference",
        "invalid_response",
      );
    return {
      prediction: { verdict: verdict.data },
      calls: [call],
      diagnostics: { request: prompt, response: answer },
    };
  }
  if (input.task === "span") {
    const answer = anthropicSpanSchema.parse(result.object);
    if (!answer.found) return { prediction: { span: null }, calls: [call] };
    if (answer.text == null)
      throw new ProviderRequestError(
        "Anthropic omitted the supporting quote",
        "invalid_response",
        [call],
        { request: prompt, response: answer },
      );
    let span: { start: number; end: number; text: string };
    try {
      span = resolveExactQuote(
        input.context,
        answer.text,
        answer.before,
        answer.after,
      );
    } catch (error) {
      throw new ProviderRequestError(
        String(error),
        "invalid_response",
        [call],
        { request: prompt, response: answer },
      );
    }
    return {
      prediction: { span },
      calls: [call],
      diagnostics: { request: prompt, response: answer },
    };
  }
  const answer = rerankModelResponseSchema.parse(result.object);
  const ids = shuffled.map((candidate) => candidate.chunkId);
  const ranked: string[] = [];
  const scoreMap: Record<string, number> = {};
  for (const entry of [...answer.results].sort(
    (a, b) => b.relevanceScore - a.relevanceScore || a.candidate - b.candidate,
  )) {
    const id = ids[entry.candidate - 1];
    if (!id || ranked.includes(id))
      throw new ProviderRequestError(
        "Rerank response invented or repeated a candidate",
        "invalid_response",
      );
    ranked.push(id);
    scoreMap[id] = entry.relevanceScore;
  }
  return {
    prediction: {
      rankedChunkIds: [
        ...ranked,
        ...input.bm25Order.filter((id) => !ranked.includes(id)),
      ],
      relevance: scoreMap,
    },
    calls: [call],
    diagnostics: { request: prompt, response: answer },
  };
}

export function classifyProviderError(error: unknown): {
  status:
    | "unsupported"
    | "oversized_context"
    | "invalid_response"
    | "provider_failure";
  fatal: boolean;
  message: string;
} {
  if (error instanceof ProviderRequestError)
    return {
      status:
        error.category === "context_limit"
          ? "oversized_context"
          : error.category === "invalid_response"
            ? "invalid_response"
            : "provider_failure",
      fatal: error.category === "authentication" || error.category === "quota",
      message: error.message,
    };
  if (error instanceof LLMProviderError)
    return {
      status:
        error.classification === "malformed_output"
          ? "invalid_response"
          : "provider_failure",
      fatal: error.fatal,
      message: error.message,
    };
  return { status: "provider_failure", fatal: false, message: String(error) };
}
