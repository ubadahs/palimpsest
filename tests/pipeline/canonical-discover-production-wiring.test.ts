import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config/app-config.js";
import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import type { ResolvedPaper } from "../../src/domain/common.js";
import type {
  GenerateTextParams,
  LLMClient,
} from "../../src/integrations/llm-client.js";
import type { CitingWorksResult } from "../../src/integrations/openalex.js";
import { buildCanonicalDiscoverAdapters } from "../../src/pipeline/canonical-production-adapters.js";
import {
  buildCanonicalDiscoverArtifact,
  runCanonicalDiscover,
} from "../../src/pipeline/canonical-discover.js";
import { createCanonicalProvenanceStore } from "../../src/pipeline/canonical-provenance-store.js";
import type { FullTextFetchAdapters } from "../../src/retrieval/fulltext-fetch.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/pipeline/vrn-replay",
);
const SEED_DOI = "10.1000/jin.20210042";
const BUNDLED_LANDING = "https://fixture.test/bundled.html";
const BUNDLED_XML = "https://fixture.test/bundled.jats.xml";
const PAYWALL_PDF = "https://publisher.test/paywalled.pdf";
const PVALB_CLAIM =
  "Pvalb+ fast-spiking interneurons increase gamma power after 40 Hz stimulation.";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

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

function seedPaper(): ResolvedPaper {
  return {
    id: "https://openalex.org/Wseed20210042",
    doi: SEED_DOI,
    title: "Visual experience and VRN circuit maturation",
    authors: ["Belicova L"],
    source: "openalex",
    publicationYear: 2020,
    paperType: "article",
    fullTextHints: {
      providerAvailability: "unavailable",
    },
    resolutionProvenance: {
      method: "doi",
      confidence: "exact",
      requestedIdentifierType: "doi",
      requestedIdentifier: SEED_DOI,
    },
  };
}

function paywalledCiter(): ResolvedPaper {
  return {
    id: "https://openalex.org/Wpaywalled",
    doi: "10.2000/paywalled",
    title: "Paywalled citer",
    authors: ["Pay Wall"],
    source: "openalex",
    publicationYear: 2021,
    paperType: "article",
    fullTextHints: {
      providerAvailability: "unavailable",
      pdfUrl: PAYWALL_PDF,
    },
  };
}

function bundledCiter(): ResolvedPaper {
  return {
    id: "https://openalex.org/Wbundled",
    doi: "10.2000/bundled",
    title: "Bundled and repeated citer",
    authors: ["Bundle Author"],
    source: "openalex",
    publicationYear: 2022,
    paperType: "article",
    fullTextHints: {
      providerAvailability: "available",
      landingPageUrl: BUNDLED_LANDING,
    },
  };
}

function mockedFullTextAdapters(jatsXml: string): FullTextFetchAdapters {
  return {
    fetchUrl: (url) => {
      if (url === PAYWALL_PDF) {
        return Promise.resolve({
          ok: true,
          data: {
            finalUrl: url,
            status: 403,
            contentType: "text/html",
            body: Buffer.from("Forbidden"),
          },
        });
      }
      if (url === BUNDLED_LANDING) {
        return Promise.resolve({
          ok: true,
          data: {
            finalUrl: url,
            status: 200,
            contentType: "text/html",
            body: Buffer.from(
              `<html><head><meta name="citation_xml_url" content="${BUNDLED_XML}"></head><body>landing</body></html>`,
            ),
          },
        });
      }
      if (url === BUNDLED_XML) {
        return Promise.resolve({
          ok: true,
          data: {
            finalUrl: url,
            status: 200,
            contentType: "application/xml",
            body: Buffer.from(jatsXml),
          },
        });
      }
      return Promise.resolve({
        ok: false,
        error: `Unexpected fetchUrl: ${url}`,
      });
    },
    processPdfWithGrobid: () =>
      Promise.resolve({ ok: false, error: "GROBID unused in wiring test" }),
    email: undefined,
    institutionalProxyUrl: undefined,
  };
}

function mockedLlmClient(): LLMClient {
  return {
    generateText: (params: GenerateTextParams) => {
      const promptText =
        typeof params.prompt === "string"
          ? params.prompt
          : (params.promptPrefix ?? "");
      const wantsPvalb = promptText.toLowerCase().includes("pvalb");
      const text = JSON.stringify({
        claims: wantsPvalb
          ? [
              {
                text: PVALB_CLAIM,
                supportSpanText: "Pvalb+ fast-spiking",
                confidence: "high",
              },
            ]
          : [
              {
                text: "GABAergic interneurons play an important role in the brain.",
                supportSpanText:
                  "GABAergic interneurons play an important role",
                confidence: "medium",
              },
            ],
        reason: "Fixture extraction from prompt context.",
      });
      return Promise.resolve({
        text,
        record: {
          purpose: "attributed-claim-extraction",
          model: params.model,
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
          timestamp: "2026-07-19T18:00:00.000Z",
          estimatedCostUsd: 0,
        },
      });
    },
    generateObject: () => {
      throw new Error("generateObject unused");
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

describe("canonical Discover production wiring", () => {
  it("runs Discover adapters with mocked OpenAlex, full text, and LLM only", async () => {
    const root = mkdtempSync(join(tmpdir(), "discover-wiring-"));
    tempRoots.push(root);
    const jatsXml = readFileSync(
      join(FIXTURE_ROOT, "citing-bundled-repeated.jats.xml"),
      "utf8",
    );
    const citingWorks: CitingWorksResult = {
      papers: [paywalledCiter(), bundledCiter()],
      pages: [
        {
          pageIndex: 0,
          requestUrl:
            "https://example.test/openalex/works?filter=cites:Wseed20210042&cursor=*",
          cursor: "*",
          perPage: 1,
          returnedCount: 1,
          nextCursor: "page-2",
          responseTotalCount: 2,
        },
        {
          pageIndex: 1,
          requestUrl:
            "https://example.test/openalex/works?filter=cites:Wseed20210042&cursor=page-2",
          cursor: "page-2",
          perPage: 1,
          returnedCount: 1,
          nextCursor: null,
          responseTotalCount: 2,
        },
      ],
      providerReportedTotal: 2,
      coverage: "complete",
    };

    const adapters = buildCanonicalDiscoverAdapters({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({
        discover: {
          neighborhoodLimit: 25,
          probeBudget: 2,
          candidateSelection: {
            mode: "adaptive_portfolio",
            minFamilies: 1,
            maxFamilies: 5,
            maxPreparedRecords: 20,
          },
        },
      }),
      llmClient: mockedLlmClient(),
      provenanceStore: createCanonicalProvenanceStore(root),
      fullTextAdapters: mockedFullTextAdapters(jatsXml),
      paperProviders: {
        resolvePaperByDoi: () =>
          Promise.resolve({ ok: true, data: seedPaper() }),
        getCitingWorks: () => Promise.resolve({ ok: true, data: citingWorks }),
        resolveOpenAlexWorkByDoi: () =>
          Promise.resolve({ ok: true, data: seedPaper() }),
      },
    });

    const options = {
      seeds: [
        {
          doi: SEED_DOI,
          provenanceArtifacts: [
            {
              artifactId: buildStableId("fixture", {
                role: "doi-input",
                doi: SEED_DOI,
              }),
              contentHash: canonicalSha256(SEED_DOI),
              role: "doi-input",
            },
          ],
        },
      ],
      neighborhood: {
        provider: "openalex",
        query: "works-citing-seed",
        limit: 25,
      },
      probeBudget: 2,
      candidateSelection: {
        mode: "adaptive_portfolio" as const,
        minFamilies: 1,
        maxFamilies: 5,
        maxPreparedRecords: 20,
        prevalenceWeight: 0.25,
        specificityWeight: 0.35,
        confidenceWeight: 0.15,
        noveltyWeight: 0.25,
        minMarginalNovelty: 0.08,
        policyVersion: "adaptive-portfolio-v3" as const,
      },
      recordedAt: "2026-07-19T18:00:00.000Z",
    };

    const result = await runCanonicalDiscover(options, adapters);
    const artifact = buildCanonicalDiscoverArtifact({
      result,
      runId: "run-discover-production-wiring",
      createdAt: "2026-07-19T18:05:00.000Z",
      configuration: { contentHash: canonicalSha256(options) },
    });

    expect(artifact.canonicalStage).toBe("discover");
    expect(artifact.payload.neighborhoodQueries).toHaveLength(1);
    expect(artifact.payload.neighborhoodQueries[0]).toMatchObject({
      status: "completed",
      coverage: "complete",
      returnedCount: 2,
      providerReportedTotal: 2,
    });
    expect(
      artifact.payload.neighborhoodQueries[0]!.provenanceArtifacts.length,
    ).toBeGreaterThanOrEqual(3);

    const paywalled = artifact.payload.citingPapers.find(
      (paper) => paper.paper.paperId === "https://openalex.org/Wpaywalled",
    );
    expect(paywalled?.probe.status).toBe("selected");
    expect(paywalled?.materialization.status).toBe("unavailable");
    expect(paywalled?.materialization).toMatchObject({
      reasonCode: "unavailable",
    });
    expect(paywalled?.materialization).not.toMatchObject({
      reasonCode: "authentication",
    });
    expect(paywalled?.materialization).not.toMatchObject({
      reasonCode: "authorization",
    });

    const bundledMentions = artifact.payload.citationMentions.filter(
      (mention) => mention.citingPaperId === "https://openalex.org/Wbundled",
    );
    expect(bundledMentions).toHaveLength(2);
    expect(
      bundledMentions.every((mention) => mention.targetRefIds.includes("seed")),
    ).toBe(true);
    expect(
      new Set(bundledMentions.map((mention) => mention.mentionId)).size,
    ).toBe(2);
    expect(
      bundledMentions.some(
        (mention) =>
          mention.isBundledCitation &&
          mention.bundleRefIds.includes("r1") &&
          mention.bundleRefIds.includes("seed"),
      ),
    ).toBe(true);

    expect(
      artifact.payload.attributedClaimRecords.some(
        (claim) => claim.extractedClaimText === PVALB_CLAIM,
      ),
    ).toBe(true);
    expect(
      artifact.payload.candidateDispositions.some(
        (disposition) => disposition.selectedForScope,
      ),
    ).toBe(true);
  });
});
