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
import type { ArtifactReference } from "../../src/contract/lean-artifacts.js";
import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import type { LLMClient } from "../../src/integrations/llm-client.js";
import { createCanonicalProvenanceStore } from "../../src/pipeline/canonical-provenance-store.js";
import {
  CANONICAL_ADJUDICATE_PROMPT_ID,
  CANONICAL_ADJUDICATE_PROMPT_VERSION,
} from "../../src/adjudication/canonical-adjudicate-packet.js";
import { hashCanonicalAdjudicateRequest } from "../../src/contract/canonical-adjudicate.js";
import {
  buildCanonicalPrepareAdapters,
  mapFullTextAcquisitionFailure,
  selectSeedReferenceMentions,
} from "../../src/pipeline/canonical-production-adapters.js";
import {
  orchestrateCanonicalPipelineRun,
  type CanonicalExecutorAdapters,
} from "../../src/pipeline/canonical-executor.js";
import type { CanonicalDiscoverAdapters } from "../../src/pipeline/canonical-discover.js";
import type { CanonicalScopeAdapters } from "../../src/pipeline/canonical-scope.js";
import type { CanonicalEvidenceAdapters } from "../../src/pipeline/canonical-evidence.js";
import type { CanonicalAdjudicateAdapters } from "../../src/pipeline/canonical-adjudicate.js";
import { parseParsedPaperDocument } from "../../src/retrieval/parsed-paper.js";
import { getRunStage } from "../../src/storage/analysis-runs.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";
import { loadCanonicalArtifact } from "../../src/contract/selectors.js";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/pipeline/vrn-replay",
);
const SEED_DOI = "10.1000/jin.20210042";
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function artifactReference(role: string, key: string): ArtifactReference {
  return {
    artifactId: buildStableId("fixture", { role, key }),
    contentHash: canonicalSha256({ role, key }),
    role,
    uri: `fixture://${role}/${key}`,
  };
}

function externalExecution(provider: string, key: string) {
  return {
    provider,
    requestHash: canonicalSha256({ provider, key, direction: "request" }),
    requestArtifact: artifactReference("external-request", key),
    responseArtifact: artifactReference("external-response", key),
  };
}

function modelExecution(stage: string, key: string) {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model: "fixture-model",
    promptId: `${stage}-prompt`,
    promptVersion: "v1",
    promptContentHash: canonicalSha256({ stage, key }),
    requestHash: canonicalSha256({ stage, key, direction: "request" }),
    requestArtifact: artifactReference("model-request", `${stage}-${key}`),
    responseArtifact: artifactReference("model-response", `${stage}-${key}`),
  };
}

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
      seedRefLabel: "Belicova, 2020",
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

function productionPathDiscoverAdapters(): CanonicalDiscoverAdapters {
  return {
    resolveSeed: ({ doi }) =>
      Promise.resolve({
        status: "resolved",
        paper: {
          paperId: "vrn-seed",
          providerRecordId: "https://openalex.org/Wseed",
          title: "Visual experience and VRN circuit maturation",
          doi,
          authors: ["Belicova L"],
          publicationYear: 2020,
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
        claims: mention.rawContext.toLowerCase().includes("pvalb")
          ? [
              {
                text: "Pvalb+ fast-spiking interneurons increase gamma power after 40 Hz stimulation.",
                supportSpanText: "Pvalb+ fast-spiking",
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

function productionPathScopeAdapters(): CanonicalScopeAdapters {
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
            text: "Pvalb+ fast-spiking interneurons increase gamma power after 40 Hz stimulation in the visual pathway.",
            sectionTitle: "Results",
            blockKind: "body_paragraph" as const,
            charOffsetStart: 0,
            charOffsetEnd: 100,
          },
        ],
        execution: {
          kind: "external" as const,
          ...externalExecution("fixture-full-text", seed.seedId),
        },
      }),
    groundFamily: ({ family }) =>
      Promise.resolve({
        status: "completed",
        rawOutput: {
          status: "grounded",
          detailReason: "Results block supports the family claim.",
          supportSpans: [
            {
              verbatimQuote:
                "Pvalb+ fast-spiking interneurons increase gamma power after 40 Hz stimulation in the visual pathway.",
              blockId: "scope-block-results",
            },
          ],
        },
        execution: modelExecution("scope", family.familyId),
      }),
  };
}

function productionPathEvidenceAdapters(): CanonicalEvidenceAdapters {
  return {};
}

function productionPathAdjudicateAdapters(): CanonicalAdjudicateAdapters {
  return {
    adjudicate: (input) => {
      const requestHash = hashCanonicalAdjudicateRequest(input);
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
          citedChunkIds: input.packet.selectedChunks
            .slice(0, 1)
            .map((chunk) => chunk.chunkId),
        },
        execution: {
          ...base,
          promptId: CANONICAL_ADJUDICATE_PROMPT_ID,
          promptVersion: CANONICAL_ADJUDICATE_PROMPT_VERSION,
          promptContentHash: canonicalSha256(input.promptText),
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
          thinkingEnabled: false,
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
): CanonicalExecutorAdapters {
  return {
    session: {
      resolvedSeedsByDoi: new Map(),
      citingPapersByProviderId: new Map(),
    },
    discover: productionPathDiscoverAdapters(),
    scope: productionPathScopeAdapters(),
    prepare: buildCanonicalPrepareAdapters({
      config,
      runConfig: analysisRunConfigSchema.parse({}),
      llmClient: roleClassifierLlmClient(),
      provenanceStore: createCanonicalProvenanceStore(provenanceRoot),
    }),
    evidence: productionPathEvidenceAdapters(),
    adjudicate: productionPathAdjudicateAdapters(),
  };
}

describe("canonical production-path DOI→Report E2E", () => {
  it("runs Discover→Report with real parser harvest and production Prepare", async () => {
    const root = mkdtempSync(join(tmpdir(), "canonical-production-e2e-"));
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
      const result = await orchestrateCanonicalPipelineRun({
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

      const discover = loadCanonicalArtifact(
        "discover",
        getRunStage(database, result.runId, "discover")!.primaryArtifactPath!,
      );
      const scope = loadCanonicalArtifact(
        "scope",
        getRunStage(database, result.runId, "scope")!.primaryArtifactPath!,
      );
      const prepare = loadCanonicalArtifact(
        "prepare",
        getRunStage(database, result.runId, "prepare")!.primaryArtifactPath!,
      );
      const evidence = loadCanonicalArtifact(
        "evidence",
        getRunStage(database, result.runId, "evidence")!.primaryArtifactPath!,
      );
      const adjudicate = loadCanonicalArtifact(
        "adjudicate",
        getRunStage(database, result.runId, "adjudicate")!.primaryArtifactPath!,
      );
      const report = loadCanonicalArtifact(
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
