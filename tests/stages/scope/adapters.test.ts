import { afterEach, describe, expect, it, vi } from "vitest";

import { PROMPT_VERSIONS } from "../../../src/config/prompt-versions.js";
import { analysisRunConfigSchema } from "../../../src/contract/run-types.js";
import type {
  GenerateObjectParams,
  LLMClient,
} from "../../../src/integrations/llm-client.js";
import { buildScopeAdapters } from "../../../src/stages/scope/adapters.js";
import {
  appConfig,
  makeStore,
  removeStores,
  seed,
} from "../adapters.fixture.js";

afterEach(removeStores);

describe("Scope production adapter", () => {
  it("records thinking effort and cache provenance for Scope grounding", async () => {
    const generateObject = vi.fn((params: GenerateObjectParams) =>
      Promise.resolve({
        object: {
          status: "not_found",
          detailReason: "No support",
          supportSpans: [],
        },
        record: {
          purpose: "seed-grounding" as const,
          model: params.model ?? "claude-sonnet-5-5",
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
    const store = makeStore();
    const adapter = buildScopeAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({
        scope: {
          groundingModel: "claude-sonnet-5-5",
          groundingThinking: true,
        },
      }),
      llmClient: {
        generateObject,
        getLedger: () => {
          throw new Error("not used");
        },
      } as unknown as LLMClient,
      provenanceStore: store,
      forceRefresh: true,
    });

    const result = (await adapter.groundFamily({
      seed: {
        seedId: "seed_1",
        doi: "10.1000/seed",
        provenanceArtifacts: [],
        resolution: seed,
      },
      family: {
        familyId: "family_1",
        seedId: "seed_1",
        candidateIds: ["cand_1"],
        sourceClaimRecordIds: ["claim_1"],
        claim: "Family claim text",
        normalizedClaim: "family claim text",
        includedCitationOccurrenceIds: ["occ_1"],
      },
      seedText: {
        status: "materialized",
        seedId: "seed_1",
        blocks: [
          {
            blockId: "b1",
            text: "Seed body text about the claim.",
            blockKind: "body_paragraph",
          },
        ],
        provenanceArtifacts: [],
      },
    } as unknown as Parameters<typeof adapter.groundFamily>[0])) as {
      status: string;
      execution?: {
        requestArtifact: {
          artifactId: string;
          contentHash: string;
          role: string;
        };
      };
    };

    expect(generateObject).toHaveBeenCalledOnce();
    expect(generateObject.mock.calls[0]![0]).toMatchObject({
      purpose: "seed-grounding",
      model: "claude-sonnet-5-5",
      effort: "high",
      exactCache: { keyVersion: PROMPT_VERSIONS.grounding },
    });
    // The seed text is the shared, cacheable prefix; only the claim varies.
    const groundingCall = generateObject.mock.calls[0]![0];
    expect(groundingCall.promptPrefix).toMatch(/## Seed-text blocks/);
    expect(groundingCall.promptPrefix).not.toMatch(/## Claim/);
    expect(groundingCall.promptSuffix).toMatch(/## Claim/);
    expect(result.status).toBe("completed");
    expect(result.execution).toBeDefined();
    const request = store.load(result.execution!.requestArtifact);
    expect(request).toMatchObject({
      body: {
        familyId: "family_1",
        llm: {
          purpose: "seed-grounding",
          model: "claude-sonnet-5-5",
          promptVersion: PROMPT_VERSIONS.grounding,
          effort: "high",
          cachePolicy: "bypass",
        },
      },
    });
  });
});
