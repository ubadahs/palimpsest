import { z } from "zod";
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
const systemOneSchema = z.object({
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

function waitForDispatch(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Experiment cancelled"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    function cancel() {
      clearTimeout(timer);
      reject(new Error("Experiment cancelled"));
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function retryDelayMs(response: Response, retry: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header == null ? NaN : Number(header);
  const hinted = Number.isFinite(seconds)
    ? seconds * 1000
    : header == null
      ? NaN
      : Date.parse(header) - Date.now();
  return Math.min(
    30_000,
    Math.max(0, Number.isFinite(hinted) ? hinted : 2000 * 2 ** retry),
  );
}

export function createRequestBudget(
  provider: ProviderConfig,
  countRequest: () => number,
): RequestBudget {
  const endpoint =
    provider.endpoint ??
    (provider.endpointEnv ? process.env[provider.endpointEnv] : undefined) ??
    (provider.kind === "jev"
      ? "https://api.typesafe.ai/v1/systemone"
      : undefined);
  if (!endpoint) throw new Error(`${provider.id} requires an endpoint`);
  const key =
    process.env[
      provider.apiKeyEnv ??
        (provider.kind === "jev" ? "TYPESAFE_API_KEY" : "DJEV_API_KEY")
    ];
  if (provider.kind === "jev" && !key)
    throw new Error(
      `${provider.id} requires ${provider.apiKeyEnv ?? "TYPESAFE_API_KEY"}`,
    );
  let nextDispatchAt = 0;
  return {
    async call(body, signal) {
      const attempts: ProviderCall[] = [];
      for (let retry = 0; ; retry++) {
        const dispatchAt = Math.max(Date.now(), nextDispatchAt);
        nextDispatchAt = dispatchAt + (provider.minimumRequestIntervalMs ?? 0);
        await waitForDispatch(dispatchAt - Date.now(), signal);
        const sequence = countRequest();
        const started = performance.now();
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(key ? { authorization: `Bearer ${key}` } : {}),
            },
            body: JSON.stringify(body),
            signal,
          });
        } catch (error) {
          throw new ProviderRequestError(
            String(error),
            "provider_failure",
            [
              ...attempts,
              {
                servedModel: "unknown",
                latencyMs: performance.now() - started,
                sequence,
              },
            ],
            { request: body, retry },
          );
        }
        const call: ProviderCall = {
          servedModel: "unknown",
          latencyMs: performance.now() - started,
          sequence,
        };
        if (!response.ok) {
          attempts.push(call);
          if (
            [502, 503, 504].includes(response.status) &&
            retry < (provider.maxTransientRetries ?? 0)
          ) {
            await waitForDispatch(retryDelayMs(response, retry), signal);
            continue;
          }
          throw new ProviderRequestError(
            `HTTP ${response.status}`,
            response.status === 401 || response.status === 403
              ? "authentication"
              : response.status === 402 || response.status === 429
                ? "quota"
                : response.status === 413
                  ? "context_limit"
                  : "provider_failure",
            attempts,
            { request: body, status: response.status, retries: retry },
          );
        }
        const raw: unknown = await response.json();
        const parsed = systemOneSchema.safeParse(raw);
        if (!parsed.success)
          throw new ProviderRequestError(
            `Invalid System One response: ${parsed.error.message}`,
            "invalid_response",
            [...attempts, call],
            { request: body, response: raw, retries: retry },
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

function systemQuestion(caseInput: EvaluationCase): {
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
          instructions:
            "Classify what the citing paper does with this cited reference. Choose unclear only if the context is too thin.",
          criteria: {
            substantive_attribution:
              "Credits a specific finding, result or measurement",
            background_context: "General knowledge, motivation or framing",
            methods_materials: "Method, protocol, reagent, dataset or tool",
            acknowledgment_or_low_information:
              "Bare mention with no attributed content",
            unclear: "Genuinely insufficient context",
          },
        },
      },
    };
  if (caseInput.task === "adjudication")
    return {
      state: caseInput.packet,
      questions: {
        decision: {
          type: "choice",
          instructions:
            "Compare only the citing attribution with selected cited-paper evidence. Judge substantive meaning; contradictions and qualifying conditions matter. Do not use U for missing evidence or tool failure.",
          criteria: {
            F: "Faithful substantive meaning, reasonable compression allowed",
            D: "Real source kernel with materially changed scope, strength, certainty, causality, population, condition, endpoint or generality",
            E: "Central attribution unsupported, contradicted, wrong entity or no source kernel",
            U: "Exact evidence is present but genuine scientific ambiguity prevents F/D/E",
          },
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

const callUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  promptCacheReadTokens: z.number().optional(),
  promptCacheWriteTokens: z.number().optional(),
});

/**
 * Cost of one call at the provider's stated prices, or null when the prices
 * or the call's token usage are unknown. Cache writes cost 1.25 times the
 * input price on every model. Cache reads cost a tenth of it unless the
 * provider states its own rate, which the newer models need.
 */
export function callCostUsd(
  call: unknown,
  provider: ProviderConfig,
): number | null {
  const usage = callUsageSchema.safeParse(call);
  const input = provider.pricePerMillionInputTokensUsd;
  const output = provider.pricePerMillionOutputTokensUsd;
  if (!usage.success || input == null || output == null) return null;
  const read = usage.data.promptCacheReadTokens ?? 0;
  const write = usage.data.promptCacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.data.inputTokens - read - write);
  return (
    (uncached * input +
      read * (provider.pricePerMillionCacheReadTokensUsd ?? input * 0.1) +
      write * input * 1.25 +
      usage.data.outputTokens * output) /
    1_000_000
  );
}

function priceCall(call: ProviderCall, provider: ProviderConfig): ProviderCall {
  const costUsd = callCostUsd(call, provider);
  return costUsd == null ? call : { ...call, costUsd };
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

async function executeSystemOne(
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
          ? {
              model: provider.model,
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
              ...(provider.kind === "djev" && provider.inferenceSettings
                ? provider.inferenceSettings
                : {}),
            }
          : {
              model: provider.model,
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
              ...(provider.kind === "djev" && provider.inferenceSettings
                ? provider.inferenceSettings
                : {}),
            };
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
        const response = systemOneSchema.parse(result.body);
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
  const question = systemQuestion(input);
  const body = {
    model: provider.model,
    ...question,
    ...(provider.kind === "djev" && provider.inferenceSettings
      ? provider.inferenceSettings
      : {}),
  };
  if (
    provider.maxContextCharacters != null &&
    JSON.stringify(body).length > provider.maxContextCharacters
  )
    throw new ProviderRequestError(
      "Case exceeds configured context limit",
      "context_limit",
    );
  const result = await budget.call(body, signal);
  const response = systemOneSchema.parse(result.body);
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
  if (provider.kind === "jev" && input.task === "span")
    throw new ProviderRequestError(
      "Jev has no native span capability",
      "provider_failure",
    );
  if (provider.kind !== "anthropic") {
    if (!budget) throw new Error("Missing System One request budget");
    return executeSystemOne(input, provider, budget, signal);
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
