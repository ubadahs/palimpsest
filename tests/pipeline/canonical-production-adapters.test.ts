import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config/app-config.js";
import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import { PROMPT_VERSIONS } from "../../src/config/prompt-versions.js";
import type {
  GenerateObjectParams,
  LLMClient,
} from "../../src/integrations/llm-client.js";
import { LLMProviderError } from "../../src/integrations/llm-client.js";
import {
  buildCanonicalAdjudicateAdapters,
  buildCanonicalDiscoverAdapters,
  buildCanonicalPrepareAdapters,
  buildCanonicalScopeAdapters,
  mapFullTextAcquisitionFailure,
  openAlexNeighborhoodSeedId,
  canonicalAttributedClaimExtractionOutputSchema,
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
    grobidConcurrency: 2,
    openAlexEmail: undefined,
    semanticScholarApiKey: undefined,
    anthropicApiKey: undefined,
    institutionalProxyUrl: undefined,
  };
}

const FIXTURE_RECORD = {
  purpose: "attributed-claim-extraction",
  model: "fixture-model",
  attempted: true,
  successful: true,
  failed: false,
  billable: false,
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  latencyMs: 1,
  finishReason: "stop",
  timestamp: "2026-07-17T12:00:00.000Z",
  estimatedCostUsd: 0,
} as const;

/** Answers structured-output calls with a fixed object. */
function llmClientReturning(object: unknown): LLMClient {
  return {
    generateText: () => {
      throw new Error("canonical adapters use structured outputs");
    },
    generateObject: () => Promise.resolve({ object, record: FIXTURE_RECORD }),
    getLedger: () => ({
      totalCalls: 0,
      totalAttemptedCalls: 0,
      totalSuccessfulCalls: 0,
      totalFailedCalls: 0,
      totalBillableCalls: 0,
      totalExactCacheHits: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalEstimatedCostUsd: 0,
      byPurpose: {},
      calls: [],
    }),
  } as LLMClient;
}

function discoverAdapterFor(object: unknown) {
  return buildCanonicalDiscoverAdapters({
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
  locationQuality: "exact_dom" as const,
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
  return buildCanonicalPrepareAdapters({
    config: appConfig(),
    runConfig: analysisRunConfigSchema.parse(runConfig),
    llmClient: {
      generateObject,
      generateText: () => {
        throw new Error("not used");
      },
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
    const adapter = buildCanonicalDiscoverAdapters({
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
    const s2Adapter = buildCanonicalDiscoverAdapters({
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
    const parsed =
      canonicalAttributedClaimExtractionOutputSchema.safeParse(reply);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.claims).toHaveLength(count);
  });

  it("rejects malformed extraction output", () => {
    expect(
      canonicalAttributedClaimExtractionOutputSchema.safeParse({
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
    const adapter = buildCanonicalScopeAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({
        scope: {
          groundingModel: "claude-sonnet-5-5",
          groundingThinking: true,
        },
      }),
      llmClient: {
        generateObject,
        generateText: () => {
          throw new Error("not used");
        },
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
    const adapter = buildCanonicalDiscoverAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({
        discover: {
          extractionModel: "claude-haiku-5-5",
          extractionThinking: true,
        },
      }),
      llmClient: {
        generateObject,
        generateText: () => {
          throw new Error("not used");
        },
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
    const adapter = buildCanonicalAdjudicateAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({
        adjudicate: { model: "claude-opus-5-5", thinking: true },
      }),
      llmClient: {
        generateObject,
        generateText: () => {
          throw new Error("not used");
        },
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
    const adapter = buildCanonicalAdjudicateAdapters({
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
        promptId: "canonical-seed-text-adjudicate",
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
