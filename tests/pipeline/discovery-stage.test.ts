import { describe, expect, it, vi } from "vitest";

import type {
  ClaimDiscoveryResult,
  ParsedPaperDocument,
  ResolvedPaper,
  Result,
} from "../../src/domain/types.js";
import {
  buildDiscoverySeeds,
  runDiscoveryStage,
  type DiscoveryStageAdapters,
} from "../../src/pipeline/discovery-stage.js";

const PARSED_DOCUMENT: ParsedPaperDocument = {
  parserKind: "jats",
  parserVersion: "fixture",
  fullTextFormat: "jats_xml",
  blocks: [
    {
      blockId: "body-1",
      text: "Gene X increases protein Y in treated cells.",
      sectionTitle: "Results",
      blockKind: "body_paragraph",
      charOffsetStart: 0,
      charOffsetEnd: 43,
    },
  ],
  references: [],
  mentions: [],
};

function makePaper(id: string, doi: string): ResolvedPaper {
  return {
    id,
    doi,
    title: `Paper ${id}`,
    authors: ["Author A"],
    abstract: undefined,
    source: "openalex",
    fullTextHints: {
      providerAvailability: "available",
      providerSourceHint: "pmc_xml",
      repositoryUrl: `https://example.com/${id}.xml`,
    },
    paperType: "article",
    referencedWorksCount: 12,
    publicationYear: 2024,
  };
}

function makeDiscoveryResult(paper: ResolvedPaper): ClaimDiscoveryResult {
  return {
    doi: paper.doi ?? "unknown",
    resolvedPaper: paper,
    status: "completed",
    statusDetail: `Extracted 1 claims (1 findings) from ${paper.title}.`,
    claims: [
      {
        claimText: "Gene X increases protein Y",
        sourceSpans: ["Gene X increases protein Y in treated cells."],
        section: "Results",
        citedReferences: [],
        claimType: "finding",
        confidence: "high",
      },
    ],
    findingCount: 1,
    totalClaimCount: 1,
    llmModel: "mock-model",
    llmInputTokens: 10,
    llmOutputTokens: 5,
    llmEstimatedCostUsd: 0.01,
    ranking: undefined,
    fullTextAcquisition: undefined,
    generatedAt: "2026-04-07T00:00:00.000Z",
  };
}

describe("runDiscoveryStage", () => {
  it("keeps discovery results aligned for success and failure paths", async () => {
    const resolvedPaper = makePaper("paper-1", "10.1234/success");
    const discoveryResult = makeDiscoveryResult(resolvedPaper);

    const adapters: DiscoveryStageAdapters = {
      resolvePaperByDoi: vi.fn(
        (doi: string): Promise<Result<ResolvedPaper>> => {
          if (doi === "10.1234/success") {
            return Promise.resolve({ ok: true, data: resolvedPaper });
          }
          if (doi === "10.1234/no-fulltext") {
            return Promise.resolve({ ok: true, data: makePaper("paper-2", doi) });
          }
          return Promise.resolve({ ok: false, error: `Not found: ${doi}` });
        },
      ),
      materializeParsedPaper: vi.fn((paper: ResolvedPaper) => {
        if (paper.doi === "10.1234/no-fulltext") {
          return Promise.resolve({
            ok: false as const,
            error: "No fetchable full text candidates",
            acquisition: {
              materializationSource: "network" as const,
              attempts: [],
              selectedMethod: undefined,
              selectedLocatorKind: undefined,
              selectedUrl: undefined,
              fullTextFormat: undefined,
              failureReason: "No fetchable full text candidates",
            },
          });
        }
        return Promise.resolve({
          ok: true as const,
          data: {
            fullText: {
              content: "<article><body><p>fixture</p></body></article>",
              format: "jats_xml" as const,
            },
            acquisition: {
              materializationSource: "network" as const,
              attempts: [],
              selectedMethod: "pmc_xml" as const,
              selectedLocatorKind: "doi_input" as const,
              selectedUrl: "https://example.com/paper-1.xml",
              fullTextFormat: "jats_xml" as const,
              failureReason: undefined,
            },
            parsedDocument: PARSED_DOCUMENT,
          },
        });
      }),
      discoverClaims: vi.fn(() => Promise.resolve(discoveryResult)),
      getCitingPapers: vi.fn(() => Promise.resolve({
        ok: true as const,
        data: [makePaper("citing-1", "10.1234/citing-1")],
      })),
      rankClaimsByEngagement: vi.fn<
        DiscoveryStageAdapters["rankClaimsByEngagement"]
      >((_seedTitle, claims) => Promise.resolve({
        citingPapersAnalyzed: 1,
        citingPapersTotal: 1,
        rankingModel: "mock-ranker",
        rankingEstimatedCostUsd: 0.002,
        engagements: [
          {
            claimIndex: 0,
            claimText: claims[0]!.claimText,
            claimType: "finding" as const,
            directCount: 1,
            indirectCount: 0,
            directPapers: ["Citing Paper 1"],
          },
        ],
      })),
    };

    const stage = await runDiscoveryStage(
      {
        dois: ["10.1234/success", "10.1234/no-fulltext", "10.1234/missing"],
        topN: 2,
        rank: true,
      },
      adapters,
    );

    expect(stage.results).toHaveLength(3);
    expect(stage.results[0]!.status).toBe("completed");
    expect(stage.results[0]!.fullTextAcquisition?.selectedMethod).toBe(
      "pmc_xml",
    );
    expect(stage.results[0]!.ranking?.engagements[0]?.directCount).toBe(1);
    expect(stage.results[1]!.status).toBe("no_fulltext");
    expect(stage.results[1]!.fullTextAcquisition?.failureReason).toBe(
      "No fetchable full text candidates",
    );
    expect(stage.results[2]!.status).toBe("parse_failed");
    expect(stage.seeds).toEqual([
      {
        doi: "10.1234/success",
        trackedClaim: "Gene X increases protein Y",
        notes: "Auto-discovered; 1 direct, 0 indirect citing-paper engagements",
      },
    ]);
  });
});

describe("buildDiscoverySeeds", () => {
  it("falls back to top findings when ranking is absent", () => {
    const paper = makePaper("paper-3", "10.1234/unranked");
    const result: ClaimDiscoveryResult = {
      ...makeDiscoveryResult(paper),
      claims: [
        {
          claimText: "Finding one",
          sourceSpans: ["Finding one source."],
          section: "Results",
          citedReferences: [],
          claimType: "finding",
          confidence: "high",
        },
        {
          claimText: "Interpretation",
          sourceSpans: ["Interpretation source."],
          section: "Discussion",
          citedReferences: [],
          claimType: "interpretation",
          confidence: "medium",
        },
        {
          claimText: "Finding two",
          sourceSpans: ["Finding two source."],
          section: "Results",
          citedReferences: [],
          claimType: "finding",
          confidence: "high",
        },
      ],
      findingCount: 2,
      totalClaimCount: 3,
    };

    expect(buildDiscoverySeeds([result], 1)).toEqual([
      {
        doi: "10.1234/unranked",
        trackedClaim: "Finding one",
        notes: "Auto-discovered (unranked)",
      },
    ]);
  });
});
