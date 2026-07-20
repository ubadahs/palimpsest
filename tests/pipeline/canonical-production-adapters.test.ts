import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config/app-config.js";
import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import { LLM_CACHE_VERSIONS } from "../../src/config/llm-versions.js";
import type {
  GenerateTextParams,
  LLMClient,
} from "../../src/integrations/llm-client.js";
import {
  buildCanonicalAdjudicateAdapters,
  buildCanonicalDiscoverAdapters,
  buildCanonicalPrepareAdapters,
  buildCanonicalScopeAdapters,
  mapFullTextAcquisitionFailure,
  openAlexNeighborhoodSeedId,
  parseCanonicalAttributedClaimExtractionResponse,
  selectSeedReferenceMentions,
} from "../../src/pipeline/canonical-production-adapters.js";
import { createCanonicalProvenanceStore } from "../../src/pipeline/canonical-provenance-store.js";
import { canonicalSha256 } from "../../src/shared/stable-identity.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "canonical-provenance-"));
  tempRoots.push(root);
  return createCanonicalProvenanceStore(root);
}

function appConfig(): AppConfig {
  return {
    nodeEnv: "test",
    databasePath: ":memory:",
    providerBaseUrls: {
      openAlex: "https://example.test/openalex",
      semanticScholar: "https://example.test/s2",
      bioRxiv: "https://example.test/biorxiv",
      grobid: "https://example.test/grobid",
    },
    openAlexEmail: undefined,
    semanticScholarApiKey: undefined,
    anthropicApiKey: undefined,
    institutionalProxyUrl: undefined,
  };
}

function llmClientReturning(text: string): LLMClient {
  return {
    generateText: () =>
      Promise.resolve({
        text,
        record: {
          purpose: "attributed-claim-extraction",
          model: "fixture-model",
          attempted: true,
          successful: true,
          failed: false,
          billable: false,
          thinkingEnabled: false,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          finishReason: "stop",
          timestamp: "2026-07-17T12:00:00.000Z",
          estimatedCostUsd: 0,
        },
      }),
    generateObject: () => {
      throw new Error("not used");
    },
    getLedger: () => ({
      totalCalls: 0,
      totalAttemptedCalls: 0,
      totalSuccessfulCalls: 0,
      totalFailedCalls: 0,
      totalBillableCalls: 0,
      totalExactCacheHits: 0,
      totalEstimatedCostUsd: 0,
      byPurpose: {},
      calls: [],
    }),
  } as LLMClient;
}

function discoverAdapterFor(text: string) {
  return buildCanonicalDiscoverAdapters({
    config: appConfig(),
    runConfig: analysisRunConfigSchema.parse({}),
    llmClient: llmClientReturning(text),
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

const seed = {
  status: "resolved" as const,
  paper: {
    paperId: "seed-paper",
    providerRecordId: "https://openalex.org/W123",
    title: "Seed paper",
    doi: "10.1000/seed",
    authors: ["Seed Author"],
  },
  execution: {
    provider: "openalex",
    requestHash: "a".repeat(64),
    requestArtifact: {
      artifactId: `fixture_${"a".repeat(64)}`,
      contentHash: "a".repeat(64),
      role: "request",
    },
    responseArtifact: {
      artifactId: `fixture_${"b".repeat(64)}`,
      contentHash: "b".repeat(64),
      role: "response",
    },
  },
};

const citingPaper = {
  providerRecordId: "https://openalex.org/W456",
  paperId: "citing-paper",
  title: "Citing paper",
  authors: ["Citing Author"],
  fullTextAvailability: "available" as const,
  provenanceArtifacts: [
    {
      artifactId: `fixture_${"c".repeat(64)}`,
      contentHash: "c".repeat(64),
      role: "paper",
    },
  ],
};

const mention = {
  mentionId: `mention_${"d".repeat(64)}`,
  seedId: `seed_${"e".repeat(64)}`,
  citingPaperRecordId: `citing-paper_${"f".repeat(64)}`,
  citingPaperId: "citing-paper",
  citedPaperId: "seed-paper",
  mentionIndex: 0,
  targetRefIds: ["seed-ref"],
  identityStrength: "weak_context_fallback" as const,
  citationMarker: "[1]",
  rawContext: "The seed showed claim A and claim B [1].",
  isBundledCitation: false,
  bundleSize: 1,
  bundleRefIds: ["seed-ref"],
  bundlePattern: "single",
  observationProvenance: {
    sourceType: "jats_xml",
    parser: "fixture",
    artifacts: [
      {
        artifactId: `fixture_${"1".repeat(64)}`,
        contentHash: "1".repeat(64),
        role: "mention",
      },
    ],
  },
};

describe("canonical production adapter seams", () => {
  it("stores identical bodies under different roles without overwrite", () => {
    const store = makeStore();
    const body = { exact: "normalized boundary body" };
    const request = store.persist({ role: "request-role", body });
    const response = store.persist({ role: "response-role", body });

    expect(request.contentHash).toBe(response.contentHash);
    expect(request.artifactId).not.toBe(response.artifactId);
    expect(store.pathFor(request)).not.toBe(store.pathFor(response));
    expect(store.load(request)).toEqual({
      role: "request-role",
      contentHash: canonicalSha256(body),
      body,
    });
    expect(store.load(response)).toEqual({
      role: "response-role",
      contentHash: canonicalSha256(body),
      body,
    });
    expect(
      JSON.parse(readFileSync(store.pathFor(request), "utf8")),
    ).toMatchObject({ role: "request-role", body });
  });

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
            cursor: "*",
            perPage: 10,
            returnedCount: 1,
            nextCursor: null,
            responseTotalCount: 1,
          },
        ],
        providerReportedTotal: 1,
        coverage: "complete",
      },
    });
    const adapter = buildCanonicalDiscoverAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({}),
      llmClient: llmClientReturning("{}"),
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
    const openAlexPageArtifacts = (
      openAlex as { pageArtifacts: unknown[] }
    ).pageArtifacts;
    expect(openAlexPageArtifacts).toHaveLength(2);
    const openAlexPapers = (
      openAlex as { papers: { provenanceArtifacts: unknown[] }[] }
    ).papers;
    // Each returned paper carries its owning page's response artifact.
    expect(openAlexPapers[0]?.provenanceArtifacts.length).toBeGreaterThan(1);
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
    const s2Adapter = buildCanonicalDiscoverAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({}),
      llmClient: llmClientReturning("{}"),
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

  it("maps publisher paywalls to per-paper unavailable, not provider auth", () => {
    expect(
      mapFullTextAcquisitionFailure({
        failureCode: "paywall",
        error: "HTTP 403 from publisher PDF",
      }),
    ).toEqual({
      reasonCode: "unavailable",
      reason: "HTTP 403 from publisher PDF",
    });
    expect(
      mapFullTextAcquisitionFailure({
        failureCode: "authentication",
        error: "proxy login required",
      }).reasonCode,
    ).toBe("unavailable");
    expect(
      mapFullTextAcquisitionFailure({
        failureCode: "authorization",
        error: "publisher forbidden",
      }).reasonCode,
    ).toBe("unavailable");
    expect(
      mapFullTextAcquisitionFailure({
        failureCode: "not_found",
        error: "no pdf candidate",
      }).reasonCode,
    ).toBe("not_found");
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
    [
      "zero",
      JSON.stringify({ claims: [], reason: "No empirical attribution." }),
      0,
    ],
    [
      "one",
      JSON.stringify({
        claims: [{ text: "Claim A", confidence: "high" }],
        reason: "One claim.",
      }),
      1,
    ],
    [
      "multiple",
      JSON.stringify({
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
      }),
      2,
    ],
  ])("preserves %s extraction outputs", (_label, text, count) => {
    const parsed = parseCanonicalAttributedClaimExtractionResponse(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.claims).toHaveLength(count);
  });

  it("rejects malformed extraction output", () => {
    expect(
      parseCanonicalAttributedClaimExtractionResponse(
        JSON.stringify({ claims: [{ text: "" }] }),
      ).ok,
    ).toBe(false);
  });

  it("maps all extracted claims through the Discover adapter", async () => {
    const adapter = discoverAdapterFor(
      JSON.stringify({
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
        reason: "Two claims.",
      }),
    );
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

  it("marks review publication types as review-mediated in Prepare", async () => {
    const adapter = buildCanonicalPrepareAdapters();
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

  it("records adaptive thinking and cache provenance for Scope grounding", async () => {
    const generateText = vi.fn((params: GenerateTextParams) =>
      Promise.resolve({
        text: JSON.stringify({
          status: "not_found",
          detailReason: "No support",
          supportSpans: [],
        }),
        record: {
          purpose: "seed-grounding" as const,
          model: params.model ?? "claude-sonnet-4-6",
          attempted: true as const,
          successful: true,
          failed: false,
          billable: true,
          thinkingEnabled: true,
          thinkingType: "adaptive" as const,
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
    const adapter = buildCanonicalScopeAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({
        scope: {
          groundingModel: "claude-sonnet-4-6",
          groundingThinking: true,
        },
      }),
      llmClient: {
        generateText,
        generateObject: () => {
          throw new Error("not used");
        },
        getLedger: () => {
          throw new Error("not used");
        },
      },
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
        trackedClaim: "Tracked claim text",
        normalizedClaim: "tracked claim text",
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

    expect(generateText).toHaveBeenCalledOnce();
    expect(generateText.mock.calls[0]![0]).toMatchObject({
      purpose: "seed-grounding",
      model: "claude-sonnet-4-6",
      thinking: { type: "adaptive", effort: "high" },
      exactCache: { keyVersion: LLM_CACHE_VERSIONS.grounding },
    });
    expect(result.status).toBe("completed");
    expect(result.execution).toBeDefined();
    const request = store.load(result.execution!.requestArtifact);
    expect(request).toMatchObject({
      body: {
        familyId: "family_1",
        llm: {
          purpose: "seed-grounding",
          model: "claude-sonnet-4-6",
          thinking: { mode: "adaptive", effort: "high" },
          exactCacheKeyVersion: LLM_CACHE_VERSIONS.grounding,
          cachePolicy: "bypass",
        },
      },
    });
  });

  it("uses legacy budget thinking for Haiku extraction when enabled", async () => {
    const generateText = vi.fn((params: GenerateTextParams) =>
      Promise.resolve({
        text: JSON.stringify({ claims: [], reason: "None." }),
        record: {
          purpose: "attributed-claim-extraction" as const,
          model: params.model ?? "claude-haiku-4-5",
          attempted: true as const,
          successful: true,
          failed: false,
          billable: true,
          thinkingEnabled: true,
          thinkingType: "enabled" as const,
          thinkingBudgetTokens: 8_000,
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
    const adapter = buildCanonicalDiscoverAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({
        discover: {
          extractionModel: "claude-haiku-4-5",
          extractionThinking: true,
        },
      }),
      llmClient: {
        generateText,
        generateObject: () => {
          throw new Error("not used");
        },
        getLedger: () => {
          throw new Error("not used");
        },
      },
      provenanceStore: makeStore(),
    });

    await adapter.extractAttributedClaims({ seed, citingPaper, mention });
    expect(generateText.mock.calls[0]![0]).toMatchObject({
      thinking: { type: "enabled", budgetTokens: 8_000 },
    });
  });

  it("uses adaptive thinking for Opus adjudication when enabled", async () => {
    const generateText = vi.fn((params: GenerateTextParams) =>
      Promise.resolve({
        text: JSON.stringify({
          fidelityLabel: "F",
          rationale: "Faithful.",
          occurrenceLocalClaimIds: [],
        }),
        record: {
          purpose: "adjudication" as const,
          model: params.model ?? "claude-opus-4-6",
          attempted: true as const,
          successful: true,
          failed: false,
          billable: true,
          thinkingEnabled: true,
          thinkingType: "adaptive" as const,
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
    const adapter = buildCanonicalAdjudicateAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({
        adjudicate: { model: "claude-opus-4-6", thinking: true },
      }),
      llmClient: {
        generateText,
        generateObject: () => {
          throw new Error("not used");
        },
        getLedger: () => {
          throw new Error("not used");
        },
      },
      provenanceStore: makeStore(),
    });

    expect(adapter.adjudicate).toBeTypeOf("function");
    await adapter.adjudicate!({
      purpose: "categorical_adjudication",
      recordId: "rec_1",
      promptId: "canonical-categorical-adjudicate",
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

    expect(generateText.mock.calls[0]![0]).toMatchObject({
      thinking: { type: "adaptive", effort: "high" },
    });
  });
});
