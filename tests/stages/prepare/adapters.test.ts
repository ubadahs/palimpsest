import { afterEach, describe, expect, it, vi } from "vitest";

import { analysisRunConfigSchema } from "../../../src/contract/run-types.js";
import type {
  GenerateObjectParams,
  LLMClient,
} from "../../../src/integrations/llm-client.js";
import { LLMProviderError } from "../../../src/integrations/llm-client.js";
import { buildPrepareAdapters } from "../../../src/stages/prepare/adapters.js";
import {
  appConfig,
  makeStore,
  mention,
  removeStores,
} from "../adapters.fixture.js";

afterEach(removeStores);

/** A context with no phrase, verb, or heading cue — the regex pass returns `unclear`. */
const UNCLEAR_SUPPORT_SPAN =
  "the north relay field receives input from several dorsal cell classes";

const UNCLEAR_CONTEXT = `In the mouse, ${UNCLEAR_SUPPORT_SPAN} [1]. That arrangement has occupied a good deal of the literature over the past decade.`;

function roleClassifierReply(object: unknown) {
  return {
    object,
    record: {
      purpose: "citation-role-classification" as const,
      model: "claude-haiku-5-5",
      attempted: true as const,
      successful: true,
      failed: false,
      billable: true,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      latencyMs: 1,
      finishReason: "stop",
      timestamp: "2026-09-02T12:00:00.000Z",
      estimatedCostUsd: 0,
    },
  };
}

function prepareAdapterFor(
  generateObject: (params: GenerateObjectParams) => Promise<{
    object: unknown;
    record: ReturnType<typeof roleClassifierReply>["record"];
  }>,
  runConfig: unknown = {},
) {
  return buildPrepareAdapters({
    config: appConfig(),
    runConfig: analysisRunConfigSchema.parse(runConfig),
    llmClient: {
      generateObject,
      getLedger: () => {
        throw new Error("not used");
      },
    } as unknown as LLMClient,
    provenanceStore: makeStore(),
  });
}

function unclearRoleInput() {
  const offset = UNCLEAR_CONTEXT.indexOf(UNCLEAR_SUPPORT_SPAN);
  return {
    family: { familyId: `family_${"a".repeat(64)}` },
    citationOccurrence: {
      ...mention,
      rawContext: UNCLEAR_CONTEXT,
      sectionTitle: "Ventral relay connectivity",
    },
    citingPaper: { paper: { paperType: "article" } },
    occurrenceSourceClaimRecords: [
      {
        claimRecordId: `claim_${"b".repeat(64)}`,
        extractedClaimText: "The Kestrin receives dorsal contact.",
        confidence: "medium" as const,
        supportSpan: {
          text: UNCLEAR_SUPPORT_SPAN,
          charOffsetStart: offset,
          charOffsetEnd: offset + UNCLEAR_SUPPORT_SPAN.length,
          verificationStatus: "verified_exact" as const,
        },
      },
    ],
  } as unknown as Parameters<
    ReturnType<typeof prepareAdapterFor>["classifyCitation"]
  >[0];
}

describe("Prepare production adapter", () => {
  it("marks review publication types as review-mediated in Prepare", async () => {
    const adapter = prepareAdapterFor(() => {
      throw new Error("a resolved regex role must not reach the model");
    });
    const result = await adapter.classifyCitation({
      citationOccurrence: {
        ...mention,
        sectionTitle: "Introduction",
      },
      citingPaper: {
        paper: {
          paperType: "review",
        },
      },
    } as Parameters<typeof adapter.classifyCitation>[0]);
    expect(result).toMatchObject({
      modifiers: { isReviewMediated: true },
    });
  });

  it("resolves a regex-unclear role from the model and records the call", async () => {
    const generateObject = vi.fn((_params: GenerateObjectParams) =>
      Promise.resolve(
        roleClassifierReply({
          citationRole: "substantive_attribution",
          rationale:
            "The sentence credits a measured input source to the seed.",
        }),
      ),
    );
    const adapter = prepareAdapterFor(generateObject);
    const result = await adapter.classifyCitation(unclearRoleInput());

    expect(generateObject).toHaveBeenCalledTimes(1);
    const prompt = generateObject.mock.calls[0]![0].prompt!;
    expect(prompt).toContain("▶");
    expect(prompt).toContain(UNCLEAR_SUPPORT_SPAN);
    expect(prompt).toContain("Ventral relay connectivity");
    expect(result).toMatchObject({
      status: "classified",
      citationRole: "substantive_attribution",
      evaluationMode: "fidelity_specific_claim",
      execution: { kind: "model", provider: "anthropic" },
    });
    expect((result as { signals: string[] }).signals).toContain(
      "model-role:substantive_attribution",
    );
  });

  it("asks the role classifier for the lowest thinking effort", async () => {
    const generateObject = vi.fn((_params: GenerateObjectParams) =>
      Promise.resolve(
        roleClassifierReply({
          citationRole: "background_context",
          rationale: "The sentence frames the topic.",
        }),
      ),
    );

    await prepareAdapterFor(generateObject).classifyCitation(
      unclearRoleInput(),
    );

    expect(generateObject.mock.calls[0]![0]).toMatchObject({
      model: "claude-haiku-5-5",
      effort: "low",
    });
  });

  it("keeps a record gated when the model is also unclear", async () => {
    const adapter = prepareAdapterFor(() =>
      Promise.resolve(
        roleClassifierReply({
          citationRole: "unclear",
          rationale: "The context does not say what the citation is doing.",
        }),
      ),
    );
    const result = await adapter.classifyCitation(unclearRoleInput());

    expect(result).toMatchObject({
      status: "ambiguous",
      citationRole: "unclear",
      evaluationMode: "manual_review_role_ambiguous",
      execution: { kind: "model" },
    });
  });

  it("keeps a record gated when the provider call fails", async () => {
    const adapter = prepareAdapterFor(() =>
      Promise.reject(new Error("429 rate limit exceeded")),
    );
    const result = await adapter.classifyCitation(unclearRoleInput());

    expect(result).toMatchObject({
      status: "ambiguous",
      evaluationMode: "manual_review_role_ambiguous",
      execution: { kind: "model" },
    });
    expect((result as { signals: string[] }).signals).toContain(
      "model-role:rate_limited",
    );
  });

  it("stops the stage when the spend limit is reached instead of gating the record", async () => {
    // A gated record would look like a provider hiccup and the stage would
    // finish with every remaining record held back, all for a budget stop.
    const adapter = prepareAdapterFor(() =>
      Promise.reject(
        new LLMProviderError("Spend limit reached", "spend_limit", true),
      ),
    );
    await expect(adapter.classifyCitation(unclearRoleInput())).rejects.toThrow(
      /Spend limit reached/,
    );
  });

  it("surfaces a reply the output schema should have made impossible", async () => {
    // Structured output guarantees the shape, so a violation here is a bug in
    // this code, not a provider failure. It must not become a silent gate.
    const adapter = prepareAdapterFor(() =>
      Promise.resolve(roleClassifierReply({ citationRole: "not_a_role" })),
    );
    await expect(
      adapter.classifyCitation(unclearRoleInput()),
    ).rejects.toThrow();
  });

  it("does not send a missing-support-span record to the model", async () => {
    const adapter = prepareAdapterFor(() => {
      throw new Error("an extraction-limited record must not reach the model");
    });
    const input = unclearRoleInput();
    const result = await adapter.classifyCitation({
      ...input,
      occurrenceSourceClaimRecords: input.occurrenceSourceClaimRecords.map(
        ({ supportSpan: _dropped, ...claim }) => claim,
      ),
    } as Parameters<typeof adapter.classifyCitation>[0]);

    expect(result).toMatchObject({
      status: "ambiguous",
      evaluationMode: "manual_review_extraction_limited",
      execution: { kind: "deterministic" },
    });
  });
});
