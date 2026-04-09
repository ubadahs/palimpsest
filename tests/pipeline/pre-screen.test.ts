import { beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeSeedDoiForTraceKey } from "../../src/domain/pre-screen-grounding-trace.js";
import type {
  ParsedPaperMaterializeResult,
  ParsedPaperMaterialized,
} from "../../src/retrieval/parsed-paper.js";
import type { ResolvedPaper, Result } from "../../src/domain/types.js";
import type * as SeedLlm from "../../src/pipeline/seed-claim-grounding-llm.js";
import {
  runPreScreen,
  type PreScreenAdapters,
} from "../../src/pipeline/pre-screen.js";
import {
  applyCanonicalGroundingBlocksDownstream,
  runLlmFullDocumentClaimGrounding,
} from "../../src/pipeline/seed-claim-grounding-llm.js";

vi.mock(
  "../../src/pipeline/seed-claim-grounding-llm.js",
  async (importOriginal) => {
    // Vitest types importOriginal() as the module; tsc still needs an explicit assertion here.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- align Vitest vs tsc
    const actual = (await importOriginal()) as typeof SeedLlm;
    return {
      ...actual,
      runLlmFullDocumentClaimGrounding: vi.fn(
        (
          params: Parameters<
            typeof SeedLlm.runLlmFullDocumentClaimGrounding
          >[0],
        ) => {
          const manuscript = actual.buildSeedFullTextForLlm(
            params.parsedDocument,
          );
          const analystClaim = params.seed.trackedClaim.trim();
          if (manuscript.length === 0) {
            return Promise.resolve({
              grounding: actual.applyCanonicalGroundingBlocksDownstream({
                status: "no_seed_fulltext",
                analystClaim,
                normalizedClaim: analystClaim,
                supportSpans: [],
                blocksDownstream: false,
                detailReason: "No manuscript text (fixture).",
              }),
              llmCall: undefined,
            });
          }
          return Promise.resolve({
            grounding: actual.applyCanonicalGroundingBlocksDownstream({
              status: "grounded",
              analystClaim,
              normalizedClaim: analystClaim,
              supportSpans: [{ text: manuscript }],
              blocksDownstream: false,
              detailReason: "Mock LLM grounding.",
            }),
            llmCall: {
              modelId: "mock-model",
              promptTemplateVersion:
                actual.GROUNDING_LLM_PROMPT_TEMPLATE_VERSION,
              promptText: "mock-prompt",
              manuscriptCharCount: manuscript.length,
              manuscriptSha256: actual.sha256Utf8(manuscript),
              rawResponseText: '{"status":"grounded"}',
              latencyMs: 1,
            },
          });
        },
      ),
    };
  },
);

const LLM_OPTIONS = { llmGrounding: { anthropicApiKey: "test-api-key" } };

const DEFAULT_CLAIM_PHRASE = "Gene X does Y";

function fixtureParsedSeed(claimPhrase: string): ParsedPaperMaterialized {
  return {
    fullText: {
      content: "<article><body><p>placeholder</p></body></article>",
      format: "jats_xml",
    },
    acquisition: {
      materializationSource: "network",
      attempts: [],
      selectedMethod: "pmc_xml",
      selectedLocatorKind: "doi_input",
      selectedUrl: "https://example.com/seed.xml",
      fullTextFormat: "jats_xml",
    },
    parsedDocument: {
      parserKind: "jats",
      parserVersion: "fixture",
      fullTextFormat: "jats_xml",
      blocks: [
        {
          blockId: "fixture-body-1",
          text: `In summary, ${claimPhrase} was observed in our experiments.`,
          sectionTitle: "Results",
          blockKind: "body_paragraph",
          charOffsetStart: 0,
          charOffsetEnd: 80,
        },
      ],
      references: [],
      mentions: [],
    },
  };
}

function makePaper(
  id: string,
  overrides: Partial<ResolvedPaper> = {},
): ResolvedPaper {
  return {
    id,
    doi: `10.1234/${id}`,
    title: `Paper ${id}`,
    authors: ["Author"],
    abstract: `Abstract text. Related to ${DEFAULT_CLAIM_PHRASE}.`,
    source: "openalex",
    fullTextHints: {
      providerAvailability: "available",
      providerSourceHint: "biorxiv_xml",
      landingPageUrl: "https://example.com/paper",
      repositoryUrl: "https://example.com/paper",
    },
    paperType: "article",
    referencedWorksCount: 30,
    publicationYear: 2022,
    ...overrides,
  };
}

function makeAdapters(
  papers: Record<string, ResolvedPaper>,
  citingMap: Record<string, string[]>,
  claimPhrase: string = DEFAULT_CLAIM_PHRASE,
): PreScreenAdapters {
  return {
    resolveByDoi: (doi: string): Promise<Result<ResolvedPaper>> => {
      for (const paper of Object.values(papers)) {
        if (paper.doi === doi)
          return Promise.resolve({ ok: true, data: paper });
      }
      return Promise.resolve({ ok: false, error: `Not found: ${doi}` });
    },
    getCitingPapers: (openAlexId: string): Promise<Result<ResolvedPaper[]>> => {
      const ids = citingMap[openAlexId] ?? [];
      const results = ids
        .map((cid) => papers[cid])
        .filter((p): p is ResolvedPaper => p != null);
      return Promise.resolve({ ok: true, data: results });
    },
    seedClaimGrounding: {
      materializeSeedPaper: (): Promise<ParsedPaperMaterializeResult> =>
        Promise.resolve({
          ok: true,
          data: fixtureParsedSeed(claimPhrase),
        }),
    },
  };
}

beforeEach(() => {
  vi.mocked(runLlmFullDocumentClaimGrounding).mockClear();
});

describe("runPreScreen", () => {
  it("greenlights a seed with enough auditable edges", async () => {
    const seed = makePaper("seed-1");
    const citing1 = makePaper("citing-1");
    const citing2 = makePaper("citing-2");
    const citing3 = makePaper("citing-3");

    const adapters = makeAdapters(
      {
        "seed-1": seed,
        "citing-1": citing1,
        "citing-2": citing2,
        "citing-3": citing3,
      },
      { "seed-1": ["citing-1", "citing-2", "citing-3"] },
    );

    const { families: results, groundingTrace } = await runPreScreen(
      [{ doi: "10.1234/seed-1", trackedClaim: "Gene X does Y" }],
      adapters,
      LLM_OPTIONS,
    );

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.claimGrounding?.status).toBe("grounded");
    expect(result.claimGrounding?.blocksDownstream).toBe(false);
    expect(result.neighborhoodMetrics?.uniqueEdges).toBe(3);
    expect(result.decision).toBe("greenlight");
    expect(result.metrics.totalEdges).toBe(3);
    expect(result.metrics.auditableStructuredEdges).toBe(3);
    expect(result.metrics.auditableCoverage).toBe(1);

    expect(groundingTrace.artifactKind).toBe("pre-screen-grounding-trace");
    const key = normalizeSeedDoiForTraceKey("10.1234/seed-1");
    expect(
      groundingTrace.recordsBySeedDoi[key]?.finalClaimGrounding.status,
    ).toBe("grounded");
    expect(
      groundingTrace.recordsBySeedDoi[key]?.llmCall?.manuscriptSha256,
    ).toHaveLength(64);
  });

  it("deprioritizes when too few auditable edges", async () => {
    const seed = makePaper("seed-1");
    const closed1 = makePaper("closed-1", {
      fullTextHints: {
        providerAvailability: "unavailable",
        providerReason: "Paywalled",
      },
    });
    const closed2 = makePaper("closed-2", {
      fullTextHints: {
        providerAvailability: "unavailable",
        providerReason: "Paywalled",
      },
    });

    const adapters = makeAdapters(
      { "seed-1": seed, "closed-1": closed1, "closed-2": closed2 },
      { "seed-1": ["closed-1", "closed-2"] },
    );

    const { families: results } = await runPreScreen(
      [{ doi: "10.1234/seed-1", trackedClaim: "Gene X does Y" }],
      adapters,
      LLM_OPTIONS,
    );

    const result = results[0]!;
    expect(result.decision).toBe("deprioritize");
    expect(result.metrics.notAuditableEdges).toBe(2);
    expect(result.metrics.auditableStructuredEdges).toBe(0);
    expect(result.metrics.auditablePdfEdges).toBe(0);
  });

  it("deprioritizes when seed cannot be resolved", async () => {
    const adapters = makeAdapters({}, {});

    const { families: results } = await runPreScreen(
      [{ doi: "10.1234/missing", trackedClaim: "Unknown claim" }],
      adapters,
      LLM_OPTIONS,
    );

    const result = results[0]!;
    expect(result.decision).toBe("deprioritize");
    expect(result.resolvedSeedPaper).toBeUndefined();
    expect(result.decisionReason).toContain("resolve");
    expect(runLlmFullDocumentClaimGrounding).not.toHaveBeenCalled();
  });

  it("proceeds when LLM grounding does not support the claim (not_found is a fidelity signal)", async () => {
    const seed = makePaper("seed-1");
    const citing1 = makePaper("citing-1");
    const citing2 = makePaper("citing-2");
    const citing3 = makePaper("citing-3");
    const adapters = makeAdapters(
      {
        "seed-1": seed,
        "citing-1": citing1,
        "citing-2": citing2,
        "citing-3": citing3,
      },
      { "seed-1": ["citing-1", "citing-2", "citing-3"] },
    );

    vi.mocked(runLlmFullDocumentClaimGrounding).mockResolvedValueOnce({
      grounding: applyCanonicalGroundingBlocksDownstream({
        status: "not_found",
        analystClaim: "Gene X does Y",
        normalizedClaim: "Gene X does Y",
        supportSpans: [],
        blocksDownstream: false,
        detailReason: "Claim not found in manuscript.",
      }),
      llmCall: {
        modelId: "mock-model",
        promptTemplateVersion: "v",
        promptText: "p",
        manuscriptCharCount: 10,
        manuscriptSha256: "a".repeat(64),
        rawResponseText: "{}",
        latencyMs: 0,
      },
    });

    const { families: results } = await runPreScreen(
      [{ doi: "10.1234/seed-1", trackedClaim: "Gene X does Y" }],
      adapters,
      LLM_OPTIONS,
    );

    const result = results[0]!;
    expect(result.claimGrounding?.status).toBe("not_found");
    expect(result.claimGrounding?.blocksDownstream).toBe(false);
    expect(result.decision).toBe("greenlight");
  });

  it("handles mixed auditability across edges", async () => {
    const seed = makePaper("seed-1");
    const open1 = makePaper("open-1");
    const open2 = makePaper("open-2");
    const open3 = makePaper("open-3");
    const partial = makePaper("partial-1", {
      fullTextHints: {
        providerAvailability: "abstract_only",
      },
    });
    const closed = makePaper("closed-1", {
      fullTextHints: {
        providerAvailability: "unavailable",
        providerReason: "Paywalled",
      },
    });

    const adapters = makeAdapters(
      {
        "seed-1": seed,
        "open-1": open1,
        "open-2": open2,
        "open-3": open3,
        "partial-1": partial,
        "closed-1": closed,
      },
      { "seed-1": ["open-1", "open-2", "open-3", "partial-1", "closed-1"] },
    );

    const { families: results } = await runPreScreen(
      [{ doi: "10.1234/seed-1", trackedClaim: "Gene X does Y" }],
      adapters,
      LLM_OPTIONS,
    );

    const result = results[0]!;
    expect(result.decision).toBe("greenlight");
    expect(result.metrics.totalEdges).toBe(5);
    expect(result.metrics.auditableStructuredEdges).toBe(3);
    expect(result.metrics.partiallyAuditableEdges).toBe(1);
    expect(result.metrics.notAuditableEdges).toBe(1);
    expect(result.metrics.auditableCoverage).toBe(0.6);
  });

  it("processes multiple seeds independently", async () => {
    const seed1 = makePaper("seed-1");
    const seed2 = makePaper("seed-2");
    const citing = makePaper("citing-1");

    const adaptersMulti = makeAdapters(
      { "seed-1": seed1, "seed-2": seed2, "citing-1": citing },
      { "seed-1": ["citing-1"], "seed-2": [] },
      "Claim A",
    );
    adaptersMulti.seedClaimGrounding = {
      materializeSeedPaper: (paper) => {
        const phrase = paper.id === "seed-1" ? "Claim A" : "Claim B";
        return Promise.resolve({ ok: true, data: fixtureParsedSeed(phrase) });
      },
    };

    const { families: results } = await runPreScreen(
      [
        { doi: "10.1234/seed-1", trackedClaim: "Claim A" },
        { doi: "10.1234/seed-2", trackedClaim: "Claim B" },
      ],
      adaptersMulti,
      LLM_OPTIONS,
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.decision).toBe("deprioritize");
    expect(results[1]!.decision).toBe("deprioritize");
  });

  it("throws when Anthropic API key is missing", async () => {
    const adapters = makeAdapters(
      { "seed-1": makePaper("seed-1") },
      { "seed-1": [] },
    );
    await expect(
      runPreScreen(
        [{ doi: "10.1234/seed-1", trackedClaim: "x" }],
        adapters,
        {},
      ),
    ).rejects.toThrow(/anthropicApiKey/);
  });
});
