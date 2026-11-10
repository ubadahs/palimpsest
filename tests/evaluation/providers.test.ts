import { describe, expect, it } from "vitest";
import { providerConfigSchema } from "../../src/evaluation/config.js";
import {
  callCostUsd,
  executeProviderCase,
  ProviderRequestError,
  type RequestBudget,
} from "../../src/evaluation/providers.js";
import type { EvaluationCase } from "../../src/evaluation/types.js";

const base = {
  caseId: "case-one",
  runId: "run-one",
  seedDoi: "10.1/seed",
  recordId: "record-one",
  sourceArtifactHashes: { report: "hash" },
};

describe("decision provider requests", () => {
  it("sends scientific task inputs without deterministic roles or human labels", async () => {
    const item: EvaluationCase = {
      ...base,
      task: "role",
      occurrenceId: "mention-one",
      context: "The citing article credits a result.",
      claims: ["The result was observed"],
      deterministicRole: "unclear",
      deterministicUnclear: true,
      anthropicPrompt: "Production prompt",
    };
    let request: unknown;
    const budget: RequestBudget = {
      call(body) {
        request = body;
        return Promise.resolve({
          body: {
            model: "jev-1.13.0",
            answers: {
              decision: {
                type: "choice",
                choice: "substantive_attribution",
                probabilities: {
                  substantive_attribution: 1,
                  background_context: 0,
                  methods_materials: 0,
                  acknowledgment_or_low_information: 0,
                  unclear: 0,
                },
              },
            },
            usage: { input_tokens: 20, output_tokens: 3 },
          },
          call: {
            servedModel: "jev-1.13.0",
            latencyMs: 40,
            inputTokens: 20,
            outputTokens: 3,
          },
        });
      },
    };
    const output = await executeProviderCase(
      item,
      providerConfigSchema.parse({
        id: "jev",
        kind: "jev",
        model: "jev-1.13.0",
      }),
      budget,
      undefined,
      new AbortController().signal,
    );
    expect(output.prediction).toEqual({ role: "substantive_attribution" });
    expect(JSON.stringify(request)).not.toContain("deterministicRole");
    expect(JSON.stringify(request)).not.toContain("Production prompt");
    expect(JSON.stringify(request)).not.toContain("humanVerdict");
  });

  it("scores every rerank pair and treats contradictory evidence as relevant", async () => {
    const item: EvaluationCase = {
      ...base,
      task: "rerank",
      query: "Retinal input is present",
      candidates: [
        {
          chunkId: "a",
          text: "General background",
          sourceBlockKind: "body_paragraph",
        },
        {
          chunkId: "b",
          text: "Retinal input is absent under condition X",
          sourceBlockKind: "body_paragraph",
        },
      ],
      pinnedPassages: [],
      bm25Order: ["a", "b"],
      pinnedChunkIds: [],
      selectionLimit: 2,
    };
    const requests: unknown[] = [];
    const budget: RequestBudget = {
      call(body) {
        requests.push(body);
        const score = JSON.stringify(body).includes("condition X") ? 2 : 0;
        return Promise.resolve({
          body: {
            model: "dgemma",
            answers: {
              decision: {
                type: "score",
                score,
                probabilities:
                  score === 2
                    ? { "0": 0, "1": 0, "2": 1 }
                    : { "0": 1, "1": 0, "2": 0 },
              },
            },
            usage: { input_tokens: 10, output_tokens: 2 },
          },
          call: { servedModel: "dgemma", latencyMs: 50 },
        });
      },
    };
    const output = await executeProviderCase(
      item,
      providerConfigSchema.parse({
        id: "djev",
        kind: "djev",
        model: "dgemma",
        endpoint: "https://example.test/v1/systemone",
      }),
      budget,
      undefined,
      new AbortController().signal,
    );
    expect(requests).toHaveLength(2);
    expect(output.calls).toHaveLength(2);
    expect(output.prediction).toEqual({
      rankedChunkIds: ["b", "a"],
      relevance: { a: 0, b: 2 },
    });
    expect(JSON.stringify(requests)).not.toContain("bm25Order");
    expect(JSON.stringify(requests)).not.toContain("sourceArtifactHashes");
  });

  it("batches independent rerank questions without BM25 ranks or labels", async () => {
    const item: EvaluationCase = {
      ...base,
      task: "rerank",
      query: "Retinal input is present",
      candidates: [
        {
          chunkId: "b",
          text: "Unrelated temperature study",
          sourceBlockKind: "body_paragraph",
        },
        {
          chunkId: "a",
          text: "Retinal input is absent under condition X",
          sourceBlockKind: "body_paragraph",
        },
      ],
      pinnedPassages: [],
      bm25Order: ["b", "a"],
      pinnedChunkIds: [],
      selectionLimit: 2,
    };
    const requests: unknown[] = [];
    const budget: RequestBudget = {
      call(body) {
        requests.push(body);
        return Promise.resolve({
          body: {
            model: "test-jev",
            answers: {
              passage_1: { type: "score", score: 2 },
              passage_2: { type: "score", score: 0 },
            },
          },
          call: { servedModel: "test-jev", latencyMs: 20 },
        });
      },
    };
    const result = await executeProviderCase(
      item,
      providerConfigSchema.parse({
        id: "jev",
        kind: "jev",
        model: "test-jev",
        rerankBatchSize: 20,
      }),
      budget,
      undefined,
      new AbortController().signal,
    );
    expect(requests).toHaveLength(1);
    expect(result.prediction).toEqual({
      rankedChunkIds: ["a", "b"],
      relevance: { a: 2, b: 0 },
    });
    expect(JSON.stringify(requests[0])).not.toContain("bm25Order");
    expect(JSON.stringify(requests[0])).not.toContain("chunkId");
    expect(JSON.stringify(requests[0])).not.toContain("human");
  });

  it("splits a 503 rerank batch and accounts for the failed attempt", async () => {
    const item: EvaluationCase = {
      ...base,
      task: "rerank",
      query: "Retinal input",
      candidates: ["a", "b", "c", "d"].map((chunkId) => ({
        chunkId,
        text: `Passage ${chunkId}`,
        sourceBlockKind: "body_paragraph" as const,
      })),
      pinnedPassages: [],
      bm25Order: ["d", "c", "b", "a"],
      pinnedChunkIds: [],
      selectionLimit: 4,
    };
    let requests = 0;
    const budget: RequestBudget = {
      call() {
        requests++;
        if (requests === 1)
          return Promise.reject(
            new ProviderRequestError("HTTP 503", "provider_failure", [
              { servedModel: "unknown", latencyMs: 10 },
            ]),
          );
        return Promise.resolve({
          body: {
            model: "test-jev",
            answers: {
              passage_1: { type: "score", score: 2 },
              passage_2: { type: "score", score: 0 },
            },
          },
          call: { servedModel: "test-jev", latencyMs: 20 },
        });
      },
    };
    const result = await executeProviderCase(
      item,
      providerConfigSchema.parse({
        id: "jev",
        kind: "jev",
        model: "test-jev",
        rerankBatchSize: 4,
        rerankMinFallbackBatchSize: 2,
      }),
      budget,
      undefined,
      new AbortController().signal,
    );
    expect(requests).toBe(3);
    expect(result.calls).toHaveLength(3);
    expect(result.prediction).toEqual({
      rankedChunkIds: ["a", "c", "b", "d"],
      relevance: { a: 2, b: 0, c: 2, d: 0 },
    });
  });

  it("converts native span code points and rejects a mismatched quotation", async () => {
    const item: EvaluationCase = {
      ...base,
      task: "span",
      claimRecordId: "claim-one",
      claim: "signal",
      context: "😀 signal",
    };
    const provider = providerConfigSchema.parse({
      id: "djev",
      kind: "djev",
      model: "dgemma",
      endpoint: "https://example.test/v1/systemone",
    });
    const answer = (text: string): RequestBudget => ({
      call() {
        return Promise.resolve({
          body: {
            model: "dgemma",
            answers: {
              decision: { type: "span", found: true, text, start: 2, end: 8 },
            },
          },
          call: { servedModel: "dgemma", latencyMs: 50 },
        });
      },
    });
    const output = await executeProviderCase(
      item,
      provider,
      answer("signal"),
      undefined,
      new AbortController().signal,
    );
    expect(output.prediction).toEqual({
      span: { start: 3, end: 9, text: "signal" },
    });
    await expect(
      executeProviderCase(
        item,
        provider,
        answer("wrong"),
        undefined,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ProviderRequestError);
    const noSpan: RequestBudget = {
      call() {
        return Promise.resolve({
          body: {
            model: "dgemma",
            answers: {
              decision: {
                type: "span",
                found: false,
                text: null,
                start: null,
                end: null,
              },
            },
          },
          call: { servedModel: "dgemma", latencyMs: 40 },
        });
      },
    };
    expect(
      (
        await executeProviderCase(
          item,
          provider,
          noSpan,
          undefined,
          new AbortController().signal,
        )
      ).prediction,
    ).toEqual({ span: null });
  });
});

describe("call pricing", () => {
  const usage = {
    inputTokens: 1_200_000,
    promptCacheReadTokens: 1_000_000,
    promptCacheWriteTokens: 100_000,
    outputTokens: 100_000,
  };
  const prices = {
    id: "p",
    kind: "anthropic",
    model: "m",
    pricePerMillionInputTokensUsd: 4,
    pricePerMillionOutputTokensUsd: 20,
  };

  it("charges cache reads at the provider's own rate when it states one", () => {
    const stated = providerConfigSchema.parse({
      ...prices,
      pricePerMillionCacheReadTokensUsd: 0.2,
    });
    expect(callCostUsd(usage, stated)).toBeCloseTo(0.4 + 0.2 + 0.5 + 2);
    expect(callCostUsd(usage, providerConfigSchema.parse(prices))).toBeCloseTo(
      0.4 + 0.4 + 0.5 + 2,
    );
  });

  it("gives no cost when prices or usage are unknown", () => {
    expect(
      callCostUsd(
        usage,
        providerConfigSchema.parse({ id: "p", kind: "anthropic", model: "m" }),
      ),
    ).toBeNull();
    expect(
      callCostUsd({ latencyMs: 5 }, providerConfigSchema.parse(prices)),
    ).toBeNull();
  });
});
