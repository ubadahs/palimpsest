import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config/app-config.js";
import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import type { LLMClient } from "../../src/integrations/llm-client.js";
import { createProvenanceStore } from "../../src/pipeline/provenance-store.js";
import { hashAdjudicateRequest } from "../../src/contract/artifacts/adjudicate.js";
import {
  runPipeline,
  type PipelineAdapters,
} from "../../src/pipeline/executor.js";
import type { DiscoverAdapters } from "../../src/stages/discover/run.js";
import type { ScopeAdapters } from "../../src/stages/scope/run.js";
import type { EvidenceAdapters } from "../../src/stages/evidence/run.js";
import {
  adjudicatePromptText,
  type AdjudicateAdapters,
} from "../../src/stages/adjudicate/run.js";
import { parseParsedPaperDocument } from "../../src/retrieval/parsed-paper.js";
import { getRunStage } from "../../src/storage/analysis-runs.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";
import { canonicalSha256 } from "../../src/shared/stable-identity.js";
import { loadArtifact } from "../../src/contract/selectors.js";
import { stubCodebookAdapters } from "../stages/scope/codebook.fixture.js";
import { selectSeedReferenceMentions } from "../../src/stages/discover/adapters.js";
import { buildPrepareAdapters } from "../../src/stages/prepare/adapters.js";
import { mapFullTextAcquisitionFailure } from "../../src/stages/production.js";
import {
  artifactReference,
  externalExecution,
  modelExecution,
} from "../stages/chain.fixture.js";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/pipeline/replay",
);
const SEED_DOI = "10.1000/jin.20210042";
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function harvestFromFixture(xmlName: string, paperId: string) {
  const parsed = parseParsedPaperDocument(
    readFileSync(join(FIXTURE_ROOT, xmlName), "utf8"),
    "jats_xml",
  );
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const seedMentions = selectSeedReferenceMentions(
    parsed.data.mentions,
    "seed",
  );
  return {
    materialization: {
      status: "succeeded" as const,
      reason: "Fixture materialization",
      provenanceArtifacts: [artifactReference("parsed-full-text", paperId)],
    },
    harvest: {
      status: "succeeded" as const,
      reason: "Fixture harvest",
      provenanceArtifacts: [artifactReference("mention-harvest", paperId)],
    },
    mentions: seedMentions.map((mention) => ({
      mentionIndex: mention.mentionIndex,
      refId: mention.refId,
      targetRefIds: mention.targetRefIds,
      ...(mention.charOffsetStart != null && mention.charOffsetEnd != null
        ? {
            charOffsetStart: mention.charOffsetStart,
            charOffsetEnd: mention.charOffsetEnd,
          }
        : {}),
      ...(mention.sourceLocator
        ? { sourceLocator: mention.sourceLocator }
        : {}),
      locationQuality: mention.locationQuality,
      citationGroupOrdinal: mention.citationGroupOrdinal,
      citationMarker: mention.citationMarker,
      rawContext: mention.rawContext,
      ...(mention.sectionTitle ? { sectionTitle: mention.sectionTitle } : {}),
      seedRefLabel: "Marlowe et al., 2021",
      isBundledCitation: mention.isBundledCitation,
      bundleSize: mention.bundleSize,
      bundleRefIds: mention.bundleRefIds,
      bundlePattern: mention.bundlePattern,
      sourceType: mention.sourceType,
      parser: mention.parser,
      parserVersion: parsed.data.parserVersion,
      provenanceArtifacts: [
        artifactReference(
          "source-citation-occurrence",
          `${paperId}-${String(mention.mentionIndex)}`,
        ),
      ],
    })),
  };
}

function productionPathDiscoverAdapters(): DiscoverAdapters {
  return {
    resolveSeed: ({ doi }) =>
      Promise.resolve({
        status: "resolved",
        paper: {
          paperId: "seed-paper",
          providerRecordId: "https://openalex.org/Wseed",
          title:
            "Laminar organization of inhibitory neuron subtypes in the north relay field",
          doi,
          authors: ["Marlowe R", "Okafor T", "Lindqvist H"],
          publicationYear: 2021,
        },
        execution: externalExecution("openalex", `resolve-${doi}`),
      }),
    retrieveCitingNeighborhood: () =>
      Promise.resolve({
        status: "completed",
        providerReportedTotal: 2,
        coverage: "complete",
        papers: [
          {
            providerRecordId: "provider-bundled",
            paperId: "citing-bundled",
            title: "Bundled citer",
            doi: "10.2000/bundled",
            authors: ["Bundle Author"],
            publicationYear: 2022,
            fullTextAvailability: "available",
            provenanceArtifacts: [
              artifactReference("provider-paper-record", "bundled"),
            ],
          },
          {
            providerRecordId: "provider-paywalled",
            paperId: "citing-paywalled",
            title: "Paywalled citer",
            doi: "10.2000/paywalled",
            authors: ["Pay Wall"],
            publicationYear: 2021,
            fullTextAvailability: "unavailable",
            provenanceArtifacts: [
              artifactReference("provider-paper-record", "paywalled"),
            ],
          },
        ],
        pageArtifacts: [artifactReference("neighborhood-page", "1")],
        execution: externalExecution("openalex", "neighborhood"),
      }),
    harvestMentions: ({ citingPaper }) => {
      if (citingPaper.paperId === "citing-paywalled") {
        const mapped = mapFullTextAcquisitionFailure({
          failureCode: "paywall",
          error: "HTTP 403",
        });
        return Promise.resolve({
          materialization: {
            status: "unavailable",
            reasonCode: mapped.reasonCode,
            reason: mapped.reason,
            provenanceArtifacts: [
              artifactReference("acquisition-failure", citingPaper.paperId),
            ],
          },
          harvest: {
            status: "not_attempted",
            reason: "Harvest not attempted after materialization failure.",
            provenanceArtifacts: [
              artifactReference("harvest-not-attempted", citingPaper.paperId),
            ],
          },
          mentions: [],
        });
      }
      return Promise.resolve(
        harvestFromFixture(
          "citing-bundled-repeated.jats.xml",
          citingPaper.paperId,
        ),
      );
    },
    extractAttributedClaims: ({ mention }) =>
      Promise.resolve({
        status: "completed",
        reason: "Fixture extraction",
        claims: mention.rawContext.toLowerCase().includes("lorn")
          ? [
              {
                text: "Lorn+ relay cells increase burst rate after a patterned stimulus.",
                supportSpanText: "Lorn+ relay cells",
                confidence: "high",
              },
            ]
          : [
              {
                text: "The same seed finding supports circuit plasticity.",
                supportSpanText: "circuit plasticity",
                confidence: "medium",
              },
            ],
        execution: modelExecution(
          "discover",
          `${mention.citingPaperId}-${String(mention.mentionIndex)}`,
        ),
      }),
  };
}

function productionPathScopeAdapters(): ScopeAdapters {
  return {
    materializeSeed: ({ seed }) =>
      Promise.resolve({
        seedId: seed.seedId,
        status: "materialized",
        reason: "Fixture seed manuscript materialized.",
        seedTextArtifact: artifactReference("parsed-seed-text", seed.seedId),
        sourceArtifacts: [
          artifactReference("raw-seed-manuscript", seed.seedId),
        ],
        parser: { kind: "fixture-structured-parser", version: "v1" },
        blocks: [
          {
            blockId: "scope-block-results",
            text: "Lorn+ relay cells increase burst rate after a patterned stimulus in the visual pathway.",
            sectionTitle: "Results",
            blockKind: "body_paragraph" as const,
            charOffsetStart: 0,
            charOffsetEnd: 87,
          },
        ],
        execution: {
          kind: "external" as const,
          ...externalExecution("fixture-full-text", seed.seedId),
        },
      }),
    ...stubCodebookAdapters(),
    groundFamily: ({ family }) =>
      Promise.resolve({
        status: "completed",
        rawOutput: {
          status: "grounded",
          detailReason: "Results block supports the family claim.",
          supportSpans: [
            {
              verbatimQuote:
                "Lorn+ relay cells increase burst rate after a patterned stimulus in the visual pathway.",
              blockId: "scope-block-results",
            },
          ],
        },
        execution: modelExecution("scope", family.familyId),
      }),
  };
}

function productionPathEvidenceAdapters(): EvidenceAdapters {
  return {};
}

function productionPathAdjudicateAdapters(): AdjudicateAdapters {
  return {
    adjudicate: (input) => {
      const requestHash = hashAdjudicateRequest(input);
      const base = modelExecution("adjudicate", input.recordId);
      return Promise.resolve({
        status: "completed",
        rawOutput: {
          citingAssertion: "Citing claim matches seed result.",
          sourceStatement: "The seed reports the same result.",
          verdict: "F",
          mutationKinds: [],
          direction: "none",
          rationale: "Exact phenotype match in selected chunks.",
          confidence: "high",
          citedChunkIds: [input.packet.selectedChunks[0]!.chunkId],
        },
        execution: {
          ...base,
          promptId: input.promptId,
          promptVersion: input.promptVersion,
          promptContentHash: canonicalSha256(adjudicatePromptText(input)),
          requestHash,
        },
      });
    },
  };
}

/** Answers the citation-role fallback; every other purpose is stubbed above. */
function roleClassifierLlmClient(): LLMClient {
  return {
    generateObject: () =>
      Promise.resolve({
        object: {
          citationRole: "substantive_attribution",
          rationale: "The sentence credits a measured result to the seed.",
        },
        record: {
          purpose: "citation-role-classification" as const,
          model: "fixture-haiku",
          attempted: true as const,
          successful: true,
          failed: false,
          billable: true,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          finishReason: "stop",
          timestamp: "2026-07-19T12:00:00.000Z",
          estimatedCostUsd: 0,
        },
      }),
    getLedger: () => {
      throw new Error("not used");
    },
  } as unknown as LLMClient;
}

function buildProductionPathAdapters(
  config: AppConfig,
  provenanceRoot: string,
): PipelineAdapters {
  return {
    session: {
      resolvedSeedsByDoi: new Map(),
      citingPapersByProviderId: new Map(),
    },
    discover: productionPathDiscoverAdapters(),
    scope: productionPathScopeAdapters(),
    prepare: buildPrepareAdapters({
      config,
      runConfig: analysisRunConfigSchema.parse({}),
      llmClient: roleClassifierLlmClient(),
      provenanceStore: createProvenanceStore(provenanceRoot),
    }),
    evidence: productionPathEvidenceAdapters(),
    adjudicate: productionPathAdjudicateAdapters(),
  };
}

describe("production-path DOI→Report E2E", () => {
  it("runs Discover→Report with real parser harvest and production Prepare", async () => {
    const root = mkdtempSync(join(tmpdir(), "production-e2e-"));
    tempRoots.push(root);
    const dbPath = join(root, "test.sqlite");
    const runsRoot = join(root, "data", "runs");
    mkdirSync(runsRoot, { recursive: true });
    const inputPath = join(root, "dois.json");
    writeFileSync(inputPath, JSON.stringify({ dois: [SEED_DOI] }), "utf8");
    const config: AppConfig = {
      nodeEnv: "test",
      databasePath: dbPath,
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

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const database = openDatabase(dbPath);
      runMigrations(database);
      const result = await runPipeline({
        args: {
          input: inputPath,
          runId: undefined,
          seedPdfPath: undefined,
          forceRefresh: false,
          stopAfterStage: undefined,
          discoverProbeBudget: undefined,
          discoverMinFamilies: undefined,
          discoverMaxFamilies: undefined,
          discoverMaxPreparedRecords: undefined,
          discoverFromYear: undefined,
          discoverToYear: undefined,
          discoverExtractionModel: undefined,
          discoverExtractionThinking: undefined,
          scopeGroundingModel: undefined,
          scopeGroundingThinking: undefined,
          evidenceRerankEnabled: false,
          evidenceRerankModel: undefined,
          evidenceRerankTopN: undefined,
          adjudicateModel: undefined,
          adjudicateThinking: undefined,
          rerunFromStage: undefined,
        },
        config,
        apiKey: undefined,
        database,
        adapters: buildProductionPathAdapters(config, join(root, "provenance")),
        now: () => new Date("2026-07-19T12:00:00.000Z"),
      });
      expect(result.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      const discover = loadArtifact(
        "discover",
        getRunStage(database, result.runId, "discover")!.primaryArtifactPath!,
      );
      const scope = loadArtifact(
        "scope",
        getRunStage(database, result.runId, "scope")!.primaryArtifactPath!,
      );
      const prepare = loadArtifact(
        "prepare",
        getRunStage(database, result.runId, "prepare")!.primaryArtifactPath!,
      );
      const evidence = loadArtifact(
        "evidence",
        getRunStage(database, result.runId, "evidence")!.primaryArtifactPath!,
      );
      const adjudicate = loadArtifact(
        "adjudicate",
        getRunStage(database, result.runId, "adjudicate")!.primaryArtifactPath!,
      );
      const report = loadArtifact(
        "report",
        getRunStage(database, result.runId, "report")!.primaryArtifactPath!,
      );

      expect(discover.payload.citationMentions).toHaveLength(2);
      expect(
        discover.payload.citationMentions.every((mention) =>
          mention.targetRefIds.includes("seed"),
        ),
      ).toBe(true);
      expect(
        discover.payload.citingPapers.some(
          (paper) =>
            paper.paper.paperId === "citing-paywalled" &&
            paper.materialization.status === "unavailable",
        ),
      ).toBe(true);
      expect(scope.payload.families.length).toBeGreaterThan(0);
      expect(prepare.payload.records.length).toBe(
        evidence.payload.records.length,
      );
      expect(adjudicate.payload.records.length).toBe(
        prepare.payload.records.length,
      );
      expect(
        report.payload.funnel.prepare.manualReviewRoleAmbiguous.metricId,
      ).toBe("prepare.manual_review_role_ambiguous");
      expect(report.payload.recordTraces.length).toBe(
        prepare.payload.records.length,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });
});
