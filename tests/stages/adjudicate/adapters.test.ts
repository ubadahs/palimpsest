import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { analysisRunConfigSchema } from "../../../src/contract/run-types.js";
import type {
  GenerateObjectParams,
  LLMClient,
} from "../../../src/integrations/llm-client.js";
import { canonicalSha256 } from "../../../src/shared/stable-identity.js";
import { buildAdjudicateAdapters } from "../../../src/stages/adjudicate/adapters.js";
import { appConfig, makeStore, removeStores } from "../adapters.fixture.js";

afterEach(removeStores);

describe("Adjudicate production adapter", () => {
  it("sends the adjudication effort when thinking is on", async () => {
    const generateObject = vi.fn((params: GenerateObjectParams) =>
      Promise.resolve({
        object: {
          citingAssertion: "The citer restates the seed finding.",
          sourceStatement: "The seed reports the same finding.",
          verdict: "F",
          mutationKinds: [],
          direction: "none",
          rationale: "Faithful.",
          confidence: "high",
          citedChunks: [1],
        },
        record: {
          purpose: "adjudication" as const,
          model: params.model ?? "claude-opus-5-5",
          attempted: true as const,
          successful: true,
          failed: false,
          billable: true,
          thinkingEffort: "high" as const,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          finishReason: "stop",
          timestamp: "2026-07-17T12:00:00.000Z",
          estimatedCostUsd: 0.01,
        },
      }),
    );
    const adapter = buildAdjudicateAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({
        adjudicate: { model: "claude-opus-5-5", thinking: true },
      }),
      llmClient: {
        generateObject,
        getLedger: () => {
          throw new Error("not used");
        },
      } as unknown as LLMClient,
      provenanceStore: makeStore(),
    });

    expect(adapter.adjudicate).toBeTypeOf("function");
    await adapter.adjudicate!({
      purpose: "categorical_adjudication",
      recordId: "rec_1",
      evidence: "selected_chunks",
      promptId: "categorical-adjudicate",
      promptVersion: "v1",
      promptText: "adjudicate this",
      packet: {
        recordId: "rec_1",
        familyId: "family_1",
        citationOccurrenceId: "occ_1",
        citationRole: "supports",
        evaluationMode: "empirical_attribution",
        isBundled: false,
        bundleSize: 1,
        citingPaperTitle: "Citing",
        citedPaperTitle: "Cited",
        familyTrackedClaim: "Claim",
        markedCitingContext: "▶ Claim text. ◀",
        occurrenceClaims: [],
        selectedChunks: [],
      },
    } as unknown as Parameters<NonNullable<typeof adapter.adjudicate>>[0]);

    expect(generateObject.mock.calls[0]![0]).toMatchObject({
      effort: "high",
    });
  });

  it("sends a whole seed text as a shared prefix, and lets the first request write the cache alone", async () => {
    const seedText = `## Cited/seed paper, full text\n${"The seed reports three marker classes. ".repeat(200)}`;
    let inFlight = 0;
    const inFlightAtStart: number[] = [];
    const generateObject = vi.fn(async (params: GenerateObjectParams) => {
      inFlightAtStart.push(inFlight);
      inFlight += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        object: {
          citingAssertion: "The citer restates the seed finding.",
          sourceStatement: "The seed reports three marker classes.",
          verdict: "F",
          mutationKinds: [],
          direction: "none",
          rationale: "Faithful.",
          confidence: "high",
          seedQuotes: [{ block: 1, quote: "three marker classes" }],
        },
        record: {
          purpose: "adjudication" as const,
          model: params.model ?? "claude-sonnet-5-5",
          attempted: true as const,
          successful: true,
          failed: false,
          billable: true,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          finishReason: "stop",
          timestamp: "2026-07-17T12:00:00.000Z",
          estimatedCostUsd: 0.01,
        },
      };
    });
    const store = makeStore();
    const adapter = buildAdjudicateAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({}),
      llmClient: { generateObject } as unknown as LLMClient,
      provenanceStore: store,
    });
    const request = (recordId: string) =>
      ({
        purpose: "categorical_adjudication",
        recordId,
        evidence: "seed_text",
        promptId: "seed-text-adjudicate",
        promptVersion: "v1",
        promptPrefix: seedText,
        promptSuffix: `Citing side of ${recordId}`,
        packet: {},
      }) as unknown as Parameters<NonNullable<typeof adapter.adjudicate>>[0];

    const results = await Promise.all(
      ["rec_1", "rec_2", "rec_3"].map((id) => adapter.adjudicate!(request(id))),
    );

    // The first request ran alone; the other two went together afterwards.
    expect(inFlightAtStart).toEqual([0, 0, 1]);
    expect(generateObject.mock.calls[0]![0]).toMatchObject({
      promptPrefix: seedText,
      promptSuffix: "Citing side of rec_1",
    });
    const first = results[0] as {
      status: string;
      rawOutput: { seedQuotes: unknown };
      execution: {
        promptContentHash: string;
        requestArtifact: Parameters<typeof store.pathFor>[0];
      };
    };
    expect(first.status).toBe("completed");
    expect(first.rawOutput.seedQuotes).toEqual([
      { block: 1, quote: "three marker classes" },
    ]);
    expect(first.execution.promptContentHash).toBe(
      canonicalSha256(`${seedText}Citing side of rec_1`),
    );
    // The stored request names the seed text by hash instead of repeating it.
    const stored = readFileSync(
      store.pathFor(first.execution.requestArtifact),
      "utf8",
    );
    expect(stored).toContain(canonicalSha256(seedText));
    expect(stored).toContain("Citing side of rec_1");
    expect(stored).toMatch(/"promptCachePolicy":\s*"ephemeral:5m"/);
    expect(stored).not.toContain("The seed reports three marker classes.");
  });
});
