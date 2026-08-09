import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config/app-config.js";
import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import { stageDefinitions, stageKeyValues } from "../../src/contract/stages.js";
import { loadCanonicalDiscoverArtifact } from "../../src/pipeline/canonical-discover-artifact.js";
import { loadCanonicalScopeArtifact } from "../../src/pipeline/canonical-scope-artifact.js";
import { loadCanonicalPrepareArtifact } from "../../src/pipeline/canonical-prepare-artifact.js";
import { loadCanonicalEvidenceArtifact } from "../../src/pipeline/canonical-evidence-artifact.js";
import { loadCanonicalAdjudicateArtifact } from "../../src/pipeline/canonical-adjudicate-artifact.js";
import { loadCanonicalReportArtifact } from "../../src/pipeline/canonical-report-artifact.js";
import {
  CanonicalExecutorError,
  orchestrateCanonicalPipelineRun,
  type CanonicalExecutorAdapters,
} from "../../src/pipeline/canonical-executor.js";
import type { CanonicalDiscoverAdapters } from "../../src/pipeline/canonical-discover.js";
import type { CanonicalScopeAdapters } from "../../src/pipeline/canonical-scope.js";
import type { CanonicalPrepareAdapters } from "../../src/pipeline/canonical-prepare.js";
import type {
  CanonicalEvidenceAdapters,
  CanonicalEvidenceRerankerInput,
} from "../../src/pipeline/canonical-evidence.js";
import type { CanonicalAdjudicateAdapters } from "../../src/pipeline/canonical-adjudicate.js";
import { classifyPrepareOccurrenceDeterministically } from "../../src/pipeline/canonical-prepare.js";
import {
  getAnalysisRun,
  getRunStage,
  listRunStages,
  markDownstreamStagesStale,
  updateStageStatus,
} from "../../src/storage/analysis-runs.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";
import {
  buildStableId,
  canonicalSha256,
} from "../../src/shared/stable-identity.js";
import type { ArtifactReference } from "../../src/contract/lean-artifacts.js";
import { parseCanonicalPipelineArgs } from "../../src/cli/commands/pipeline.js";
import { hashCanonicalAdjudicateRequest } from "../../src/contract/canonical-adjudicate.js";
import {
  CANONICAL_ADJUDICATE_PROMPT_ID,
  CANONICAL_ADJUDICATE_PROMPT_VERSION,
} from "../../src/adjudication/canonical-adjudicate-packet.js";
import {
  artifactStemFromPrimaryPath,
  listStageArtifacts,
} from "../../src/contract/selectors.js";
import {
  getStageWorkflowDefinition,
  parseProgressEventLine,
} from "../../src/contract/workflow.js";

const TRACKED_CLAIM =
  "Rab35 silencing causes loss of apical bulkheads and cyst formation.";
const SOURCE_BLOCKS = [
  {
    blockId: "scope-block-abstract",
    text: "The abstract describes epithelial lumen organization and general polarity controls.",
    sectionTitle: "Abstract",
    blockKind: "abstract" as const,
  },
  {
    blockId: "scope-block-results",
    text: "Silencing Rab35 caused loss of apical bulkheads and cyst formation in hepatocytes. The resulting lumens lost their normal anisotropy.",
    sectionTitle: "Results",
    blockKind: "body_paragraph" as const,
  },
];

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
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

function modelExecution(
  purpose: "discover" | "scope" | "rerank" | "adjudicate",
  key: string,
  model = `fixture-${purpose}-model`,
) {
  return {
    kind: "model" as const,
    provider: "fixture-model-provider",
    model,
    promptId:
      purpose === "adjudicate"
        ? CANONICAL_ADJUDICATE_PROMPT_ID
        : `canonical-${purpose}-prompt`,
    promptVersion:
      purpose === "adjudicate" ? CANONICAL_ADJUDICATE_PROMPT_VERSION : "v1",
    promptContentHash: canonicalSha256({ purpose, prompt: "fixture" }),
    requestHash: canonicalSha256({
      purpose,
      key,
      model,
      direction: "request",
    }),
    requestArtifact: artifactReference(
      "model-request",
      `${purpose}-${key}-${model}`,
    ),
    responseArtifact: artifactReference(
      "model-response",
      `${purpose}-${key}-${model}`,
    ),
  };
}

function materializedBlocks() {
  let offset = 0;
  return SOURCE_BLOCKS.map((block) => {
    const charOffsetStart = offset;
    const charOffsetEnd = charOffsetStart + block.text.length;
    offset = charOffsetEnd + 2;
    return { ...block, charOffsetStart, charOffsetEnd };
  });
}

function fixtureDiscoverAdapters(): CanonicalDiscoverAdapters {
  return {
    resolveSeed: ({ doi }) =>
      Promise.resolve({
        status: "resolved",
        paper: {
          paperId: "seed-paper",
          providerRecordId: "provider-seed-paper",
          title: "Seed report paper",
          doi,
          authors: ["Seed Author"],
          publicationYear: 2020,
        },
        execution: externalExecution("fixture-resolver", "seed"),
      }),
    retrieveCitingNeighborhood: () =>
      Promise.resolve({
        status: "completed",
        providerReportedTotal: 1,
        coverage: "complete",
        papers: [
          {
            providerRecordId: "provider-citing-paper",
            paperId: "citing-paper",
            title: "Citing paper",
            doi: "10.2000/citing-paper",
            authors: ["Citing Author"],
            publicationYear: 2025,
            fullTextAvailability: "available",
            provenanceArtifacts: [
              artifactReference("provider-paper", "citing-paper"),
            ],
          },
        ],
        execution: externalExecution("fixture-citation-index", "neighborhood"),
      }),
    harvestMentions: () =>
      Promise.resolve({
        materialization: {
          status: "succeeded",
          reason: "Fixture citing text materialized.",
          provenanceArtifacts: [
            artifactReference("raw-citing-paper", "citing-paper"),
          ],
        },
        harvest: {
          status: "succeeded",
          reason: "One occurrence harvested.",
          provenanceArtifacts: [
            artifactReference("mention-harvest", "citing-paper"),
          ],
        },
        mentions: [
          {
            mentionIndex: 0,
            refId: "seed-ref",
            charOffsetStart: 100,
            charOffsetEnd: 158,
            citationMarker: "[3]",
            rawContext: "The reported phenotype followed Rab35 depletion [3].",
            sectionTitle: "Results",
            seedRefLabel: "Seed Author, 2020",
            isBundledCitation: false,
            bundleSize: 1,
            bundleRefIds: ["seed-ref"],
            bundlePattern: "single",
            sourceType: "jats_xml",
            parser: "fixture-parser",
            parserVersion: "1.0.0",
            provenanceArtifacts: [
              artifactReference("occurrence-source", "occurrence-0"),
            ],
          },
        ],
      }),
    extractAttributedClaims: () =>
      Promise.resolve({
        status: "completed",
        reason: "Fixture attributed claim extracted.",
        claims: [
          {
            text: TRACKED_CLAIM,
            supportSpanText: "reported phenotype",
            confidence: "high",
          },
        ],
        execution: modelExecution("discover", "occurrence-0"),
      }),
  };
}

function fixtureScopeAdapters(): CanonicalScopeAdapters {
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
        blocks: materializedBlocks(),
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
          detailReason: "The Results block directly reports the claim.",
          supportSpans: [
            {
              verbatimQuote:
                "Silencing Rab35 caused loss of apical bulkheads and cyst formation in hepatocytes.",
              blockId: "scope-block-results",
            },
          ],
        },
        execution: {
          ...modelExecution("scope", family.familyId),
        },
      }),
  };
}

function fixturePrepareAdapters(): CanonicalPrepareAdapters {
  return {
    classifyCitation: ({ citationOccurrence }) =>
      Promise.resolve(
        classifyPrepareOccurrenceDeterministically(citationOccurrence),
      ),
  };
}

function fixtureEvidenceAdapters(
  mode: "disabled" | "enabled" | "fail" = "disabled",
): CanonicalEvidenceAdapters {
  if (mode === "disabled") return {};
  return {
    rerank: (input: CanonicalEvidenceRerankerInput) => {
      const execution = {
        ...modelExecution("rerank", input.familyId),
      };
      if (mode === "fail") {
        return Promise.resolve({
          status: "failed",
          reasonCode: "timeout",
          reason: "Fixture rerank timeout.",
          execution,
        });
      }
      const results = input.candidates.slice(0, input.topN).map((c, index) => ({
        chunkId: c.chunkId,
        relevanceScore: 90 - index,
        rank: index + 1,
        rationale: "Fixture relevance.",
      }));
      return Promise.resolve({
        status: "completed",
        rawOutput: { results },
        execution,
      });
    },
  };
}

function fixtureAdjudicateAdapters(
  mode: "model" | "absent" = "model",
): CanonicalAdjudicateAdapters {
  if (mode === "absent") return {};
  return {
    adjudicate: (input) => {
      const requestHash = hashCanonicalAdjudicateRequest(input);
      const base = modelExecution("adjudicate", input.recordId);
      const claimIds = input.packet.occurrenceClaims.map(
        (c) => c.claimRecordId,
      );
      const chunkIds = input.packet.selectedChunks.map((c) => c.chunkId);
      return Promise.resolve({
        status: "completed",
        rawOutput: {
          comparison: "Citing claim matches seed result.",
          verdict: "F",
          rationale: "Exact phenotype match in selected chunks.",
          confidence: "high",
          evaluatedClaimRecordIds: claimIds,
          citedChunkIds: chunkIds.slice(0, 1),
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

function buildFixtureAdapters(options?: {
  evidence?: "disabled" | "enabled" | "fail";
  adjudicate?: "model" | "absent";
}): CanonicalExecutorAdapters {
  return {
    session: {
      resolvedSeedsByDoi: new Map(),
      citingPapersByProviderId: new Map(),
    },
    discover: fixtureDiscoverAdapters(),
    scope: fixtureScopeAdapters(),
    prepare: fixturePrepareAdapters(),
    evidence: fixtureEvidenceAdapters(options?.evidence ?? "disabled"),
    adjudicate: fixtureAdjudicateAdapters(options?.adjudicate ?? "model"),
  };
}

function createTempWorkspace(
  seedDois: [string, ...string[]] = ["10.1000/executor-seed"],
): {
  root: string;
  dbPath: string;
  runsRoot: string;
  inputPath: string;
  config: AppConfig;
} {
  const root = mkdtempSync(join(tmpdir(), "canonical-executor-"));
  tempRoots.push(root);
  const dbPath = join(root, "test.sqlite");
  const runsRoot = join(root, "data", "runs");
  mkdirSync(runsRoot, { recursive: true });
  const inputPath = join(root, "dois.json");
  writeFileSync(inputPath, JSON.stringify({ dois: seedDois }, null, 2), "utf8");
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
  return { root, dbPath, runsRoot, inputPath, config };
}

async function runFresh(options?: {
  stopAfterStage?: (typeof stageKeyValues)[number];
  evidence?: "disabled" | "enabled" | "fail";
  adjudicate?: "model" | "absent";
  forceRefresh?: boolean;
  cwd?: string;
  seedDois?: [string, ...string[]];
}) {
  const workspace = createTempWorkspace(options?.seedDois);
  const previousCwd = process.cwd();
  const cwd = options?.cwd ?? workspace.root;
  process.chdir(cwd);
  try {
    // Ensure data/runs exists relative to cwd for executor path resolution.
    mkdirSync(resolve(cwd, "data", "runs"), { recursive: true });
    if (cwd !== workspace.root) {
      writeFileSync(
        resolve(cwd, "dois.json"),
        JSON.stringify(
          { dois: options?.seedDois ?? ["10.1000/executor-seed"] },
          null,
          2,
        ),
        "utf8",
      );
    }
    const database = openDatabase(workspace.dbPath);
    runMigrations(database);
    const adapters = buildFixtureAdapters({
      ...(options?.evidence != null ? { evidence: options.evidence } : {}),
      ...(options?.adjudicate != null
        ? { adjudicate: options.adjudicate }
        : {}),
    });
    const result = await orchestrateCanonicalPipelineRun({
      args: {
        input:
          cwd === workspace.root
            ? workspace.inputPath
            : resolve(cwd, "dois.json"),
        runId: undefined,
        seedPdfPath: undefined,
        forceRefresh: options?.forceRefresh ?? false,
        stopAfterStage: options?.stopAfterStage,
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
        evidenceRerankEnabled:
          options?.evidence === "enabled" || options?.evidence === "fail",
        evidenceRerankModel: undefined,
        evidenceRerankTopN: undefined,
        adjudicateModel: undefined,
        adjudicateThinking: undefined,
        rerunFromStage: undefined,
      },
      config: workspace.config,
      apiKey: undefined,
      database,
      adapters,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    return { ...workspace, database, result, adapters };
  } finally {
    process.chdir(previousCwd);
  }
}

describe("canonical executor cutover", () => {
  it("runs all six stages with write/reload boundaries and exact directories", async () => {
    const { database, result } = await runFresh();
    const run = getAnalysisRun(database, result.runId)!;
    expect(run.status).toBe("succeeded");
    expect(run.targetStage).toBe("report");

    const stages = listRunStages(database, result.runId);
    expect(stages).toHaveLength(6);
    expect(stages.map((s) => s.stageKey)).toEqual([...stageKeyValues]);
    expect(stages.every((s) => s.status === "succeeded")).toBe(true);

    for (const definition of stageDefinitions) {
      const stage = getRunStage(database, result.runId, definition.key)!;
      expect(stage.primaryArtifactPath).toBeTruthy();
      expect(existsSync(stage.primaryArtifactPath!)).toBe(true);
      expect(stage.primaryArtifactPath!).toContain(definition.directoryName);
      expect(stage.primaryArtifactPath!).toMatch(
        new RegExp(
          `${definition.artifactGlobs.primarySuffix.replace(".", "\\.")}$`,
        ),
      );
      expect(stage.manifestPath).toBeTruthy();
      expect(existsSync(stage.manifestPath!)).toBe(true);
      expect(
        listStageArtifacts(
          definition.key,
          resolve(result.runRoot, definition.directoryName),
        ).primaryArtifactPath,
      ).toBe(stage.primaryArtifactPath);
    }

    const report = getRunStage(database, result.runId, "report")!;
    expect(report.reportArtifactPath).toBeTruthy();
    expect(existsSync(report.reportArtifactPath!)).toBe(true);
    expect(
      artifactStemFromPrimaryPath(report.primaryArtifactPath!, "report"),
    ).toBe(
      report.reportArtifactPath!.slice(
        report.reportArtifactPath!.lastIndexOf("/") + 1,
        -"_canonical-report.md".length,
      ),
    );

    const discover = loadCanonicalDiscoverArtifact(
      getRunStage(database, result.runId, "discover")!.primaryArtifactPath!,
    );
    const scope = loadCanonicalScopeArtifact(
      getRunStage(database, result.runId, "scope")!.primaryArtifactPath!,
    );
    const prepare = loadCanonicalPrepareArtifact(
      getRunStage(database, result.runId, "prepare")!.primaryArtifactPath!,
    );
    const evidence = loadCanonicalEvidenceArtifact(
      getRunStage(database, result.runId, "evidence")!.primaryArtifactPath!,
    );
    const adjudicate = loadCanonicalAdjudicateArtifact(
      getRunStage(database, result.runId, "adjudicate")!.primaryArtifactPath!,
    );
    const reportArtifact = loadCanonicalReportArtifact(
      report.primaryArtifactPath!,
    );

    expect(scope.payload.discoverArtifact.artifactId).toBe(discover.artifactId);
    expect(scope.payload.discoverArtifact.uri).toBeUndefined();
    expect(prepare.payload.lineage.scopeArtifact.artifactId).toBe(
      scope.artifactId,
    );
    expect(prepare.payload.lineage.scopeArtifact.uri).toBeUndefined();
    expect(evidence.payload.lineage.prepareArtifact.artifactId).toBe(
      prepare.artifactId,
    );
    expect(evidence.payload.lineage.prepareArtifact.uri).toBeUndefined();
    expect(adjudicate.payload.lineage.evidenceArtifact.artifactId).toBe(
      evidence.artifactId,
    );
    expect(adjudicate.payload.lineage.evidenceArtifact.uri).toBeUndefined();
    expect(reportArtifact.payload.lineage.adjudicateArtifact.artifactId).toBe(
      adjudicate.artifactId,
    );
    for (const artifact of [
      discover,
      scope,
      prepare,
      evidence,
      adjudicate,
      reportArtifact,
    ]) {
      expect(artifact.provenance.configuration?.sourceArtifact?.role).toBe(
        "canonical-run-config",
      );
    }

    const markdown = readFileSync(report.reportArtifactPath!, "utf8");
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).toContain(
      reportArtifact.payload.lineage.discoverArtifact.artifactId,
    );
    expect(reportArtifact.payload.funnel).toBeTruthy();
    for (const stage of stages) {
      const events = readFileSync(stage.logPath!, "utf8")
        .split("\n")
        .map(parseProgressEventLine)
        .filter((event) => event?.stage === stage.stageKey);
      expect(events.some((event) => event?.status === "running")).toBe(true);
      expect(events.some((event) => event?.status === "completed")).toBe(true);
      expect(
        new Set(
          events
            .filter((event) => event?.status === "completed")
            .map((event) => event!.step),
        ),
      ).toEqual(
        new Set(
          getStageWorkflowDefinition(stage.stageKey).steps.map(
            (step) => step.id,
          ),
        ),
      );
    }
    database.close();
  });

  it("resumes after each of the first five stages with identical semantic IDs", async () => {
    const stopPoints = [
      "discover",
      "scope",
      "prepare",
      "evidence",
      "adjudicate",
    ] as const;

    for (const stopAfter of stopPoints) {
      const partial = await runFresh({ stopAfterStage: stopAfter });
      const partialStage = getRunStage(
        partial.database,
        partial.result.runId,
        stopAfter,
      )!;
      const partialArtifactId = loadByStage(
        stopAfter,
        partialStage.primaryArtifactPath!,
      ).artifactId;
      const partialContentHash = loadByStage(
        stopAfter,
        partialStage.primaryArtifactPath!,
      ).contentHash;

      const previousCwd = process.cwd();
      process.chdir(partial.root);
      try {
        await orchestrateCanonicalPipelineRun({
          args: {
            input: undefined,
            runId: partial.result.runId,
            seedPdfPath: undefined,
            forceRefresh: false,
            stopAfterStage: "report",
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
          config: partial.config,
          apiKey: undefined,
          database: partial.database,
          adapters: buildFixtureAdapters(),
          now: () => new Date("2026-07-17T13:00:00.000Z"),
        });
      } finally {
        process.chdir(previousCwd);
      }

      const resumedStage = getRunStage(
        partial.database,
        partial.result.runId,
        stopAfter,
      )!;
      const resumed = loadByStage(stopAfter, resumedStage.primaryArtifactPath!);
      expect(resumed.artifactId).toBe(partialArtifactId);
      expect(resumed.contentHash).toBe(partialContentHash);
      expect(
        getAnalysisRun(partial.database, partial.result.runId)?.status,
      ).toBe("succeeded");
      expect(
        listRunStages(partial.database, partial.result.runId).every(
          (s) => s.status === "succeeded",
        ),
      ).toBe(true);
      partial.database.close();
    }
  });

  it("preserves every fresh DOI and reloads all seeds on resume", async () => {
    const seedDois: [string, ...string[]] = [
      "10.1000/executor-seed",
      "10.1000/executor-second",
    ];
    const partial = await runFresh({
      stopAfterStage: "discover",
      seedDois,
    });
    const persisted = JSON.parse(
      readFileSync(
        resolve(partial.result.runRoot, "inputs", "dois.json"),
        "utf8",
      ),
    ) as { dois: string[] };
    expect(persisted.dois).toEqual(seedDois);
    const discoverPath = getRunStage(
      partial.database,
      partial.result.runId,
      "discover",
    )!.primaryArtifactPath!;
    expect(
      loadCanonicalDiscoverArtifact(discoverPath).payload.seeds.map(
        (seed) => seed.doi,
      ),
    ).toEqual(seedDois);

    const previousCwd = process.cwd();
    process.chdir(partial.root);
    try {
      await orchestrateCanonicalPipelineRun({
        args: {
          input: undefined,
          runId: partial.result.runId,
          seedPdfPath: undefined,
          forceRefresh: undefined,
          stopAfterStage: "scope",
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
          evidenceRerankEnabled: undefined,
          evidenceRerankModel: undefined,
          evidenceRerankTopN: undefined,
          adjudicateModel: undefined,
          adjudicateThinking: undefined,
          rerunFromStage: undefined,
        },
        config: partial.config,
        apiKey: undefined,
        database: partial.database,
        adapters: buildFixtureAdapters(),
      });
    } finally {
      process.chdir(previousCwd);
    }
    expect(
      loadCanonicalDiscoverArtifact(discoverPath).payload.seeds.map(
        (seed) => seed.doi,
      ),
    ).toEqual(seedDois);
    expect(
      loadCanonicalScopeArtifact(
        getRunStage(partial.database, partial.result.runId, "scope")!
          .primaryArtifactPath!,
      ).payload.seedMaterializations,
    ).toHaveLength(2);
    partial.database.close();
  });

  it("persists resume target and future-stage config overrides for later reads", async () => {
    const partial = await runFresh({ stopAfterStage: "discover" });
    const discover = loadCanonicalDiscoverArtifact(
      getRunStage(partial.database, partial.result.runId, "discover")!
        .primaryArtifactPath!,
    );
    const originalConfigRef =
      discover.provenance.configuration!.sourceArtifact!;
    const previousCwd = process.cwd();
    process.chdir(partial.root);
    try {
      await orchestrateCanonicalPipelineRun({
        args: {
          input: undefined,
          runId: partial.result.runId,
          seedPdfPath: undefined,
          forceRefresh: undefined,
          stopAfterStage: "evidence",
          discoverProbeBudget: undefined,
          discoverMinFamilies: undefined,
          discoverMaxFamilies: undefined,
          discoverMaxPreparedRecords: undefined,
          discoverFromYear: undefined,
          discoverToYear: undefined,
          discoverExtractionModel: undefined,
          discoverExtractionThinking: undefined,
          scopeGroundingModel: "fixture-grounding-override",
          scopeGroundingThinking: false,
          evidenceRerankEnabled: true,
          evidenceRerankModel: "fixture-reranker-override",
          evidenceRerankTopN: 3,
          adjudicateModel: undefined,
          adjudicateThinking: undefined,
          rerunFromStage: undefined,
        },
        config: partial.config,
        apiKey: undefined,
        database: partial.database,
        adapters: buildFixtureAdapters({ evidence: "enabled" }),
      });
    } finally {
      process.chdir(previousCwd);
    }

    const stored = getAnalysisRun(partial.database, partial.result.runId)!;
    expect(stored.targetStage).toBe("evidence");
    expect(stored.config.stopAfterStage).toBe("evidence");
    expect(stored.config.scope.groundingModel).toBe(
      "fixture-grounding-override",
    );
    expect(stored.config.evidence).toMatchObject({
      rerankEnabled: true,
      rerankModel: "fixture-reranker-override",
      rerankTopN: 3,
    });
    const evidence = loadCanonicalEvidenceArtifact(
      getRunStage(partial.database, partial.result.runId, "evidence")!
        .primaryArtifactPath!,
    );
    const updatedConfigRef = evidence.provenance.configuration!.sourceArtifact!;
    expect(updatedConfigRef.artifactId).not.toBe(originalConfigRef.artifactId);
    expect(
      existsSync(
        resolve(
          partial.result.runRoot,
          "provenance",
          `${originalConfigRef.artifactId}.json`,
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          partial.result.runRoot,
          "provenance",
          `${updatedConfigRef.artifactId}.json`,
        ),
      ),
    ).toBe(true);
    process.chdir(partial.root);
    try {
      await orchestrateCanonicalPipelineRun({
        args: {
          input: undefined,
          runId: partial.result.runId,
          seedPdfPath: undefined,
          forceRefresh: undefined,
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
          evidenceRerankEnabled: undefined,
          evidenceRerankModel: undefined,
          evidenceRerankTopN: undefined,
          adjudicateModel: undefined,
          adjudicateThinking: undefined,
          rerunFromStage: undefined,
        },
        config: partial.config,
        apiKey: undefined,
        database: partial.database,
      });
    } finally {
      process.chdir(previousCwd);
    }
    expect(
      getAnalysisRun(partial.database, partial.result.runId),
    ).toMatchObject({
      targetStage: "evidence",
      config: {
        stopAfterStage: "evidence",
        scope: { groundingModel: "fixture-grounding-override" },
      },
    });
    partial.database.close();
  });

  it("rejects scientific config changes on succeeded stages without --rerun-from", async () => {
    const partial = await runFresh({ stopAfterStage: "discover" });
    const previousCwd = process.cwd();
    process.chdir(partial.root);
    try {
      await expect(
        orchestrateCanonicalPipelineRun({
          args: {
            input: undefined,
            runId: partial.result.runId,
            seedPdfPath: undefined,
            forceRefresh: true,
            stopAfterStage: "evidence",
            discoverProbeBudget: 17,
            discoverMinFamilies: undefined,
            discoverMaxFamilies: undefined,
            discoverMaxPreparedRecords: undefined,
            discoverFromYear: undefined,
            discoverToYear: undefined,
            discoverExtractionModel: undefined,
            discoverExtractionThinking: undefined,
            scopeGroundingModel: undefined,
            scopeGroundingThinking: undefined,
            evidenceRerankEnabled: undefined,
            evidenceRerankModel: undefined,
            evidenceRerankTopN: undefined,
            adjudicateModel: undefined,
            adjudicateThinking: undefined,
            rerunFromStage: undefined,
          },
          config: partial.config,
          apiKey: undefined,
          database: partial.database,
          adapters: buildFixtureAdapters(),
        }),
      ).rejects.toThrow(/rerun-from discover/i);
    } finally {
      process.chdir(previousCwd);
      partial.database.close();
    }
  });

  it("rejects shrinking an existing run target", async () => {
    const partial = await runFresh({ stopAfterStage: "evidence" });
    const previousCwd = process.cwd();
    process.chdir(partial.root);
    try {
      await expect(
        orchestrateCanonicalPipelineRun({
          args: {
            input: undefined,
            runId: partial.result.runId,
            seedPdfPath: undefined,
            forceRefresh: undefined,
            stopAfterStage: "discover",
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
            evidenceRerankEnabled: undefined,
            evidenceRerankModel: undefined,
            evidenceRerankTopN: undefined,
            adjudicateModel: undefined,
            adjudicateThinking: undefined,
            rerunFromStage: undefined,
          },
          config: partial.config,
          apiKey: undefined,
          database: partial.database,
        }),
      ).rejects.toThrow(/shrink/i);
    } finally {
      process.chdir(previousCwd);
      partial.database.close();
    }
  });

  it("allows scientific config changes when --rerun-from covers the conflict", async () => {
    const partial = await runFresh({ stopAfterStage: "discover" });
    const previousCwd = process.cwd();
    process.chdir(partial.root);
    try {
      await orchestrateCanonicalPipelineRun({
        args: {
          input: undefined,
          runId: partial.result.runId,
          seedPdfPath: undefined,
          forceRefresh: true,
          stopAfterStage: "scope",
          discoverProbeBudget: 17,
          discoverMinFamilies: undefined,
          discoverMaxFamilies: undefined,
          discoverMaxPreparedRecords: undefined,
          discoverFromYear: undefined,
          discoverToYear: undefined,
          discoverExtractionModel: undefined,
          discoverExtractionThinking: undefined,
          scopeGroundingModel: undefined,
          scopeGroundingThinking: undefined,
          evidenceRerankEnabled: undefined,
          evidenceRerankModel: undefined,
          evidenceRerankTopN: undefined,
          adjudicateModel: undefined,
          adjudicateThinking: undefined,
          rerunFromStage: "discover",
        },
        config: partial.config,
        apiKey: undefined,
        database: partial.database,
        adapters: buildFixtureAdapters(),
      });
    } finally {
      process.chdir(previousCwd);
    }
    const stored = getAnalysisRun(partial.database, partial.result.runId)!;
    expect(stored.config.forceRefresh).toBe(true);
    expect(stored.config.discover.probeBudget).toBe(17);
    expect(
      getRunStage(partial.database, partial.result.runId, "discover")?.status,
    ).toBe("succeeded");
    expect(
      getRunStage(partial.database, partial.result.runId, "scope")?.status,
    ).toBe("succeeded");
    partial.database.close();
  });

  it("rejects seed PDFs for multi-DOI input and invalid rerun ranges", async () => {
    const workspace = createTempWorkspace([
      "10.1000/executor-seed",
      "10.1000/executor-second",
    ]);
    const database = openDatabase(workspace.dbPath);
    runMigrations(database);
    const previousCwd = process.cwd();
    process.chdir(workspace.root);
    try {
      await expect(
        orchestrateCanonicalPipelineRun({
          args: {
            input: workspace.inputPath,
            runId: undefined,
            seedPdfPath: "/tmp/one-seed.pdf",
            forceRefresh: undefined,
            stopAfterStage: "scope",
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
            evidenceRerankEnabled: undefined,
            evidenceRerankModel: undefined,
            evidenceRerankTopN: undefined,
            adjudicateModel: undefined,
            adjudicateThinking: undefined,
            rerunFromStage: undefined,
          },
          config: workspace.config,
          apiKey: undefined,
          database,
          adapters: buildFixtureAdapters(),
        }),
      ).rejects.toThrow(/single|multiple/i);
    } finally {
      process.chdir(previousCwd);
      database.close();
    }
    expect(() =>
      parseCanonicalPipelineArgs([
        "--input",
        "dois.json",
        "--rerun-from",
        "scope",
      ]),
    ).toThrow(/run-id/i);
    expect(() =>
      parseCanonicalPipelineArgs([
        "--run-id",
        "run",
        "--rerun-from",
        "report",
        "--stop-after",
        "scope",
      ]),
    ).toThrow(/later/i);
  });

  it("fails resume on corrupt succeeded artifact without recomputation", async () => {
    const { database, result } = await runFresh({ stopAfterStage: "discover" });
    const discoverStage = getRunStage(database, result.runId, "discover")!;
    const path = discoverStage.primaryArtifactPath!;
    const original = readFileSync(path, "utf8");
    writeFileSync(
      path,
      original
        .replace('"discover"', '"discover"')
        .replace(
          /"contentHash": "[a-f0-9]{64}"/,
          `"contentHash": "${"a".repeat(64)}"`,
        ),
    );

    const previousCwd = process.cwd();
    process.chdir(
      result.runRoot.replace(/\/[^/]+$/, "/..").includes("runs")
        ? resolve(result.runRoot, "../..")
        : process.cwd(),
    );
    // Use the temp workspace root stored beside runs.
    const workspaceRoot = resolve(result.runRoot, "../..");
    process.chdir(workspaceRoot);
    await expect(
      orchestrateCanonicalPipelineRun({
        args: {
          input: undefined,
          runId: result.runId,
          seedPdfPath: undefined,
          forceRefresh: false,
          stopAfterStage: "scope",
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
        config: {
          nodeEnv: "test",
          databasePath: join(workspaceRoot, "test.sqlite"),
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
        },
        apiKey: undefined,
        database,
        adapters: buildFixtureAdapters(),
      }),
    ).rejects.toThrow();
    process.chdir(previousCwd);

    // Scope must not have been written.
    expect(getRunStage(database, result.runId, "scope")?.status).not.toBe(
      "succeeded",
    );
    database.close();
  });

  it("rejects a succeeded Report pointer with wrong run lineage", async () => {
    const first = await runFresh();
    const second = await runFresh();
    const wrongReport = getRunStage(
      second.database,
      second.result.runId,
      "report",
    )!;
    updateStageStatus(
      first.database,
      first.result.runId,
      "report",
      "succeeded",
      {
        primaryArtifactPath: wrongReport.primaryArtifactPath!,
        reportArtifactPath: wrongReport.reportArtifactPath!,
        manifestPath: wrongReport.manifestPath!,
        finishedAt: "2026-07-17T15:00:00.000Z",
        exitCode: 0,
      },
    );

    const previousCwd = process.cwd();
    process.chdir(first.root);
    try {
      await expect(
        orchestrateCanonicalPipelineRun({
          args: {
            input: undefined,
            runId: first.result.runId,
            seedPdfPath: undefined,
            forceRefresh: undefined,
            stopAfterStage: "report",
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
            evidenceRerankEnabled: undefined,
            evidenceRerankModel: undefined,
            evidenceRerankTopN: undefined,
            adjudicateModel: undefined,
            adjudicateThinking: undefined,
            rerunFromStage: undefined,
          },
          config: first.config,
          apiKey: undefined,
          database: first.database,
        }),
      ).rejects.toThrow(/Report artifact lineage mismatch|runId/i);
    } finally {
      process.chdir(previousCwd);
      first.database.close();
      second.database.close();
    }
  });

  it("rejects a stale Report after an ancestor rerun", async () => {
    const completed = await runFresh();
    const oldReport = getRunStage(
      completed.database,
      completed.result.runId,
      "report",
    )!;
    const oldReportPointers = {
      primaryArtifactPath: oldReport.primaryArtifactPath!,
      reportArtifactPath: oldReport.reportArtifactPath!,
      manifestPath: oldReport.manifestPath!,
    };
    const previousCwd = process.cwd();
    process.chdir(completed.root);
    try {
      // Change adjudicate scientific config under --rerun-from so lineage IDs move.
      // Keep target at report (no shrink); a fresh Report is written, then we plant
      // the pre-rerun Report pointer to assert resume refuses silent acceptance.
      await orchestrateCanonicalPipelineRun({
        args: {
          input: undefined,
          runId: completed.result.runId,
          seedPdfPath: undefined,
          forceRefresh: undefined,
          stopAfterStage: "report",
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
          evidenceRerankEnabled: undefined,
          evidenceRerankModel: undefined,
          evidenceRerankTopN: undefined,
          adjudicateModel: "fixture-adjudicator-rerun",
          adjudicateThinking: undefined,
          rerunFromStage: "adjudicate",
        },
        config: completed.config,
        apiKey: undefined,
        database: completed.database,
        adapters: buildFixtureAdapters(),
      });
      expect(
        getRunStage(completed.database, completed.result.runId, "report")
          ?.primaryArtifactPath,
      ).not.toBe(oldReportPointers.primaryArtifactPath);
      updateStageStatus(
        completed.database,
        completed.result.runId,
        "report",
        "succeeded",
        {
          ...oldReportPointers,
          finishedAt: "2026-07-17T16:00:00.000Z",
          exitCode: 0,
        },
      );
      await expect(
        orchestrateCanonicalPipelineRun({
          args: {
            input: undefined,
            runId: completed.result.runId,
            seedPdfPath: undefined,
            forceRefresh: undefined,
            stopAfterStage: "report",
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
            evidenceRerankEnabled: undefined,
            evidenceRerankModel: undefined,
            evidenceRerankTopN: undefined,
            adjudicateModel: undefined,
            adjudicateThinking: undefined,
            rerunFromStage: undefined,
          },
          config: completed.config,
          apiKey: undefined,
          database: completed.database,
          adapters: buildFixtureAdapters(),
        }),
      ).rejects.toThrow(/Report artifact lineage mismatch/i);
    } finally {
      process.chdir(previousCwd);
      completed.database.close();
    }
  });

  it("allows a report-only resume without an Anthropic key", async () => {
    const partial = await runFresh({ stopAfterStage: "adjudicate" });
    const previousCwd = process.cwd();
    process.chdir(partial.root);
    try {
      await orchestrateCanonicalPipelineRun({
        args: {
          input: undefined,
          runId: partial.result.runId,
          seedPdfPath: undefined,
          forceRefresh: undefined,
          stopAfterStage: "report",
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
          evidenceRerankEnabled: undefined,
          evidenceRerankModel: undefined,
          evidenceRerankTopN: undefined,
          adjudicateModel: undefined,
          adjudicateThinking: undefined,
          rerunFromStage: undefined,
        },
        config: partial.config,
        apiKey: undefined,
        database: partial.database,
      });
    } finally {
      process.chdir(previousCwd);
    }
    expect(
      getRunStage(partial.database, partial.result.runId, "report")?.status,
    ).toBe("succeeded");
    partial.database.close();
  });

  it("explicit rerun invalidates downstream and preserves prior artifact files", async () => {
    const { database, result } = await runFresh();
    const prepareBefore = getRunStage(database, result.runId, "prepare")!;
    const oldPreparePath = prepareBefore.primaryArtifactPath!;
    const oldPrepareArtifact = loadCanonicalPrepareArtifact(oldPreparePath);
    const evidenceBefore = getRunStage(database, result.runId, "evidence")!;
    const oldEvidencePath = evidenceBefore.primaryArtifactPath!;
    const reportBefore = getRunStage(database, result.runId, "report")!;
    const oldReportPath = reportBefore.primaryArtifactPath!;
    const oldReportArtifact = loadCanonicalReportArtifact(oldReportPath);
    expect(existsSync(oldPreparePath)).toBe(true);
    expect(existsSync(oldEvidencePath)).toBe(true);
    expect(existsSync(oldReportPath)).toBe(true);

    markDownstreamStagesStale(database, result.runId, "prepare");
    expect(getRunStage(database, result.runId, "prepare")?.status).toBe(
      "not_started",
    );
    expect(getRunStage(database, result.runId, "evidence")?.status).toBe(
      "stale",
    );
    expect(existsSync(oldPreparePath)).toBe(true);
    expect(existsSync(oldEvidencePath)).toBe(true);

    const previousCwd = process.cwd();
    const workspaceRoot = resolve(result.runRoot, "../..");
    process.chdir(workspaceRoot);
    await orchestrateCanonicalPipelineRun({
      args: {
        input: undefined,
        runId: result.runId,
        seedPdfPath: undefined,
        forceRefresh: false,
        stopAfterStage: "report",
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
        rerunFromStage: "prepare",
      },
      config: {
        nodeEnv: "test",
        databasePath: join(workspaceRoot, "test.sqlite"),
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
      },
      apiKey: undefined,
      database,
      adapters: buildFixtureAdapters(),
      now: () => new Date("2026-07-17T14:00:00.000Z"),
    });
    process.chdir(previousCwd);

    const prepareAfter = getRunStage(database, result.runId, "prepare")!;
    expect(prepareAfter.status).toBe("succeeded");
    expect(prepareAfter.primaryArtifactPath).toBeTruthy();
    expect(prepareAfter.primaryArtifactPath).not.toBe(oldPreparePath);
    expect(
      loadCanonicalPrepareArtifact(prepareAfter.primaryArtifactPath!)
        .artifactId,
    ).toBe(oldPrepareArtifact.artifactId);
    expect(
      listStageArtifacts("prepare", resolve(result.runRoot, "02-prepare"))
        .primaryArtifactPath,
    ).toBe(prepareAfter.primaryArtifactPath);
    const reportAfter = getRunStage(database, result.runId, "report")!;
    expect(reportAfter.primaryArtifactPath).not.toBe(oldReportPath);
    expect(
      loadCanonicalReportArtifact(reportAfter.primaryArtifactPath!).artifactId,
    ).toBe(oldReportArtifact.artifactId);
    // Old files remain on disk (append-only).
    expect(existsSync(oldPreparePath)).toBe(true);
    expect(existsSync(oldEvidencePath)).toBe(true);
    expect(existsSync(oldReportPath)).toBe(true);
    database.close();
  });

  it("blocks downstream on fatal discover failure", async () => {
    const workspace = createTempWorkspace();
    const previousCwd = process.cwd();
    process.chdir(workspace.root);
    const database = openDatabase(workspace.dbPath);
    runMigrations(database);
    const adapters = buildFixtureAdapters();
    adapters.discover.resolveSeed = () =>
      Promise.resolve({
        status: "failed",
        reasonCode: "authentication",
        reason: "Fixture auth failure.",
        execution: externalExecution("fixture-resolver", "fatal"),
      });

    await expect(
      orchestrateCanonicalPipelineRun({
        args: {
          input: workspace.inputPath,
          runId: undefined,
          seedPdfPath: undefined,
          forceRefresh: false,
          stopAfterStage: "report",
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
        config: workspace.config,
        apiKey: undefined,
        database,
        adapters,
      }),
    ).rejects.toThrow();

    const runs = listRunStages(database, getOnlyRunId(database));
    const discover = runs.find((s) => s.stageKey === "discover")!;
    expect(discover.status).toBe("failed");
    expect(
      readFileSync(discover.logPath!, "utf8")
        .split("\n")
        .map(parseProgressEventLine)
        .some((event) => event?.status === "failed"),
    ).toBe(true);
    expect(
      runs
        .filter((s) => s.stageKey !== "discover")
        .every((s) => s.status === "blocked"),
    ).toBe(true);
    database.close();
    process.chdir(previousCwd);
  });

  it("completes all-gated adjudicate without adjudicator adapter", async () => {
    const workspace = createTempWorkspace();
    const previousCwd = process.cwd();
    process.chdir(workspace.root);
    const database = openDatabase(workspace.dbPath);
    runMigrations(database);
    const adapters = buildFixtureAdapters({ adjudicate: "absent" });
    adapters.prepare = {
      classifyCitation: ({ citationOccurrence }) =>
        Promise.resolve({
          status: "classified" as const,
          citationRole: "acknowledgment_or_low_information" as const,
          evaluationMode: "skip_low_information" as const,
          modifiers: {
            isBundled: citationOccurrence.isBundledCitation,
            isReviewMediated: false,
            bundleSize: citationOccurrence.bundleSize,
          },
          signals: ["fixture:all-gated"],
          rationale: "All records gated for adapter-absent adjudicate.",
          confidence: "high" as const,
          execution: {
            kind: "deterministic" as const,
            implementation: "fixture-all-gated-classifier-v1",
          },
        }),
    };
    const result = await orchestrateCanonicalPipelineRun({
      args: {
        input: workspace.inputPath,
        runId: undefined,
        seedPdfPath: undefined,
        forceRefresh: false,
        stopAfterStage: "report",
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
      config: workspace.config,
      apiKey: undefined,
      database,
      adapters,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    const adjudicate = loadCanonicalAdjudicateArtifact(
      getRunStage(database, result.runId, "adjudicate")!.primaryArtifactPath!,
    );
    expect(
      adjudicate.payload.records.every((r) => r.status === "not_adjudicated"),
    ).toBe(true);
    expect(adjudicate.provenance.models).toHaveLength(0);
    expect(getAnalysisRun(database, result.runId)?.status).toBe("succeeded");
    database.close();
    process.chdir(previousCwd);
  });

  it("supports evidence rerank enabled and nonfatal failure paths", async () => {
    const enabled = await runFresh({ evidence: "enabled" });
    const evidence = loadCanonicalEvidenceArtifact(
      getRunStage(enabled.database, enabled.result.runId, "evidence")!
        .primaryArtifactPath!,
    );
    expect(evidence.payload.rerankingPolicy.enabled).toBe(true);
    enabled.database.close();

    const failed = await runFresh({ evidence: "fail" });
    const failedEvidence = loadCanonicalEvidenceArtifact(
      getRunStage(failed.database, failed.result.runId, "evidence")!
        .primaryArtifactPath!,
    );
    expect(
      failedEvidence.payload.rerankRuns.some((r) => r.status === "failed"),
    ).toBe(true);
    expect(getAnalysisRun(failed.database, failed.result.runId)?.status).toBe(
      "succeeded",
    );
    failed.database.close();
  });

  it("treats unknown stages and flags as ordinary invalid CLI input", () => {
    expect(() =>
      parseCanonicalPipelineArgs(["--stop-after", "screen"]),
    ).toThrow(/Invalid --stop-after stage/i);
    expect(() => parseCanonicalPipelineArgs(["--shortlist", "x.json"])).toThrow(
      /Unknown pipeline flag/i,
    );
    expect(() => parseCanonicalPipelineArgs(["--advisor"])).toThrow(
      /Unknown pipeline flag/i,
    );
    expect(() =>
      parseCanonicalPipelineArgs(["--stop-after", "curate"]),
    ).toThrow(/Invalid --stop-after stage/i);
    const parsed = parseCanonicalPipelineArgs([
      "--input",
      "dois.json",
      "--stop-after",
      "report",
      "--no-rerank",
      "--bm25-candidate-limit",
      "12",
      "--evidence-selection-limit",
      "4",
    ]);
    expect(parsed.stopAfterStage).toBe("report");
    expect(parsed.evidenceRerankEnabled).toBe(false);
    expect(parsed.evidenceBm25CandidateLimit).toBe(12);
    expect(parsed.evidenceSelectionLimit).toBe(4);
  });

  it("rejects unknown run-config fields and stage names via schema", () => {
    const config = analysisRunConfigSchema.parse({});
    expect(config.stopAfterStage).toBe("report");
    expect(config.evidence.rerankEnabled).toBe(false);
    expect(
      analysisRunConfigSchema.safeParse({
        stopAfterStage: "curate",
      }).success,
    ).toBe(false);
    expect(
      analysisRunConfigSchema.safeParse({
        adjudicateAdvisor: true,
      }).success,
    ).toBe(false);
  });

  it("has no curate/sampling stage in canonical execution vocabulary", () => {
    expect(stageKeyValues).toEqual([
      "discover",
      "scope",
      "prepare",
      "evidence",
      "adjudicate",
      "report",
    ]);
    expect(stageKeyValues).not.toContain("curate");
    expect(stageKeyValues).not.toContain("screen");
  });
});

function loadByStage(
  stageKey: string,
  path: string,
): {
  artifactId: string;
  contentHash: string;
} {
  switch (stageKey) {
    case "discover":
      return loadCanonicalDiscoverArtifact(path);
    case "scope":
      return loadCanonicalScopeArtifact(path);
    case "prepare":
      return loadCanonicalPrepareArtifact(path);
    case "evidence":
      return loadCanonicalEvidenceArtifact(path);
    case "adjudicate":
      return loadCanonicalAdjudicateArtifact(path);
    case "report":
      return loadCanonicalReportArtifact(path);
    default:
      throw new CanonicalExecutorError(`Unexpected stage ${stageKey}`);
  }
}

function getOnlyRunId(database: ReturnType<typeof openDatabase>): string {
  const row = database
    .prepare("SELECT id FROM analysis_runs LIMIT 1")
    .get() as { id: string };
  return row.id;
}
