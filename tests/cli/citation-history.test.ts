import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { parsePipelineArgs } from "../../src/cli/commands/pipeline.js";
import { PROMPT_VERSIONS } from "../../src/config/prompt-versions.js";
import { createAppConfig } from "../../src/config/app-config.js";
import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import {
  listCitationHistory,
  citationHistoryRoot,
} from "../../src/history/store.js";
import { rebuildRunCostSummary } from "../../src/pipeline/cost-summary.js";
import {
  runPipeline,
  type PipelineAdapters,
} from "../../src/pipeline/executor.js";
import { historyBoundStageIds } from "../../src/pipeline/history-retention.js";
import { loadReportChain } from "../../src/pipeline/report-chain.js";
import { createProvenanceStore } from "../../src/pipeline/provenance-store.js";
import { parseParsedPaperDocument } from "../../src/retrieval/parsed-paper.js";
import {
  canonicalSha256,
  sha256Text,
} from "../../src/shared/stable-identity.js";
import { adjudicatePromptText } from "../../src/stages/adjudicate/run.js";
import { hashAdjudicateRequest } from "../../src/contract/artifacts/index.js";
import { createAdapterSession } from "../../src/stages/production.js";
import {
  createAnalysisRun,
  getRunStage,
  setRunStatus,
  updateStageStatus,
} from "../../src/storage/analysis-runs.js";
import { openDatabase } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migration-service.js";
import {
  externalExecution,
  modelExecution,
  prepareAdapters,
  scopeAdapters,
} from "../stages/chain.fixture.js";

const cliEntry = fileURLToPath(
  new URL("../../src/cli/index.ts", import.meta.url),
);
const cliLoader = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;
const execFileAsync = promisify(execFile);

const original = {
  doi: "10.1000/gravel-field-trial",
  paperId: "gravel-field-trial",
  title: "Moisture after low tide in coarse-gravel plots",
  publicationYear: 2017,
};
const intermediate = {
  doi: "10.1000/estuary-methods",
  paperId: "estuary-methods",
  title: "Monitoring moisture in intertidal habitats",
  publicationYear: 2021,
};
const later = {
  doi: "10.1000/intertidal-review",
  paperId: "intertidal-review",
  title: "Review of intertidal substrate moisture",
  publicationYear: 2024,
};
const sourceText =
  "Coarse gravel retained moisture after low tide in the experimental plots.";
const sampleSummary =
  "The trial found that coarse gravel retained moisture after low tide.";

function historyFixtureAdapters(
  seedPaper: typeof original,
  citingPaper: typeof original,
  runRoot: string,
): PipelineAdapters {
  const marker = "[1]";
  const context =
    "The cited study found that coarse gravel retained moisture after low tide [1].";
  const support = context.slice(0, context.indexOf(marker)).trimEnd();
  function paperSource(paper: typeof original) {
    const target = paper === later ? intermediate.doi : original.doi;
    const text = `<article><front><article-meta><article-id pub-id-type="doi">${paper.doi}</article-id></article-meta></front><body><sec><title>Results</title><p>${sourceText}</p><p>${support} <xref ref-type="bibr" rid="ref1">${marker}</xref>.</p></sec></body><back><ref-list><ref id="ref1"><element-citation><pub-id pub-id-type="doi">${target}</pub-id></element-citation></ref></ref-list></back></article>`;
    const parsed = parseParsedPaperDocument(text, "jats_xml");
    if (!parsed.ok) throw new Error(parsed.error);
    return { text, hash: sha256Text(text), document: parsed.data };
  }
  const store = createProvenanceStore(runRoot);
  const cited = paperSource(seedPaper);
  const citing = paperSource(citingPaper);
  const block = cited.document.blocks.find((item) => item.text === sourceText)!;
  const provenance = [
    store.persist({
      role: "citing-paper-parse",
      stage: "discover",
      body: {
        citingPaperId: citingPaper.paperId,
        sourceTextHash: citing.hash,
        parserKind: citing.document.parserKind,
        parserVersion: citing.document.parserVersion,
        sourceText: citing.text,
        fullTextFormat: "jats_xml",
      },
    }),
  ];

  return {
    session: createAdapterSession(),
    discover: {
      resolveSeed: () =>
        Promise.resolve({
          status: "resolved",
          paper: {
            ...seedPaper,
            providerRecordId: seedPaper.paperId,
            authors: ["M. Green"],
          },
          execution: externalExecution("fixture-provider", seedPaper.paperId),
        }),
      retrieveCitingNeighborhood: () =>
        Promise.resolve({
          status: "completed",
          coverage: "complete",
          providerReportedTotal: 1,
          papers: [
            {
              ...citingPaper,
              providerRecordId: citingPaper.paperId,
              authors: ["C. Ortiz"],
              fullTextAvailability: "available",
              provenanceArtifacts: provenance,
            },
          ],
          execution: externalExecution("fixture-provider", citingPaper.paperId),
        }),
      harvestMentions: () =>
        Promise.resolve({
          materialization: {
            status: "succeeded",
            reason: "Fixture full text read.",
            provenanceArtifacts: provenance,
          },
          harvest: {
            status: "succeeded",
            reason: "Fixture citation group located by DOI.",
            provenanceArtifacts: provenance,
          },
          bibliographyMatch: { method: "doi", refId: "ref1" },
          mentions: citing.document.mentions.map(
            ({ blockId: _blockId, ...mention }) => ({
              ...mention,
              sourceTextHash: citing.hash,
              parserVersion: citing.document.parserVersion,
              provenanceArtifacts: provenance,
            }),
          ),
        }),
      extractAttributedClaims: () =>
        Promise.resolve({
          status: "completed",
          reason: "The citation introduces a concrete result.",
          claims: [
            {
              text: sampleSummary,
              supportSpanText: support,
              confidence: "high",
            },
          ],
          execution: modelExecution(
            "claim-extraction",
            citingPaper.paperId,
            undefined,
            {
              id: "attributed-claim-extraction",
              version: PROMPT_VERSIONS.extraction,
            },
          ),
        }),
    },
    scope: {
      ...scopeAdapters("grounded"),
      materializeSeed: ({ seed }) => {
        const blocks = cited.document.blocks;
        const seedTextArtifact = store.persist({
          role: "immutable-seed-text",
          stage: "scope",
          body: {
            seedId: seed.seedId,
            sourceTextHash: cited.hash,
            parserKind: cited.document.parserKind,
            parserVersion: cited.document.parserVersion,
            blocks,
          },
        });
        return Promise.resolve({
          seedId: seed.seedId,
          status: "materialized",
          reason: "Source is available in the fixture store.",
          seedTextArtifact,
          sourceArtifacts: [seedTextArtifact],
          parser: {
            kind: cited.document.parserKind,
            version: cited.document.parserVersion,
          },
          blocks,
          execution: {
            kind: "deterministic",
            implementation: "fixture-text",
            sourceArtifacts: [seedTextArtifact],
          },
        });
      },
      inventorySeed: () =>
        Promise.resolve({
          status: "completed",
          rawOutput: {
            takeaways: [],
            inventoryReason: "Matches the Results text.",
            results: [
              {
                id: "result",
                qualifiers: [],
                supports: [],
                statement: sourceText,
                ownershipReason: "The field trial measured the moisture.",
                supportSpans: [
                  { verbatimQuote: sourceText, blockId: block.blockId },
                ],
              },
            ],
          },
          execution: modelExecution("seed-inventory", seedPaper.paperId),
        }),
      matchStatements: ({ findings, statements }) =>
        Promise.resolve({
          status: "completed",
          rawOutput: {
            assessments: statements.map((statement) => ({
              statementId: statement.statementId,
              relationship: "full",
              findingIds: [findings[0]!.findingId],
              retained: ["retained moisture after low tide"],
              changes: [],
              reason:
                "The statement retains the substrate and the measured result.",
            })),
          },
          execution: modelExecution("match-statements", seedPaper.paperId),
        }),
    },
    prepare: prepareAdapters("default"),
    evidence: {},
    adjudicate: {
      adjudicate: (input) =>
        Promise.resolve({
          status: "completed",
          rawOutput: {
            citingAssertion: sampleSummary,
            sourceStatement: sourceText,
            verdict: "F",
            mutationKinds: [],
            direction: "none",
            rationale: "The relevant result is preserved.",
            confidence: "high",
            citedChunkIds: [input.packet.selectedChunks[0]!.chunkId],
          },
          execution: {
            ...modelExecution("adjudicate", input.recordId),
            promptId: input.promptId,
            promptVersion: input.promptVersion,
            promptContentHash: canonicalSha256(adjudicatePromptText(input)),
            requestHash: hashAdjudicateRequest(input),
          },
        }),
    },
  };
}

describe("citation-history CLI over completed Report runs", () => {
  it("reuses a valid report beyond an incompatible archived report at zero model cost", async () => {
    const pipelineOutput = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const root = mkdtempSync(join(tmpdir(), "citation-history-cli-"));
    const databasePath = join(root, "test.sqlite");
    const database = openDatabase(databasePath);
    const runConfig = analysisRunConfigSchema.parse({
      evidence: { rerankEnabled: false },
      adjudicate: { evidence: "selected_chunks" },
    });
    const unavailableUrl = "http://127.0.0.1:1";
    const config = createAppConfig({
      NODE_ENV: "test",
      PALIMPSEST_DB_PATH: databasePath,
      OPENALEX_BASE_URL: unavailableUrl,
      SEMANTIC_SCHOLAR_BASE_URL: unavailableUrl,
      BIORXIV_BASE_URL: unavailableUrl,
      GROBID_BASE_URL: unavailableUrl,
      GROBID_CONCURRENCY: 1,
    });
    const runCli = (args: string[], entrypoint = "citation-history") =>
      execFileAsync(
        process.execPath,
        ["--import", cliLoader, cliEntry, entrypoint, ...args],
        {
          cwd: root,
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "test",
            PALIMPSEST_DB_PATH: databasePath,
            OPENALEX_BASE_URL: unavailableUrl,
            SEMANTIC_SCHOLAR_BASE_URL: unavailableUrl,
            BIORXIV_BASE_URL: unavailableUrl,
            GROBID_BASE_URL: unavailableUrl,
          },
        },
      );
    try {
      runMigrations(database);
      const runFinished = async (
        runId: string,
        seed: typeof original,
        citing: typeof original,
      ) => {
        const runRoot = join(root, runId);
        mkdirSync(join(runRoot, "logs"), { recursive: true });
        createAnalysisRun(database, {
          id: runId,
          seedDoi: seed.doi,
          seedDois: [seed.doi],
          targetStage: "report",
          runRoot,
          config: runConfig,
        });
        await runPipeline({
          args: parsePipelineArgs(["--run-id", runId]),
          config,
          apiKey: undefined,
          database,
          adapters: historyFixtureAdapters(seed, citing, runRoot),
        });
        return getRunStage(database, runId, "report")!.primaryArtifactPath!;
      };
      const originalId = "history-cli-original";
      const intermediateId = "history-cli-intermediate";
      const archivedId = "history-cli-archived";
      const reportPath = await runFinished(originalId, original, intermediate);
      const intermediatePath = await runFinished(
        intermediateId,
        intermediate,
        later,
      );
      const { chain, runRoot } = loadReportChain(reportPath);
      const reused = loadReportChain(intermediatePath).chain.report;
      const statement =
        chain.report.payload.statementReview.citationStatements[0]!;
      expect(
        statement.assessment.relationship,
        statement.assessment.reason,
      ).toBe("full");
      expect(statement.credit).toBe("single_reference");
      expect(statement.citingPublicationYear).toBe(
        intermediate.publicationYear,
      );
      expect(
        chain.report.payload.statementReview.seedInventories[0]
          ?.seedPublicationYear,
      ).toBe(original.publicationYear);
      expect(chain.report.payload.recordTraces[0]?.adjudication).toMatchObject({
        status: "adjudicated",
        verdict: "F",
      });

      createAnalysisRun(database, {
        id: archivedId,
        seedDoi: intermediate.doi,
        seedDois: [intermediate.doi],
        targetStage: "report",
        runRoot: join(root, archivedId),
        config: runConfig,
      });
      const unreadableArchive = join(root, archivedId, "old-report.json");
      const { statementReview, ...oldShape } = reused.payload;
      expect(statementReview.citationStatements).toHaveLength(1);
      writeFileSync(
        unreadableArchive,
        JSON.stringify({ ...reused, payload: oldShape }),
      );
      updateStageStatus(database, archivedId, "report", "succeeded", {
        primaryArtifactPath: unreadableArchive,
      });
      setRunStatus(database, archivedId, "succeeded");
      database
        .prepare("UPDATE analysis_runs SET updated_at = ? WHERE id = ?")
        .run("2099-01-01 00:00:00", archivedId);

      const identity = {
        runId: originalId,
        artifactId: chain.report.artifactId,
        contentHash: chain.report.contentHash,
      };
      const originalReport = readFileSync(reportPath, "utf8");
      const markdownPath = getRunStage(
        database,
        originalId,
        "report",
      )!.reportArtifactPath!;
      const originalMarkdown = readFileSync(markdownPath, "utf8");
      expect(originalMarkdown).toContain(
        `Exact cited-paper quote · “${sourceText}”`,
      );
      expect(originalMarkdown).toContain("Current fidelity · F");
      expect(originalMarkdown).toContain(
        `### Cited paper · ${original.title} (${original.publicationYear})`,
      );
      expect(originalMarkdown).toContain(
        `### ${intermediate.title} (${intermediate.publicationYear})`,
      );
      const command = [
        "--run-id",
        originalId,
        "--statement",
        statement.statementId,
        "--max-parents",
        "1",
        "--max-citers",
        "1",
        "--max-cost",
        "0",
      ];
      const output = await runCli(command);
      expect(output.stdout).toContain(
        "Wrote citation history for 1 statements across 1 citing works",
      );
      expect(output.stderr).toContain(unreadableArchive);

      const histories = listCitationHistory(runRoot, identity);
      expect(histories).toHaveLength(1);
      expect(histories[0]!.payload).toMatchObject({
        limits: { maxCostUsd: 0, maxCiters: 1, maxParents: 1, maxHops: 2 },
        neighborhoods: [
          {
            coverage: "complete",
            sourceReport: {
              runId: intermediateId,
              artifactId: reused.artifactId,
            },
            citers: [{ paper: { doi: later.doi }, status: "budget_exhausted" }],
          },
        ],
        citationUses: [
          {
            citing: { doi: later.doi, publicationYear: later.publicationYear },
            statementText: sampleSummary,
          },
        ],
        paths: [
          {
            statementId: statement.statementId,
            original: { publicationYear: original.publicationYear },
            middle: { publicationYear: intermediate.publicationYear },
            firstHop: { relationship: "full" },
            laterHops: [
              {
                useId: histories[0]!.payload.citationUses[0]!.useId,
                status: "budget_exhausted",
                assessments: [{ status: "budget_exhausted" }],
                directCitation: { status: "no_match_in_parsed_references" },
              },
            ],
          },
        ],
      });
      expect(
        rebuildRunCostSummary(citationHistoryRoot(runRoot, identity)),
      ).toMatchObject({ totalEstimatedCostUsd: 0, totalBillableCalls: 0 });
      expect(readFileSync(reportPath, "utf8")).toBe(originalReport);
      expect(readFileSync(markdownPath, "utf8")).toBe(originalMarkdown);
      const archivedStageIds = (report: typeof reused) =>
        new Set([
          report.artifactId,
          ...report.inputArtifacts.map((input) => input.artifactId),
        ]);
      expect(historyBoundStageIds(runRoot)).toEqual(
        archivedStageIds(chain.report),
      );
      expect(historyBoundStageIds(join(root, intermediateId))).toEqual(
        archivedStageIds(reused),
      );

      await expect(
        runCli([...command, "--reuse-report", unreadableArchive]),
      ).rejects.toMatchObject({ code: 1 });
      expect(
        listCitationHistory(runRoot, identity).map(
          (history) => history.artifactId,
        ),
      ).toEqual(histories.map((history) => history.artifactId));

      // Resume through the public combined entry point. Its small allowance
      // admits no new provider request. Selection comes from the Report.
      await runCli(
        ["--run-id", originalId, "--history", "--max-cost", "0.000001"],
        "pipeline",
      );
      const automatic = listCitationHistory(runRoot, identity).find(
        (item) => item.payload.selection.explicitStatementIds.length === 0,
      );
      expect(automatic?.payload.paths.map((path) => path.statementId)).toEqual([
        statement.statementId,
      ]);
      expect(automatic?.payload.limits.maxCostUsd).toBe(0.000001);
      expect(
        rebuildRunCostSummary(citationHistoryRoot(runRoot, identity))
          .totalBillableCalls,
      ).toBe(0);
    } finally {
      pipelineOutput.mockRestore();
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
