import { afterEach, describe, expect, it, vi } from "vitest";

import { analysisRunConfigSchema } from "../../../src/contract/run-types.js";
import type {
  GenerateObjectParams,
  LLMClient,
} from "../../../src/integrations/llm-client.js";
import {
  buildDiscoverAdapters,
  openAlexNeighborhoodSeedId,
  selectSeedReferenceMentions,
} from "../../../src/stages/discover/adapters.js";
import { claimExtractionOutputSchema } from "../../../src/stages/discover/prompts.js";
import {
  appConfig,
  citingPaper,
  llmClientReturning,
  makeStore,
  mention,
  removeStores,
  seed,
} from "../adapters.fixture.js";

afterEach(removeStores);

function discoverAdapterFor(object: unknown) {
  return buildDiscoverAdapters({
    config: appConfig(),
    runConfig: analysisRunConfigSchema.parse({}),
    llmClient: llmClientReturning(object),
    provenanceStore: makeStore(),
    fullTextAdapters: {
      fetchUrl: () => Promise.resolve({ ok: false, error: "not used" }),
      processPdfWithGrobid: () =>
        Promise.resolve({ ok: false, error: "not used" }),
      email: undefined,
      institutionalProxyUrl: undefined,
    },
  });
}

describe("Discover production adapter", () => {
  it("accepts only OpenAlex identities for OpenAlex neighborhoods", () => {
    expect(
      openAlexNeighborhoodSeedId({
        provider: "openalex",
        providerRecordId: "https://openalex.org/W123",
      }),
    ).toBe("https://openalex.org/W123");
    expect(
      openAlexNeighborhoodSeedId({
        provider: "semantic_scholar",
        providerRecordId: "S2CorpusId:123",
      }),
    ).toBeUndefined();
    expect(
      openAlexNeighborhoodSeedId({
        provider: "openalex",
        providerRecordId: "S2CorpusId:123",
      }),
    ).toBeUndefined();
  });

  it("calls OpenAlex neighborhoods only for OpenAlex-resolved seeds", async () => {
    const getCitingWorks = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        papers: [
          {
            id: "https://openalex.org/W456",
            doi: "10.1000/review",
            title: "Review citing paper",
            authors: ["Review Author"],
            source: "openalex",
            fullTextHints: { providerAvailability: "available" },
            paperType: "review",
            referencedWorksCount: 120,
          },
        ],
        pages: [
          {
            pageIndex: 0,
            requestUrl: "https://example.test/openalex/works?fixture",
            page: 1,
            perPage: 10,
            returnedCount: 1,
            keptCount: 1,
            responseTotalCount: 1,
          },
        ],
        providerReportedTotal: 1,
        coverage: "complete",
      },
    });
    const adapter = buildDiscoverAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({}),
      llmClient: llmClientReturning({}),
      provenanceStore: makeStore(),
      fullTextAdapters: {
        fetchUrl: () => Promise.resolve({ ok: false, error: "not used" }),
        processPdfWithGrobid: () =>
          Promise.resolve({ ok: false, error: "not used" }),
        email: undefined,
        institutionalProxyUrl: undefined,
      },
      paperProviders: {
        resolvePaperByDoi: vi.fn(),
        getCitingWorks,
      },
    });
    const boundary = {
      provider: "openalex",
      query: "works-citing-seed",
      limit: 10,
    };

    const openAlex = await adapter.retrieveCitingNeighborhood({
      seed,
      boundary,
    });
    expect(openAlex).toMatchObject({
      status: "completed",
      providerReportedTotal: 1,
      coverage: "complete",
      papers: [
        {
          paperType: "review",
          referencedWorksCount: 120,
        },
      ],
    });
    const openAlexPageArtifacts = (openAlex as { pageArtifacts: unknown[] })
      .pageArtifacts;
    expect(openAlexPageArtifacts).toHaveLength(2);
    const openAlexPapers = (
      openAlex as { papers: { provenanceArtifacts: unknown[] }[] }
    ).papers;
    // A returned paper's provenance is the provider page it came from, and
    // nothing else: its own fields are already on the Discover record.
    expect(openAlexPapers[0]?.provenanceArtifacts).toHaveLength(1);
    expect(openAlexPageArtifacts).toContainEqual(
      openAlexPapers[0]!.provenanceArtifacts[0],
    );
    expect(getCitingWorks).toHaveBeenCalledWith(
      "https://openalex.org/W123",
      expect.any(String),
      10,
      undefined,
      undefined,
    );

    getCitingWorks.mockClear();
    const resolveOpenAlexWorkByDoi = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        id: "https://openalex.org/W999",
        doi: "10.1000/seed",
        title: "Seed",
        authors: ["Author"],
        source: "openalex",
      },
    });
    const s2Store = makeStore();
    const s2Adapter = buildDiscoverAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({}),
      llmClient: llmClientReturning({}),
      provenanceStore: s2Store,
      fullTextAdapters: {
        fetchUrl: () => Promise.resolve({ ok: false, error: "not used" }),
        processPdfWithGrobid: () =>
          Promise.resolve({ ok: false, error: "not used" }),
        email: undefined,
        institutionalProxyUrl: undefined,
      },
      paperProviders: {
        resolvePaperByDoi: vi.fn(),
        getCitingWorks,
        resolveOpenAlexWorkByDoi,
      },
    });
    const recovered = await s2Adapter.retrieveCitingNeighborhood({
      seed: {
        ...seed,
        paper: {
          ...seed.paper,
          providerRecordId: "S2CorpusId:123",
        },
        execution: {
          ...seed.execution,
          provider: "semantic_scholar",
        },
      },
      boundary,
    });
    expect(resolveOpenAlexWorkByDoi).toHaveBeenCalledWith(
      "10.1000/seed",
      expect.any(String),
      undefined,
    );
    expect(getCitingWorks).toHaveBeenCalledWith(
      "https://openalex.org/W999",
      expect.any(String),
      10,
      undefined,
      undefined,
    );
    expect(recovered).toMatchObject({ status: "completed" });
    const recoveredExecution = (
      recovered as {
        execution: {
          requestArtifact: {
            artifactId: string;
            contentHash: string;
            role: string;
          };
        };
      }
    ).execution;
    const neighborhoodRequest = s2Store.load(recoveredExecution.requestArtifact)
      .body as {
      openAlexDoiLookup: {
        attempted: true;
        requestArtifact: {
          artifactId: string;
          contentHash: string;
          role: string;
        };
        responseArtifact: {
          artifactId: string;
          contentHash: string;
          role: string;
        };
      };
    };
    expect(
      s2Store.load(neighborhoodRequest.openAlexDoiLookup.requestArtifact).body,
    ).toEqual({
      role: "normalized-openalex-doi-resolution-request",
      doi: "10.1000/seed",
    });
    expect(
      s2Store.load(neighborhoodRequest.openAlexDoiLookup.responseArtifact).body,
    ).toMatchObject({
      role: "normalized-openalex-doi-resolution-response",
      status: "resolved",
      paper: { id: "https://openalex.org/W999" },
    });

    getCitingWorks.mockClear();
    resolveOpenAlexWorkByDoi.mockResolvedValueOnce({
      ok: false,
      error: "No OpenAlex match",
    });
    const failed = await s2Adapter.retrieveCitingNeighborhood({
      seed: {
        ...seed,
        paper: {
          ...seed.paper,
          providerRecordId: "S2CorpusId:123",
        },
        execution: {
          ...seed.execution,
          provider: "semantic_scholar",
        },
      },
      boundary,
    });
    expect(failed).toMatchObject({
      status: "failed",
      reasonCode: "unavailable",
    });
    expect(getCitingWorks).not.toHaveBeenCalled();
  });

  it("selects only citation groups whose exact target refs include the seed", () => {
    const direct = {
      refId: "seed-ref",
      targetRefIds: ["seed-ref"],
      bundleRefIds: ["other-ref", "seed-ref"],
    };
    const siblingOnly = {
      refId: "other-ref",
      targetRefIds: ["other-ref"],
      bundleRefIds: ["other-ref", "seed-ref"],
    };
    const multiTarget = {
      refId: "seed-ref",
      targetRefIds: ["seed-ref", "also-ref"],
      bundleRefIds: ["seed-ref", "also-ref"],
    };
    const unrelated = {
      refId: "other-ref",
      targetRefIds: ["other-ref"],
      bundleRefIds: ["other-ref"],
    };
    expect(
      selectSeedReferenceMentions(
        [direct, siblingOnly, multiTarget, unrelated],
        "seed-ref",
      ),
    ).toEqual([direct, multiTarget]);
  });

  it.each([
    ["zero", { claims: [], reason: "No empirical attribution." }, 0],
    [
      "one",
      {
        claims: [{ text: "Claim A", confidence: "high" }],
        reason: "One claim.",
      },
      1,
    ],
    [
      "multiple",
      {
        claims: [
          {
            text: "Claim A",
            supportSpanText: "showed claim A",
            confidence: "high",
          },
          {
            text: "Claim B",
            supportSpanText: "and claim B",
            confidence: "medium",
          },
        ],
        reason: "Two distinct claims.",
      },
      2,
    ],
  ])("preserves %s extraction outputs", (_label, reply, count) => {
    const parsed = claimExtractionOutputSchema.safeParse(reply);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.claims).toHaveLength(count);
  });

  it("rejects malformed extraction output", () => {
    expect(
      claimExtractionOutputSchema.safeParse({
        claims: [{ text: "" }],
      }).success,
    ).toBe(false);
  });

  it("maps all extracted claims through the Discover adapter", async () => {
    const adapter = discoverAdapterFor({
      claims: [
        { text: "Claim A", supportSpanText: "claim A", confidence: "high" },
        { text: "Claim B", supportSpanText: "claim B", confidence: "medium" },
      ],
      reason: "Two claims.",
    });
    const result = await adapter.extractAttributedClaims({
      seed,
      citingPaper,
      mention,
    });
    expect(result).toMatchObject({
      status: "completed",
      reason: "Two claims.",
      claims: [
        {
          text: "Claim A",
          supportSpanText: "claim A",
          confidence: "high",
        },
        {
          text: "Claim B",
          supportSpanText: "claim B",
          confidence: "medium",
        },
      ],
    });
  });

  it("sends the default effort for extraction when thinking is on", async () => {
    const generateObject = vi.fn((params: GenerateObjectParams) =>
      Promise.resolve({
        object: { claims: [], reason: "None." },
        record: {
          purpose: "attributed-claim-extraction" as const,
          model: params.model ?? "claude-haiku-5-5",
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
      }),
    );
    const adapter = buildDiscoverAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({
        discover: {
          extractionModel: "claude-haiku-5-5",
          extractionThinking: true,
        },
      }),
      llmClient: {
        generateObject,
        getLedger: () => {
          throw new Error("not used");
        },
      } as unknown as LLMClient,
      provenanceStore: makeStore(),
    });

    await adapter.extractAttributedClaims({ seed, citingPaper, mention });
    expect(generateObject.mock.calls[0]![0]).toMatchObject({
      effort: "high",
    });
  });
});
