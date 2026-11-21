import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

import { createAppConfig, type AppConfig } from "../../config/app-config.js";
import { loadEnvironmentLenient } from "../../config/env.js";
import { normalizeDoi } from "../../contract/artifacts/checks.js";
import { stableIdentifierSchema } from "../../contract/artifacts/primitives.js";
import {
  analysisRunConfigSchema,
  type AnalysisRunConfig,
} from "../../contract/run-types.js";
import { hasUnresolvedSpend } from "../../history/budget.js";
import { buildHistoryAssessmentAdapter } from "../../history/adapters.js";
import { CITATION_HISTORY_DEFAULTS } from "../../history/limits.js";
import { createFirstHopParagraphCitationReader } from "../../history/parent-citation.js";
import { runCitationHistory } from "../../history/run.js";
import {
  freshHistorySource,
  reuseHistorySource,
  type ParsedCitationSource,
} from "../../history/sources.js";
import {
  citationHistoryLimitsSchema,
  citationHistoryRoot,
  writeCitationHistory,
  type CitationHistoryPayload,
} from "../../history/store.js";
import { createLLMClient } from "../../integrations/llm-client.js";
import {
  createRunCostTracker,
  rebuildRunCostSummary,
} from "../../pipeline/cost-summary.js";
import { readDoisFromFile } from "../../pipeline/executor.js";
import { retainHistorySource } from "../../pipeline/history-retention.js";
import {
  createProvenanceStore,
  preserveReferencedProvenance,
} from "../../pipeline/provenance-store.js";
import {
  loadReportChain,
  type ReportChain,
} from "../../pipeline/report-chain.js";
import { resolveDoiInputPath } from "../../pipeline/stage-paths.js";
import { buildDiscoverAdapters } from "../../stages/discover/adapters.js";
import { createAdapterSession } from "../../stages/production.js";
import { buildScopeAdapters } from "../../stages/scope/adapters.js";
import {
  getAnalysisRun,
  getRunStage,
  listAnalysisRuns,
} from "../../storage/analysis-runs.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";
import {
  traceMethods,
  traceOperation,
  withTraceSession,
} from "../../telemetry/trace.js";

const usage = `Usage:
  citation-history (--run-id <id> | --report <path>) [--statement <id> ...]
    [--max-parents <n>] [--max-citers <n>] [--max-cost <usd>]
    [--max-hops 2] [--reuse-report <path> ...]

Follow verified statements from a finished report to papers citing their
intermediate sources. Selects up to ${CITATION_HISTORY_DEFAULTS.maxParents} statements and examines up to ${CITATION_HISTORY_DEFAULTS.maxCiters} citing
works total by default. Repeat --statement to select specific statement IDs.
The default model budget is $0. Zero uses reuse reports and exact model caches.
A positive budget enables fresh discovery and applies cumulatively to all
history attempts for this report. Repeat --reuse-report to supply intermediate
reports outside the local run registry. Depth is two citation edges.
`;

type CitationHistoryArgs = {
  runId?: string;
  reportPath?: string;
  statements: string[];
  reuseReports: string[];
  limits: CitationHistoryPayload["limits"];
};

function parseCitationHistoryArgs(
  argv: readonly string[],
): CitationHistoryArgs {
  let runId: string | undefined;
  let reportPath: string | undefined;
  let maxParents: number = CITATION_HISTORY_DEFAULTS.maxParents;
  let maxCiters: number = CITATION_HISTORY_DEFAULTS.maxCiters;
  let maxHops: number = CITATION_HISTORY_DEFAULTS.maxHops;
  let maxCostUsd = 0;
  const statements: string[] = [];
  const reuseReports: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!value || value.startsWith("--"))
      throw new Error("Missing value for " + flag);
    if (seen.has(flag) && flag !== "--statement" && flag !== "--reuse-report") {
      throw new Error("Duplicate history flag " + flag);
    }
    seen.add(flag);
    switch (flag) {
      case "--run-id":
        runId = value;
        break;
      case "--report":
        reportPath = value;
        break;
      case "--statement":
        statements.push(stableIdentifierSchema.parse(value));
        break;
      case "--reuse-report":
        reuseReports.push(resolve(value));
        break;
      case "--max-parents":
        maxParents = Number(value);
        break;
      case "--max-citers":
        maxCiters = Number(value);
        break;
      case "--max-cost":
        maxCostUsd = Number(value);
        break;
      case "--max-hops":
        maxHops = Number(value);
        break;
      default:
        throw new Error("Unknown citation history flag " + flag);
    }
  }
  if (Boolean(runId) === Boolean(reportPath)) {
    throw new Error(
      "Pass exactly one of --run-id and --report to citation-history",
    );
  }
  const limits = citationHistoryLimitsSchema.parse({
    maxParents,
    maxCiters,
    maxCostUsd,
    maxHops,
  });
  return {
    ...(runId ? { runId } : {}),
    ...(reportPath ? { reportPath } : {}),
    statements,
    reuseReports,
    limits,
  };
}

function currentReportPath(database: Database.Database, runId: string): string {
  const stage = getRunStage(database, runId, "report");
  if (stage?.status !== "succeeded" || !stage.primaryArtifactPath)
    throw new Error("Run " + runId + " has no completed report");
  return stage.primaryArtifactPath;
}

function reportLookup(database: Database.Database, paths: readonly string[]) {
  const explicit = paths.map((path) => loadReportChain(path));
  const byDoi = new Map<string, { chain: ReportChain; runRoot: string }[]>();
  for (const entry of explicit) {
    const { chain } = entry;
    for (const seed of chain.discover.payload.seeds) {
      const doi = normalizeDoi(seed.doi);
      const chains = byDoi.get(doi);
      if (chains) chains.push(entry);
      else byDoi.set(doi, [entry]);
    }
  }
  const automatic = new Map<string, string[]>();
  for (const run of listAnalysisRuns(database)) {
    if (run.status !== "succeeded" || run.targetStage !== "report") continue;
    const stage = getRunStage(database, run.id, "report");
    if (stage?.status !== "succeeded" || !stage.primaryArtifactPath) continue;
    const inputPath = resolveDoiInputPath(run.runRoot);
    let dois: string[];
    try {
      dois = readDoisFromFile(inputPath);
    } catch (error) {
      console.warn(
        "Skipping unavailable archived DOI input " +
          inputPath +
          ". " +
          (error instanceof Error ? error.message : String(error)),
      );
      continue;
    }
    for (const inputDoi of dois) {
      const doi = normalizeDoi(inputDoi);
      const matches = automatic.get(doi);
      if (matches) matches.push(stage.primaryArtifactPath);
      else automatic.set(doi, [stage.primaryArtifactPath]);
    }
  }
  return function* (
    doi: string,
  ): Generator<{ chain: ReportChain; runRoot: string }> {
    const key = normalizeDoi(doi);
    yield* byDoi.get(key) ?? [];
    for (const path of automatic.get(key) ?? []) {
      let candidate;
      try {
        candidate = loadReportChain(path);
      } catch (error) {
        console.warn(
          "Skipping unavailable archived report " +
            path +
            ". " +
            (error instanceof Error ? error.message : String(error)),
        );
        continue;
      }
      yield candidate;
    }
  };
}

async function execute(
  args: CitationHistoryArgs,
  database: Database.Database,
  config: AppConfig,
): Promise<{ path: string; root: string; selected: number; citers: number }> {
  const { chain, runRoot } = loadReportChain(
    args.reportPath ?? currentReportPath(database, args.runId!),
  );
  if (args.runId && chain.report.runId !== args.runId)
    throw new Error("Registered report has a different run identity");
  const root = citationHistoryRoot(runRoot, chain.report);
  mkdirSync(root, { recursive: true });
  // The independent SQLite transaction is an OS-released mutex for the
  // report's model budget. The canonical cache database can still be written.
  const lock = new Database(resolve(root, "budget-lock.sqlite"), {
    timeout: 0,
  });
  try {
    try {
      lock.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_BUSY")
        throw new Error(
          "Another citation history command is using this report's spend budget",
          { cause: error },
        );
      throw error;
    }
    const previous = rebuildRunCostSummary(root);
    const unknownSpend = hasUnresolvedSpend(previous);
    const costs = createRunCostTracker(root);
    const maxUsd = unknownSpend ? 0 : args.limits.maxCostUsd;
    const spentUsd = () => costs.spentUsd(maxUsd);
    if (unknownSpend) {
      console.warn(
        "History contains unresolved model usage. This attempt can use verified reports and exact model caches.",
      );
    }
    const provenanceStore = createProvenanceStore(root);
    const reportStore = createProvenanceStore(runRoot);
    const sourceStores = new Map([[runRoot, reportStore]]);
    const llmClient = createLLMClient({
      apiKey: config.anthropicApiKey ?? "",
      collector: costs.collector,
      database,
      spendLimit: {
        maxUsd,
        spentUsd,
        reserveDirectRequests: true,
      },
    });
    const runConfig: AnalysisRunConfig = analysisRunConfigSchema.parse(
      getAnalysisRun(database, chain.report.runId)?.config ?? {},
    );
    const deps = {
      config,
      runConfig: {
        ...runConfig,
        discover: {
          ...runConfig.discover,
          fromYear: undefined,
          toYear: undefined,
        },
        scope: {
          ...runConfig.scope,
          seedPdfPath: undefined,
        },
      },
      llmClient,
      session: createAdapterSession(),
      provenanceStore,
      paperCache: { db: database, cachePolicy: "prefer_cache" as const },
    };
    const parsedSources = new Map<string, ParsedCitationSource>();
    const discover = traceMethods(
      "history.discover",
      buildDiscoverAdapters(deps, ({ paperId, document, artifact }) => {
        parsedSources.set(paperId, { document, artifact });
      }),
    );
    const scope = traceMethods("history.scope", buildScopeAdapters(deps));
    const assess = buildHistoryAssessmentAdapter(deps);
    const reusable = reportLookup(database, args.reuseReports);
    return await withTraceSession(costs.trace, () =>
      traceOperation(
        "history",
        "citation-history",
        {
          reportArtifactId: chain.report.artifactId,
          limits: args.limits,
          statements: args.statements,
        },
        async () => {
          const artifact = await runCitationHistory({
            report: chain,
            readFirstHopParagraphCitations:
              createFirstHopParagraphCitationReader(reportStore),
            limits: args.limits,
            explicitStatementIds: args.statements,
            assessHistoryCases: (cases) =>
              traceOperation(
                "tool",
                "history.assessCitationUses",
                {
                  cases: cases.map(({ caseId }) => caseId),
                  middleSource: cases[0]?.parentSourceArtifact,
                },
                () => assess(cases),
              ),
            getSource: async (middle, maxCiters) => {
              if (middle.doi) {
                for (const candidate of reusable(middle.doi)) {
                  const candidateStore = createProvenanceStore(
                    candidate.runRoot,
                  );
                  const source = reuseHistorySource({
                    chain: candidate.chain,
                    middle,
                    maxCiters,
                    provenanceStore,
                    readProvenance: (reference) =>
                      existsSync(candidateStore.pathFor(reference))
                        ? candidateStore.load(reference).body
                        : undefined,
                  });
                  if (source) {
                    sourceStores.set(candidate.runRoot, candidateStore);
                    retainHistorySource(
                      candidate.runRoot,
                      candidate.chain.report,
                      chain.report,
                    );
                    return source;
                  }
                }
              }
              return freshHistorySource({
                middle,
                maxCiters,
                neighborhoodLimit: runConfig.discover.neighborhoodLimit,
                discover,
                scope,
                provenanceStore,
                getParsedSource: (paperId) => {
                  const source = parsedSources.get(paperId);
                  parsedSources.delete(paperId);
                  return source;
                },
                shouldStartWork: () => spentUsd() < maxUsd,
              });
            },
          });
          preserveReferencedProvenance(artifact.payload, provenanceStore, [
            ...sourceStores.values(),
          ]);
          return {
            path: writeCitationHistory(runRoot, artifact),
            root,
            selected: artifact.payload.paths.length,
            citers: artifact.payload.neighborhoods.reduce(
              (sum, item) => sum + item.citers.length,
              0,
            ),
          };
        },
      ),
    );
  } finally {
    lock.close();
  }
}

export async function runCitationHistoryCommand(
  argv: readonly string[],
): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.info(usage);
    return;
  }
  const args = parseCitationHistoryArgs(argv);
  const environment = loadEnvironmentLenient();
  const config = createAppConfig({
    ...environment,
    GROBID_BASE_URL: environment.GROBID_BASE_URL ?? "http://localhost:8070",
  });
  const database = openDatabase(config.databasePath);
  try {
    runMigrations(database);
    const result = await execute(args, database, config);
    console.info(
      "Wrote citation history for " +
        result.selected.toString() +
        " statements across " +
        result.citers.toString() +
        " citing works to " +
        result.path,
    );
    console.info("Trace root " + result.root);
  } finally {
    database.close();
  }
}
