/**
 * Canonical six-stage pipeline executor.
 *
 * discover → scope → prepare → evidence → adjudicate → report
 *
 * Fresh execution writes then reloads/validates each stage artifact before
 * downstream use. Resume uses the same loaders. Missing/invalid/tampered/
 * wrong-lineage artifacts fail the run — never silent recomputation.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type Database from "better-sqlite3";
import { z } from "zod";

import type { AppConfig } from "../config/app-config.js";
import {
  analysisRunConfigSchema,
  type AnalysisRun,
  type AnalysisRunConfig,
  type StageKey,
} from "../contract/run-types.js";
import {
  compareStageKeys,
  getNextStageKey,
  getStageDefinition,
  rejectedLegacyStageNames,
  stageDefinitions,
  stageKeySchema,
} from "../contract/stages.js";
import type {
  AdjudicateArtifact,
  ArtifactReference,
  DiscoverArtifact,
  EvidenceArtifact,
  PrepareArtifact,
  ReportArtifact,
  ScopeArtifact,
} from "../contract/lean-artifacts.js";
import {
  createLLMClient,
  createLLMTelemetryCollector,
  type LLMClient,
} from "../integrations/llm-client.js";
import {
  createAnalysisRun,
  getAnalysisRun,
  getRunStage,
  listRunStages,
  markDownstreamStagesStale,
  setRunStatus,
  updateAnalysisRunConfig,
  updateStageStatus,
} from "../storage/analysis-runs.js";
import { runMigrations } from "../storage/migration-service.js";
import { canonicalSha256 } from "../shared/stable-identity.js";
import { createStageReporter, log } from "../cli/stage-reporter.js";
import { getStageWorkflowDefinition } from "../contract/workflow.js";
import {
  buildCanonicalDiscoverArtifact,
  runCanonicalDiscover,
} from "./canonical-discover.js";
import {
  loadCanonicalDiscoverArtifact,
  writeCanonicalDiscoverArtifact,
} from "./canonical-discover-artifact.js";
import {
  buildCanonicalScopeArtifact,
  runCanonicalScope,
} from "./canonical-scope.js";
import {
  loadCanonicalScopeArtifact,
  writeCanonicalScopeArtifact,
} from "./canonical-scope-artifact.js";
import {
  buildCanonicalPrepareArtifact,
  runCanonicalPrepare,
} from "./canonical-prepare.js";
import {
  loadCanonicalPrepareArtifact,
  writeCanonicalPrepareArtifact,
} from "./canonical-prepare-artifact.js";
import {
  buildCanonicalEvidenceArtifact,
  runCanonicalEvidence,
} from "./canonical-evidence.js";
import {
  loadCanonicalEvidenceArtifact,
  writeCanonicalEvidenceArtifact,
} from "./canonical-evidence-artifact.js";
import {
  buildCanonicalAdjudicateArtifact,
  runCanonicalAdjudicate,
} from "./canonical-adjudicate.js";
import {
  loadCanonicalAdjudicateArtifact,
  writeCanonicalAdjudicateArtifact,
} from "./canonical-adjudicate-artifact.js";
import {
  buildCanonicalReportArtifact,
  runCanonicalReport,
} from "./canonical-report.js";
import {
  loadCanonicalReportArtifact,
  writeCanonicalReportArtifacts,
} from "./canonical-report-artifact.js";
import {
  buildCanonicalProductionAdapters,
  type CanonicalProductionAdapters,
} from "./canonical-production-adapters.js";
import { createCanonicalProvenanceStore } from "./canonical-provenance-store.js";
import {
  createCanonicalAttemptStem,
  resolveCanonicalDoiInputPath,
  resolveCanonicalPrimaryArtifactPath,
  resolveCanonicalReportMarkdownPath,
  resolveCanonicalRunConfigPath,
  resolveCanonicalStageDirectory,
  writeCanonicalStageManifest,
} from "./canonical-stage-paths.js";
import { summarizeLedgerByStage } from "./cost-summary.js";
import { RunTracker } from "./run-tracker.js";
import { deriveCanonicalStageSummary } from "../contract/selectors.js";

export type CanonicalPipelineCliOverrides = {
  input: string | undefined;
  runId: string | undefined;
  seedPdfPath: string | undefined;
  forceRefresh: boolean | undefined;
  stopAfterStage: StageKey | undefined;
  discoverProbeBudget: number | undefined;
  discoverScopeCandidateCap: number | undefined;
  discoverFromYear: number | undefined;
  discoverToYear: number | undefined;
  discoverExtractionModel: string | undefined;
  discoverExtractionThinking: boolean | undefined;
  scopeGroundingModel: string | undefined;
  scopeGroundingThinking: boolean | undefined;
  evidenceRerankEnabled: boolean | undefined;
  evidenceRerankModel: string | undefined;
  evidenceRerankTopN: number | undefined;
  adjudicateModel: string | undefined;
  adjudicateThinking: boolean | undefined;
  /** Explicit stage to force-rerun (invalidates downstream). */
  rerunFromStage: StageKey | undefined;
};

export type CanonicalExecutorAdapters = CanonicalProductionAdapters;

export type OrchestrateCanonicalPipelineParams = {
  args: CanonicalPipelineCliOverrides;
  config: AppConfig;
  apiKey: string | undefined;
  database: Database.Database;
  /**
   * When true, SIGINT/SIGTERM closes this database before exiting. Only the
   * CLI-owned connection should set this; injected/shared DBs must not.
   */
  ownsDatabase?: boolean;
  /** Dependency-injected adapters for tests; production builds them. */
  adapters?: CanonicalExecutorAdapters;
  llmClient?: LLMClient;
  now?: () => Date;
};

export class CanonicalExecutorError extends Error {
  override readonly name = "CanonicalExecutorError";
}

const doiInputSchema = z
  .object({
    dois: z.array(z.string().min(1)).min(1),
  })
  .strict();

const STAGE_ORDER = stageDefinitions.map((stage) => stage.key);

function assertCanonicalStageKey(value: string, label: string): StageKey {
  if (
    (rejectedLegacyStageNames as readonly string[]).includes(value) ||
    value.includes("_m")
  ) {
    throw new CanonicalExecutorError(
      `Rejected legacy stage name "${value}" for ${label}. Canonical stages: ${STAGE_ORDER.join(", ")}.`,
    );
  }
  const parsed = stageKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new CanonicalExecutorError(
      `Invalid stage "${value}" for ${label}. Canonical stages: ${STAGE_ORDER.join(", ")}.`,
    );
  }
  return parsed.data;
}

function buildConfigFromCli(
  args: CanonicalPipelineCliOverrides,
  existing?: AnalysisRunConfig,
): AnalysisRunConfig {
  const base = existing ?? analysisRunConfigSchema.parse({});
  return analysisRunConfigSchema.parse({
    ...base,
    ...(args.forceRefresh != null ? { forceRefresh: args.forceRefresh } : {}),
    ...(args.stopAfterStage != null
      ? { stopAfterStage: args.stopAfterStage }
      : {}),
    discover: {
      ...base.discover,
      ...(args.discoverProbeBudget != null
        ? { probeBudget: args.discoverProbeBudget }
        : {}),
      ...(args.discoverScopeCandidateCap != null
        ? { scopeCandidateCap: args.discoverScopeCandidateCap }
        : {}),
      ...(args.discoverFromYear != null
        ? { fromYear: args.discoverFromYear }
        : {}),
      ...(args.discoverToYear != null ? { toYear: args.discoverToYear } : {}),
      ...(args.discoverExtractionModel != null
        ? { extractionModel: args.discoverExtractionModel }
        : {}),
      ...(args.discoverExtractionThinking != null
        ? { extractionThinking: args.discoverExtractionThinking }
        : {}),
    },
    scope: {
      ...base.scope,
      ...(args.seedPdfPath != null ? { seedPdfPath: args.seedPdfPath } : {}),
      ...(args.scopeGroundingModel != null
        ? { groundingModel: args.scopeGroundingModel }
        : {}),
      ...(args.scopeGroundingThinking != null
        ? { groundingThinking: args.scopeGroundingThinking }
        : {}),
    },
    evidence: {
      ...base.evidence,
      ...(args.evidenceRerankEnabled != null
        ? { rerankEnabled: args.evidenceRerankEnabled }
        : {}),
      ...(args.evidenceRerankModel != null
        ? { rerankModel: args.evidenceRerankModel }
        : {}),
      ...(args.evidenceRerankTopN != null
        ? { rerankTopN: args.evidenceRerankTopN }
        : {}),
    },
    adjudicate: {
      ...base.adjudicate,
      ...(args.adjudicateModel != null ? { model: args.adjudicateModel } : {}),
      ...(args.adjudicateThinking != null
        ? { thinking: args.adjudicateThinking }
        : {}),
    },
  });
}

/**
 * Scientific knobs that must match the artifact already produced for a stage.
 * `stopAfterStage` is intentionally excluded — it is scheduling only.
 */
function stageScientificConfig(
  config: AnalysisRunConfig,
  stage: StageKey,
): unknown {
  switch (stage) {
    case "discover":
      return {
        forceRefresh: config.forceRefresh,
        discover: config.discover,
      };
    case "scope":
      return {
        forceRefresh: config.forceRefresh,
        scope: config.scope,
      };
    case "prepare":
      return { prepare: config.prepare };
    case "evidence":
      return { evidence: config.evidence };
    case "adjudicate":
      return { adjudicate: config.adjudicate };
    case "report":
      return {};
  }
}

function earliestScientificConfigConflict(
  previous: AnalysisRunConfig,
  next: AnalysisRunConfig,
  succeededThrough: StageKey | undefined,
): StageKey | undefined {
  if (!succeededThrough) {
    return undefined;
  }
  for (const definition of stageDefinitions) {
    if (compareStageKeys(definition.key, succeededThrough) > 0) {
      break;
    }
    const previousHash = canonicalSha256(
      stageScientificConfig(previous, definition.key),
    );
    const nextHash = canonicalSha256(
      stageScientificConfig(next, definition.key),
    );
    if (previousHash !== nextHash) {
      return definition.key;
    }
  }
  return undefined;
}

function readDoisFromFile(inputPath: string): string[] {
  const raw: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
  const parsed = doiInputSchema.parse(raw);
  return parsed.dois;
}

function persistRunConfig(
  runRoot: string,
  config: AnalysisRunConfig,
  provenanceStore: ReturnType<typeof createCanonicalProvenanceStore>,
): {
  path: string;
  contentHash: string;
  sourceArtifact: ArtifactReference;
} {
  const path = resolveCanonicalRunConfigPath(runRoot);
  const body = {
    role: "canonical-run-config",
    config,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  const sourceArtifact = provenanceStore.persist({
    role: "canonical-run-config",
    body,
  });
  return {
    path,
    contentHash: canonicalSha256(body),
    sourceArtifact,
  };
}

type LoadedChain = {
  discover?: DiscoverArtifact;
  scope?: ScopeArtifact;
  prepare?: PrepareArtifact;
  evidence?: EvidenceArtifact;
  adjudicate?: AdjudicateArtifact;
  report?: ReportArtifact;
};

function loadSucceededArtifact(
  database: Database.Database,
  runId: string,
  stageKey: StageKey,
): string {
  const stage = getRunStage(database, runId, stageKey);
  if (!stage || stage.status !== "succeeded") {
    throw new CanonicalExecutorError(
      `Cannot resume: stage ${stageKey} is not succeeded.`,
    );
  }
  if (!stage.primaryArtifactPath) {
    throw new CanonicalExecutorError(
      `Cannot resume: succeeded stage ${stageKey} has no primary artifact path.`,
    );
  }
  return stage.primaryArtifactPath;
}

function loadValidatedChain(
  database: Database.Database,
  runId: string,
  throughStage: StageKey | undefined,
): LoadedChain {
  const chain: LoadedChain = {};
  if (!throughStage) return chain;

  const discoverPath = loadSucceededArtifact(database, runId, "discover");
  chain.discover = loadCanonicalDiscoverArtifact(discoverPath);
  if (chain.discover.runId !== runId) {
    throw new CanonicalExecutorError(
      `Discover artifact runId mismatch (artifact=${chain.discover.runId}, run=${runId}).`,
    );
  }
  if (throughStage === "discover") return chain;

  const scopePath = loadSucceededArtifact(database, runId, "scope");
  chain.scope = loadCanonicalScopeArtifact(scopePath);
  if (
    chain.scope.payload.discoverArtifact.artifactId !==
      chain.discover.artifactId ||
    chain.scope.payload.discoverArtifact.contentHash !==
      chain.discover.contentHash
  ) {
    throw new CanonicalExecutorError(
      "Scope artifact does not match Discover lineage; refusing silent recomputation.",
    );
  }
  if (throughStage === "scope") return chain;

  const preparePath = loadSucceededArtifact(database, runId, "prepare");
  chain.prepare = loadCanonicalPrepareArtifact(preparePath);
  if (
    chain.prepare.payload.lineage.scopeArtifact.artifactId !==
      chain.scope.artifactId ||
    chain.prepare.payload.lineage.scopeArtifact.contentHash !==
      chain.scope.contentHash ||
    chain.prepare.payload.lineage.discoverArtifact.artifactId !==
      chain.discover.artifactId ||
    chain.prepare.payload.lineage.discoverArtifact.contentHash !==
      chain.discover.contentHash
  ) {
    throw new CanonicalExecutorError(
      "Prepare artifact lineage mismatch; refusing silent recomputation.",
    );
  }
  if (throughStage === "prepare") return chain;

  const evidencePath = loadSucceededArtifact(database, runId, "evidence");
  chain.evidence = loadCanonicalEvidenceArtifact(evidencePath);
  if (
    chain.evidence.payload.lineage.prepareArtifact.artifactId !==
      chain.prepare.artifactId ||
    chain.evidence.payload.lineage.prepareArtifact.contentHash !==
      chain.prepare.contentHash ||
    chain.evidence.payload.lineage.scopeArtifact.artifactId !==
      chain.scope.artifactId ||
    chain.evidence.payload.lineage.scopeArtifact.contentHash !==
      chain.scope.contentHash
  ) {
    throw new CanonicalExecutorError(
      "Evidence artifact lineage mismatch; refusing silent recomputation.",
    );
  }
  if (throughStage === "evidence") return chain;

  const adjudicatePath = loadSucceededArtifact(database, runId, "adjudicate");
  chain.adjudicate = loadCanonicalAdjudicateArtifact(adjudicatePath);
  if (
    chain.adjudicate.payload.lineage.evidenceArtifact.artifactId !==
      chain.evidence.artifactId ||
    chain.adjudicate.payload.lineage.evidenceArtifact.contentHash !==
      chain.evidence.contentHash ||
    chain.adjudicate.payload.lineage.prepareArtifact.artifactId !==
      chain.prepare.artifactId ||
    chain.adjudicate.payload.lineage.prepareArtifact.contentHash !==
      chain.prepare.contentHash
  ) {
    throw new CanonicalExecutorError(
      "Adjudicate artifact lineage mismatch; refusing silent recomputation.",
    );
  }
  if (throughStage === "adjudicate") return chain;

  const reportPath = loadSucceededArtifact(database, runId, "report");
  chain.report = loadCanonicalReportArtifact(reportPath);
  const lineage = chain.report.payload.lineage;
  if (
    chain.report.runId !== runId ||
    lineage.runId !== runId ||
    !sameArtifactIdentity(lineage.discoverArtifact, chain.discover) ||
    !sameArtifactIdentity(lineage.scopeArtifact, chain.scope) ||
    !sameArtifactIdentity(lineage.prepareArtifact, chain.prepare) ||
    !sameArtifactIdentity(lineage.evidenceArtifact, chain.evidence) ||
    !sameArtifactIdentity(lineage.adjudicateArtifact, chain.adjudicate)
  ) {
    throw new CanonicalExecutorError(
      "Report artifact lineage mismatch; refusing silent recomputation.",
    );
  }
  return chain;
}

function sameArtifactIdentity(
  reference: { artifactId: string; contentHash: string },
  artifact: { artifactId: string; contentHash: string },
): boolean {
  return (
    reference.artifactId === artifact.artifactId &&
    reference.contentHash === artifact.contentHash
  );
}

function latestSucceededStage(
  database: Database.Database,
  runId: string,
): StageKey | undefined {
  const stages = listRunStages(database, runId).filter(
    (stage) => stage.familyIndex === 0,
  );
  let latest: StageKey | undefined;
  for (const definition of stageDefinitions) {
    const row = stages.find((stage) => stage.stageKey === definition.key);
    if (row?.status === "succeeded") {
      latest = definition.key;
      continue;
    }
    break;
  }
  return latest;
}

function firstIncompleteStage(
  database: Database.Database,
  runId: string,
  stopAfter: StageKey,
): StageKey | undefined {
  for (const definition of stageDefinitions) {
    if (compareStageKeys(definition.key, stopAfter) > 0) {
      return undefined;
    }
    const row = getRunStage(database, runId, definition.key);
    if (!row || row.status !== "succeeded") {
      return definition.key;
    }
  }
  return undefined;
}

function blockDownstream(
  database: Database.Database,
  runId: string,
  fromStage: StageKey,
  reason: string,
): void {
  let cursor: StageKey | undefined = getNextStageKey(fromStage);
  while (cursor) {
    updateStageStatus(database, runId, cursor, "blocked", {
      errorMessage: reason,
      finishedAt: new Date().toISOString(),
      exitCode: 1,
    });
    cursor = getNextStageKey(cursor);
  }
}

function writeCostSummary(
  runRoot: string,
  ledger: ReturnType<LLMClient["getLedger"]>,
): void {
  const summary = summarizeLedgerByStage(ledger);
  writeFileSync(
    resolve(runRoot, "cost-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
}

export async function orchestrateCanonicalPipelineRun(
  params: OrchestrateCanonicalPipelineParams,
): Promise<{ runId: string; runRoot: string }> {
  const { args, config, database } = params;
  const now = params.now ?? (() => new Date());
  runMigrations(database);

  if (args.runId && args.input) {
    throw new CanonicalExecutorError(
      "Pass either --run-id (resume) or --input (fresh DOI-first run), not both.",
    );
  }
  if (!args.runId && !args.input) {
    throw new CanonicalExecutorError(
      "Canonical pipeline requires --input dois.json (DOI-first) or --run-id for resume.",
    );
  }

  let run: AnalysisRun;
  let runConfig: AnalysisRunConfig;
  let seedDois: [string, ...string[]];
  let isResume = false;

  if (args.runId) {
    const existing = getAnalysisRun(database, args.runId);
    if (!existing) {
      throw new CanonicalExecutorError(`Unknown run id: ${args.runId}`);
    }
    seedDois = readDoisFromFile(
      resolveCanonicalDoiInputPath(existing.runRoot),
    ) as [string, ...string[]];
    runConfig = buildConfigFromCli(args, existing.config);
    if (compareStageKeys(runConfig.stopAfterStage, existing.targetStage) < 0) {
      throw new CanonicalExecutorError(
        `Cannot shrink run target from ${existing.targetStage} to ${runConfig.stopAfterStage}; extend the target or start a new run.`,
      );
    }
    if (
      args.rerunFromStage &&
      compareStageKeys(args.rerunFromStage, runConfig.stopAfterStage) > 0
    ) {
      throw new CanonicalExecutorError(
        `--rerun-from ${args.rerunFromStage} cannot be later than --stop-after ${runConfig.stopAfterStage}.`,
      );
    }
    if (seedDois.length > 1 && runConfig.scope.seedPdfPath) {
      throw new CanonicalExecutorError(
        "--seed-pdf is only valid for a single-DOI run.",
      );
    }
    const succeededThrough = latestSucceededStage(database, existing.id);
    const conflictStage = earliestScientificConfigConflict(
      existing.config,
      runConfig,
      succeededThrough,
    );
    if (conflictStage) {
      if (
        !args.rerunFromStage ||
        compareStageKeys(args.rerunFromStage, conflictStage) > 0
      ) {
        throw new CanonicalExecutorError(
          `Resume changes scientific config for succeeded stage ${conflictStage}; pass --rerun-from ${conflictStage} (or earlier).`,
        );
      }
    }
    run = updateAnalysisRunConfig(database, existing.id, {
      config: runConfig,
      targetStage: runConfig.stopAfterStage,
    });
    isResume = true;
    if (args.rerunFromStage) {
      const rerunStage = assertCanonicalStageKey(
        args.rerunFromStage,
        "--rerun-from",
      );
      markDownstreamStagesStale(database, run.id, rerunStage);
    }
  } else {
    if (args.rerunFromStage) {
      throw new CanonicalExecutorError(
        "--rerun-from is only valid with --run-id.",
      );
    }
    seedDois = readDoisFromFile(args.input!) as [string, ...string[]];
    const seedDoi = seedDois[0];
    if (seedDois.length > 1 && args.seedPdfPath) {
      throw new CanonicalExecutorError(
        "--seed-pdf cannot represent multiple DOI seeds.",
      );
    }
    if (seedDois.length !== 1) {
      log(
        "pipeline",
        `Canonical Discover accepts multiple DOIs in the input artifact; run seedDoi tracking uses the first (${seedDoi}).`,
      );
    }
    const stopAfter = args.stopAfterStage
      ? assertCanonicalStageKey(args.stopAfterStage, "--stop-after")
      : "report";
    runConfig = buildConfigFromCli({ ...args, stopAfterStage: stopAfter });
    const runId = randomUUID();
    const runRoot = resolve(process.cwd(), "data", "runs", runId);
    mkdirSync(runRoot, { recursive: true });
    mkdirSync(resolve(runRoot, "logs"), { recursive: true });
    for (const stage of stageDefinitions) {
      resolveCanonicalStageDirectory(runRoot, stage.key);
    }
    run = createAnalysisRun(database, {
      id: runId,
      seedDoi,
      seedDois,
      targetStage: stopAfter,
      runRoot,
      config: runConfig,
    });
  }

  const stopAfter = assertCanonicalStageKey(
    runConfig.stopAfterStage,
    "stopAfterStage",
  );
  const tracker = new RunTracker(database, run.id);
  const ownsDatabase = params.ownsDatabase === true;
  const onSignal = () => {
    tracker.interruptForSignal();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (ownsDatabase) {
      try {
        database.close();
      } catch {
        /* connection may already be closed */
      }
    }
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    setRunStatus(database, run.id, "running");
    const provenanceStore = createCanonicalProvenanceStore(run.runRoot);
    const configProvenance = persistRunConfig(
      run.runRoot,
      runConfig,
      provenanceStore,
    );

    // Validate any already-succeeded prefix before continuing.
    const succeededThrough = latestSucceededStage(database, run.id);
    if (succeededThrough) {
      loadValidatedChain(database, run.id, succeededThrough);
    }

    const startStage = firstIncompleteStage(database, run.id, stopAfter);
    if (!startStage) {
      log(
        "pipeline",
        "All canonical stages through stopAfter already succeeded.",
      );
      setRunStatus(database, run.id, "succeeded");
      return { runId: run.id, runRoot: run.runRoot };
    }

    const telemetry = createLLMTelemetryCollector();
    const llmClient =
      params.llmClient ??
      createLLMClient({
        apiKey: params.apiKey ?? "",
        collector: telemetry,
        database,
      });
    const adapters =
      params.adapters ??
      buildCanonicalProductionAdapters({
        config,
        runConfig,
        llmClient,
        provenanceStore,
        forceRefresh: runConfig.forceRefresh,
        paperCache: {
          db: database,
          cachePolicy: runConfig.forceRefresh
            ? "force_refresh"
            : "prefer_cache",
        },
      });

    const doiInputPath = resolveCanonicalDoiInputPath(run.runRoot);
    const doiProvenance = provenanceStore.persist({
      role: "doi-input",
      body: { dois: seedDois },
      canonicalStage: "discover",
    });
    const chain = loadValidatedChain(
      database,
      run.id,
      succeededThrough && compareStageKeys(succeededThrough, startStage) < 0
        ? succeededThrough
        : getPreviousStageKeySafe(startStage),
    );

    for (const stageKey of STAGE_ORDER) {
      if (compareStageKeys(stageKey, startStage) < 0) continue;
      if (compareStageKeys(stageKey, stopAfter) > 0) break;

      const logPath = resolve(
        run.runRoot,
        "logs",
        `${getStageDefinition(stageKey).slug}.log`,
      );
      tracker.stageStart(stageKey, logPath);
      const reporter = createStageReporter(stageKey, run.runRoot);
      const workflow = getStageWorkflowDefinition(stageKey);
      const firstStep = workflow.steps[0]!;
      reporter.onProgress({
        step: firstStep.id,
        status: "running",
        detail: firstStep.description,
      });
      const recordedAt = now().toISOString();
      let completedCount: number | undefined;

      try {
        if (stageKey === "discover") {
          const result = await runCanonicalDiscover(
            {
              seeds: seedDois.map((doi) => ({
                doi,
                provenanceArtifacts: [doiProvenance],
              })),
              neighborhood: {
                provider: runConfig.discover.neighborhoodProvider,
                query: runConfig.discover.neighborhoodQuery,
                limit: runConfig.discover.neighborhoodLimit,
                ...(runConfig.discover.fromYear != null ||
                runConfig.discover.toYear != null
                  ? {
                      yearRange: {
                        ...(runConfig.discover.fromYear != null
                          ? { from: runConfig.discover.fromYear }
                          : {}),
                        ...(runConfig.discover.toYear != null
                          ? { to: runConfig.discover.toYear }
                          : {}),
                      },
                    }
                  : {}),
              },
              probeBudget: runConfig.discover.probeBudget,
              scopeCandidateCap: runConfig.discover.scopeCandidateCap,
              recordedAt,
            },
            adapters.discover,
          );
          const artifact = buildCanonicalDiscoverArtifact({
            result,
            runId: run.id,
            createdAt: recordedAt,
            configuration: {
              contentHash: configProvenance.contentHash,
              sourceArtifact: configProvenance.sourceArtifact,
            },
          });
          const attemptStem = createCanonicalAttemptStem(
            recordedAt,
            artifact.artifactId,
          );
          const path = resolveCanonicalPrimaryArtifactPath(
            run.runRoot,
            "discover",
            attemptStem,
          );
          writeCanonicalDiscoverArtifact(path, artifact);
          const reloaded = loadCanonicalDiscoverArtifact(path);
          const manifestPath = writeCanonicalStageManifest(path, reloaded);
          chain.discover = reloaded;
          completedCount = reloaded.payload.seeds.length;
          const summary = deriveCanonicalStageSummary("discover", reloaded);
          updateStageStatus(database, run.id, "discover", "succeeded", {
            primaryArtifactPath: path,
            inputArtifactPath: doiInputPath,
            manifestPath,
            finishedAt: now().toISOString(),
            exitCode: 0,
            ...(summary ? { summary } : {}),
          });
        } else if (stageKey === "scope") {
          if (!chain.discover) {
            throw new CanonicalExecutorError(
              "Scope requires a validated Discover artifact.",
            );
          }
          const discoverPath = loadSucceededArtifact(
            database,
            run.id,
            "discover",
          );
          const result = await runCanonicalScope(
            chain.discover,
            adapters.scope,
            {
              recordedAt,
            },
          );
          const artifact = buildCanonicalScopeArtifact({
            result,
            runId: run.id,
            createdAt: recordedAt,
            configuration: {
              contentHash: configProvenance.contentHash,
              sourceArtifact: configProvenance.sourceArtifact,
            },
          });
          const attemptStem = createCanonicalAttemptStem(
            recordedAt,
            artifact.artifactId,
          );
          const path = resolveCanonicalPrimaryArtifactPath(
            run.runRoot,
            "scope",
            attemptStem,
          );
          writeCanonicalScopeArtifact(path, artifact);
          const reloaded = loadCanonicalScopeArtifact(path);
          const manifestPath = writeCanonicalStageManifest(path, reloaded);
          chain.scope = reloaded;
          completedCount = reloaded.payload.families.length;
          const summary = deriveCanonicalStageSummary("scope", reloaded);
          updateStageStatus(database, run.id, "scope", "succeeded", {
            primaryArtifactPath: path,
            inputArtifactPath: discoverPath,
            manifestPath,
            finishedAt: now().toISOString(),
            exitCode: 0,
            ...(summary ? { summary } : {}),
          });
        } else if (stageKey === "prepare") {
          if (!chain.discover || !chain.scope) {
            throw new CanonicalExecutorError(
              "Prepare requires validated Scope and Discover artifacts.",
            );
          }
          const scopePath = loadSucceededArtifact(database, run.id, "scope");
          const result = await runCanonicalPrepare(
            chain.scope,
            chain.discover,
            adapters.prepare,
            {
              recordedAt,
            },
          );
          const artifact = buildCanonicalPrepareArtifact({
            result,
            runId: run.id,
            createdAt: recordedAt,
            configuration: {
              contentHash: configProvenance.contentHash,
              sourceArtifact: configProvenance.sourceArtifact,
            },
          });
          const attemptStem = createCanonicalAttemptStem(
            recordedAt,
            artifact.artifactId,
          );
          const path = resolveCanonicalPrimaryArtifactPath(
            run.runRoot,
            "prepare",
            attemptStem,
          );
          writeCanonicalPrepareArtifact(path, artifact);
          const reloaded = loadCanonicalPrepareArtifact(path);
          const manifestPath = writeCanonicalStageManifest(path, reloaded);
          chain.prepare = reloaded;
          completedCount = reloaded.payload.records.length;
          const summary = deriveCanonicalStageSummary("prepare", reloaded);
          updateStageStatus(database, run.id, "prepare", "succeeded", {
            primaryArtifactPath: path,
            inputArtifactPath: scopePath,
            manifestPath,
            finishedAt: now().toISOString(),
            exitCode: 0,
            ...(summary ? { summary } : {}),
          });
        } else if (stageKey === "evidence") {
          if (!chain.prepare || !chain.scope) {
            throw new CanonicalExecutorError(
              "Evidence requires validated Prepare and Scope artifacts.",
            );
          }
          const preparePath = loadSucceededArtifact(
            database,
            run.id,
            "prepare",
          );
          const result = await runCanonicalEvidence(
            chain.prepare,
            chain.scope,
            adapters.evidence,
            {
              recordedAt,
              bm25CandidateLimit: runConfig.evidence.bm25CandidateLimit,
              selectionLimit: runConfig.evidence.selectionLimit,
              reranking: runConfig.evidence.rerankEnabled
                ? {
                    enabled: true,
                    topN: runConfig.evidence.rerankTopN,
                  }
                : { enabled: false },
            },
          );
          const artifact = buildCanonicalEvidenceArtifact({
            result,
            runId: run.id,
            createdAt: recordedAt,
            configuration: {
              contentHash: configProvenance.contentHash,
              sourceArtifact: configProvenance.sourceArtifact,
            },
          });
          const attemptStem = createCanonicalAttemptStem(
            recordedAt,
            artifact.artifactId,
          );
          const path = resolveCanonicalPrimaryArtifactPath(
            run.runRoot,
            "evidence",
            attemptStem,
          );
          writeCanonicalEvidenceArtifact(path, artifact);
          const reloaded = loadCanonicalEvidenceArtifact(path);
          const manifestPath = writeCanonicalStageManifest(path, reloaded);
          chain.evidence = reloaded;
          completedCount = reloaded.payload.records.length;
          const summary = deriveCanonicalStageSummary("evidence", reloaded);
          updateStageStatus(database, run.id, "evidence", "succeeded", {
            primaryArtifactPath: path,
            inputArtifactPath: preparePath,
            manifestPath,
            finishedAt: now().toISOString(),
            exitCode: 0,
            ...(summary ? { summary } : {}),
          });
        } else if (stageKey === "adjudicate") {
          if (!chain.evidence || !chain.prepare) {
            throw new CanonicalExecutorError(
              "Adjudicate requires validated Evidence and Prepare artifacts.",
            );
          }
          const evidencePath = loadSucceededArtifact(
            database,
            run.id,
            "evidence",
          );
          const result = await runCanonicalAdjudicate(
            chain.evidence,
            chain.prepare,
            adapters.adjudicate,
            {
              recordedAt,
            },
          );
          const artifact = buildCanonicalAdjudicateArtifact({
            result,
            runId: run.id,
            createdAt: recordedAt,
            configuration: {
              contentHash: configProvenance.contentHash,
              sourceArtifact: configProvenance.sourceArtifact,
            },
          });
          const attemptStem = createCanonicalAttemptStem(
            recordedAt,
            artifact.artifactId,
          );
          const path = resolveCanonicalPrimaryArtifactPath(
            run.runRoot,
            "adjudicate",
            attemptStem,
          );
          writeCanonicalAdjudicateArtifact(path, artifact);
          const reloaded = loadCanonicalAdjudicateArtifact(path);
          const manifestPath = writeCanonicalStageManifest(path, reloaded);
          chain.adjudicate = reloaded;
          completedCount = reloaded.payload.records.length;
          const summary = deriveCanonicalStageSummary("adjudicate", reloaded);
          updateStageStatus(database, run.id, "adjudicate", "succeeded", {
            primaryArtifactPath: path,
            inputArtifactPath: evidencePath,
            manifestPath,
            finishedAt: now().toISOString(),
            exitCode: 0,
            ...(summary ? { summary } : {}),
          });
        } else if (stageKey === "report") {
          if (
            !chain.discover ||
            !chain.scope ||
            !chain.prepare ||
            !chain.evidence ||
            !chain.adjudicate
          ) {
            throw new CanonicalExecutorError(
              "Report requires the complete validated canonical chain.",
            );
          }
          const result = runCanonicalReport(
            chain.discover,
            chain.scope,
            chain.prepare,
            chain.evidence,
            chain.adjudicate,
            { recordedAt },
          );
          const artifact = buildCanonicalReportArtifact({
            result,
            runId: run.id,
            createdAt: recordedAt,
            configuration: {
              contentHash: configProvenance.contentHash,
              sourceArtifact: configProvenance.sourceArtifact,
            },
          });
          const attemptStem = createCanonicalAttemptStem(
            recordedAt,
            artifact.artifactId,
          );
          const jsonPath = resolveCanonicalPrimaryArtifactPath(
            run.runRoot,
            "report",
            attemptStem,
          );
          const mdPath = resolveCanonicalReportMarkdownPath(
            run.runRoot,
            attemptStem,
          );
          const written = writeCanonicalReportArtifacts(
            jsonPath,
            mdPath,
            artifact,
          );
          const reloaded = loadCanonicalReportArtifact(written.jsonPath);
          const manifestPath = writeCanonicalStageManifest(
            written.jsonPath,
            reloaded,
            [written.markdownPath],
          );
          chain.report = reloaded;
          completedCount = reloaded.payload.recordTraces.length;
          const summary = deriveCanonicalStageSummary("report", reloaded);
          updateStageStatus(database, run.id, "report", "succeeded", {
            primaryArtifactPath: written.jsonPath,
            reportArtifactPath: written.markdownPath,
            manifestPath,
            inputArtifactPath: loadSucceededArtifact(
              database,
              run.id,
              "adjudicate",
            ),
            finishedAt: now().toISOString(),
            exitCode: 0,
            ...(summary ? { summary } : {}),
          });
        }

        for (const [index, step] of workflow.steps.entries()) {
          const isLast = index === workflow.steps.length - 1;
          reporter.onProgress({
            step: step.id,
            status: "completed",
            detail: step.description,
            ...(isLast && completedCount != null && completedCount > 0
              ? {
                  current: completedCount,
                  total: completedCount,
                }
              : {}),
          });
        }
        tracker.stageSuccess(stageKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reporter.onProgress({
          step: firstStep.id,
          status: "failed",
          detail: message,
        });
        updateStageStatus(database, run.id, stageKey, "failed", {
          errorMessage: message,
          finishedAt: now().toISOString(),
          exitCode: 1,
        });
        blockDownstream(
          database,
          run.id,
          stageKey,
          `Blocked: upstream stage ${stageKey} failed — ${message}`,
        );
        setRunStatus(database, run.id, "failed", stageKey);
        writeCostSummary(run.runRoot, llmClient.getLedger());
        throw error;
      }
    }

    writeCostSummary(run.runRoot, llmClient.getLedger());
    setRunStatus(database, run.id, "succeeded");
    log(
      "pipeline",
      isResume
        ? `Canonical resume complete for run ${run.id}`
        : `Canonical pipeline complete for run ${run.id}`,
    );
    return { runId: run.id, runRoot: run.runRoot };
  } catch (error) {
    if (getAnalysisRun(database, run.id)?.status === "running") {
      tracker.runFailed(error);
    }
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function getPreviousStageKeySafe(stageKey: StageKey): StageKey | undefined {
  const index = STAGE_ORDER.indexOf(stageKey);
  if (index <= 0) return undefined;
  return STAGE_ORDER[index - 1];
}
