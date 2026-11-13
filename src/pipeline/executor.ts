/**
 * Six-stage pipeline executor.
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
  RUN_CONFIG_DEFAULTS,
  defaultAllCandidatesPolicy,
  type CandidateSelectionMode,
  type AnalysisRun,
  type AnalysisStageSummary,
  type AnalysisRunConfig,
  type AdjudicationEvidence,
} from "../contract/run-types.js";
import {
  compareStageKeys,
  getNextStageKey,
  stageDefinitions,
  stageKeySchema,
  type StageKey,
} from "../contract/stages.js";
import type {
  AdjudicateArtifact,
  ArtifactProvenance,
  ArtifactReference,
  DiscoverArtifact,
  EvidenceArtifact,
  PrepareArtifact,
  ReportArtifact,
  ScopeArtifact,
} from "../contract/artifacts/index.js";
import type { StageArtifactMap } from "../contract/inspector-payloads.js";
import { createLLMClient, type LLMClient } from "../integrations/llm-client.js";
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
import { createStageReporter, log } from "./stage-reporter.js";
import { getStageWorkflowDefinition } from "../contract/workflow.js";
import { buildDiscoverArtifact, runDiscover } from "../stages/discover/run.js";
import { buildScopeArtifact, runScope } from "../stages/scope/run.js";
import { buildPrepareArtifact, runPrepare } from "../stages/prepare/run.js";
import { buildEvidenceArtifact, runEvidence } from "../stages/evidence/run.js";
import {
  buildAdjudicateArtifact,
  runAdjudicate,
} from "../stages/adjudicate/run.js";
import { buildReportArtifact, runReport } from "../stages/report/run.js";
import {
  buildProductionAdapters,
  type ProductionAdapters,
} from "./production-adapters.js";
import { createProvenanceStore } from "./provenance-store.js";
import {
  createAttemptStem,
  resolveDoiInputPath,
  resolvePrimaryArtifactPath,
  resolveReportMarkdownPath,
  resolveRunConfigPath,
  resolveStageDirectory,
  writeStageManifest,
} from "./stage-paths.js";
import { createRunCostTracker } from "./cost-summary.js";
import { createSqliteSeedCodebookStore } from "../storage/seed-codebooks.js";
import { RunTracker } from "./run-tracker.js";
import {
  deriveStageSummary,
  loadArtifact,
  writeArtifact,
} from "../contract/selectors.js";
import { writeReportArtifacts } from "../stages/report/write.js";

export type PipelineCliOverrides = {
  input: string | undefined;
  runId: string | undefined;
  seedPdfPath: string | undefined;
  forceRefresh: boolean | undefined;
  stopAfterStage: StageKey | undefined;
  /** Total citing-work observation cap across paginated provider requests. */
  discoverNeighborhoodLimit?: number | undefined;
  /** A count, or `"all"` to probe every enumerated citing work. */
  discoverProbeBudget: number | "all" | undefined;
  /** `--census` sets `all`; absent keeps the run's current mode. */
  discoverCandidateSelectionMode?: CandidateSelectionMode | undefined;
  /** Model requests in flight at once within a stage. */
  modelConcurrency?: number | undefined;
  discoverFetchConcurrency?: number | undefined;
  discoverMinFamilies: number | undefined;
  discoverMaxFamilies: number | undefined;
  discoverMaxPreparedRecords: number | undefined;
  discoverFromYear: number | undefined;
  discoverToYear: number | undefined;
  discoverExtractionModel: string | undefined;
  discoverExtractionThinking: boolean | undefined;
  scopeGroundingModel: string | undefined;
  scopeGroundingThinking: boolean | undefined;
  evidenceRerankEnabled: boolean | undefined;
  evidenceRerankModel: string | undefined;
  evidenceRerankTopN: number | undefined;
  evidenceBm25CandidateLimit?: number | undefined;
  evidenceSelectionLimit?: number | undefined;
  adjudicateModel: string | undefined;
  adjudicateThinking: boolean | undefined;
  adjudicateEffort?: "low" | "medium" | "high" | "max" | undefined;
  adjudicateEvidence?: AdjudicationEvidence | undefined;
  /** Explicit stage to force-rerun (invalidates downstream). */
  rerunFromStage: StageKey | undefined;
  /**
   * Stop sending model requests once the run's estimated spend, earlier
   * attempts included, reaches this many US dollars. Not part of the run
   * config: a resume may raise it without touching any scientific setting.
   */
  maxCostUsd?: number | undefined;
  /**
   * Send model requests through the Message Batches API at half price. A
   * transport choice, not part of the run config: a resume may turn it on or
   * off, and no scientific setting or artifact identity depends on it.
   */
  batch?: boolean | undefined;
  /**
   * Generate and store a new seed codebook in this invocation's Scope even
   * when one is stored for the seed text and procedure version. Not part of
   * the run config, and unlike `forceRefresh` the only way to replace a
   * stored codebook.
   */
  regenerateCodebook?: boolean | undefined;
};

/**
 * In-flight model requests per stage under `--batch`: a batch pays only if a
 * stage queues all its requests at once. Given to the stages, never written
 * into the run config, whose `modelConcurrency` stays what the user set.
 */
const BATCH_MODEL_CONCURRENCY = 100_000;

export type PipelineAdapters = ProductionAdapters;

export type RunPipelineParams = {
  args: PipelineCliOverrides;
  config: AppConfig;
  apiKey: string | undefined;
  database: Database.Database;
  /**
   * When true, SIGINT/SIGTERM closes this database before exiting. Only the
   * CLI-owned connection should set this; injected/shared DBs must not.
   */
  ownsDatabase?: boolean;
  /** Dependency-injected adapters for tests; production builds them. */
  adapters?: PipelineAdapters;
  llmClient?: LLMClient;
  now?: () => Date;
};

export class PipelineError extends Error {
  override readonly name = "PipelineError";
}

const doiInputSchema = z
  .object({
    dois: z.array(z.string().min(1)).min(1),
  })
  .strict();

const STAGE_ORDER = stageDefinitions.map((stage) => stage.key);

function assertStageKey(value: string, label: string): StageKey {
  const parsed = stageKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new PipelineError(
      `Invalid stage "${value}" for ${label}. Stages: ${STAGE_ORDER.join(", ")}.`,
    );
  }
  return parsed.data;
}

type StageRunContext = {
  runId: string;
  runRoot: string;
  recordedAt: string;
  runConfig: AnalysisRunConfig;
  seedDois: readonly string[];
  doiProvenance: ArtifactReference;
  configuration: NonNullable<ArtifactProvenance["configuration"]>;
  adapters: ProductionAdapters;
  chain: LoadedChain;
};

type StageWriteOutcome = {
  primaryPath: string;
  additionalPaths: string[];
  reportArtifactPath?: string;
  artifact: StageArtifactMap[StageKey];
  summary: AnalysisStageSummary;
  completedCount: number;
};

type StageRunner = {
  execute: (context: StageRunContext) => Promise<StageWriteOutcome>;
};

/**
 * Every stage does the same nine things: run, build, write, reload, hash a
 * manifest, count, summarize, and record. Only the first three differ, so only
 * those appear here and the loop owns the rest.
 */
function defineStage<K extends StageKey, Result>(spec: {
  stageKey: K;
  run: (context: StageRunContext) => Promise<Result> | Result;
  build: (input: {
    result: Result;
    runId: string;
    createdAt: string;
    configuration: NonNullable<ArtifactProvenance["configuration"]>;
  }) => StageArtifactMap[K];
  /** Extra files written alongside the primary JSON, if any. */
  writeAdditional?: (input: {
    runRoot: string;
    attemptStem: string;
    artifact: StageArtifactMap[K];
    primaryPath: string;
  }) => { paths: string[]; reportArtifactPath?: string };
  count: (artifact: StageArtifactMap[K]) => number;
  attach: (chain: LoadedChain, artifact: StageArtifactMap[K]) => void;
}): StageRunner {
  return {
    async execute(context) {
      const artifact = spec.build({
        result: await spec.run(context),
        runId: context.runId,
        createdAt: context.recordedAt,
        configuration: context.configuration,
      });
      const attemptStem = createAttemptStem(
        context.recordedAt,
        artifact.artifactId,
      );
      const primaryPath = resolvePrimaryArtifactPath(
        context.runRoot,
        spec.stageKey,
        attemptStem,
      );
      // Report renders its Markdown from the JSON it just wrote, so the extra
      // files are written before the reload rather than after.
      const additional = spec.writeAdditional
        ? spec.writeAdditional({
            runRoot: context.runRoot,
            attemptStem,
            artifact,
            primaryPath,
          })
        : (writeArtifact(spec.stageKey, primaryPath, artifact),
          { paths: [] as string[] });
      const reloaded = loadArtifact(spec.stageKey, primaryPath);
      spec.attach(context.chain, reloaded);
      return {
        primaryPath,
        additionalPaths: additional.paths,
        ...(additional.reportArtifactPath
          ? { reportArtifactPath: additional.reportArtifactPath }
          : {}),
        artifact: reloaded,
        summary: deriveStageSummary(spec.stageKey, reloaded),
        completedCount: spec.count(reloaded),
      };
    },
  };
}

/** A stage cannot start without the ancestors its contract requires. */
function requireChain<T>(artifact: T | undefined, message: string): T {
  if (artifact == null) throw new PipelineError(message);
  return artifact;
}

const STAGE_RUNNERS: Record<StageKey, StageRunner> = {
  discover: defineStage({
    stageKey: "discover",
    run: ({ seedDois, doiProvenance, runConfig, recordedAt, adapters }) =>
      runDiscover(
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
          concurrency: runConfig.modelConcurrency,
          fetchConcurrency: runConfig.discover.fetchConcurrency,
          candidateSelection: runConfig.discover.candidateSelection,
          recordedAt,
        },
        adapters.discover,
      ),
    build: buildDiscoverArtifact,
    count: (artifact) => artifact.payload.seeds.length,
    attach: (chain, artifact) => {
      chain.discover = artifact;
    },
  }),

  scope: defineStage({
    stageKey: "scope",
    run: ({ chain, adapters, recordedAt, runConfig }) =>
      runScope(
        requireChain(
          chain.discover,
          "Scope requires a validated Discover artifact.",
        ),
        adapters.scope,
        { recordedAt, concurrency: runConfig.modelConcurrency },
      ),
    build: buildScopeArtifact,
    count: (artifact) => artifact.payload.families.length,
    attach: (chain, artifact) => {
      chain.scope = artifact;
    },
  }),

  prepare: defineStage({
    stageKey: "prepare",
    run: ({ chain, adapters, recordedAt, runConfig }) =>
      runPrepare(
        requireChain(
          chain.scope,
          "Prepare requires validated Scope and Discover artifacts.",
        ),
        requireChain(
          chain.discover,
          "Prepare requires validated Scope and Discover artifacts.",
        ),
        adapters.prepare,
        { recordedAt, concurrency: runConfig.modelConcurrency },
      ),
    build: buildPrepareArtifact,
    count: (artifact) => artifact.payload.records.length,
    attach: (chain, artifact) => {
      chain.prepare = artifact;
    },
  }),

  evidence: defineStage({
    stageKey: "evidence",
    run: ({ chain, adapters, recordedAt, runConfig }) =>
      runEvidence(
        requireChain(
          chain.prepare,
          "Evidence requires validated Prepare and Scope artifacts.",
        ),
        requireChain(
          chain.scope,
          "Evidence requires validated Prepare and Scope artifacts.",
        ),
        adapters.evidence,
        {
          recordedAt,
          concurrency: runConfig.modelConcurrency,
          bm25CandidateLimit: runConfig.evidence.bm25CandidateLimit,
          selectionLimit: runConfig.evidence.selectionLimit,
          reranking: runConfig.evidence.rerankEnabled
            ? { enabled: true, topN: runConfig.evidence.rerankTopN }
            : { enabled: false },
        },
      ),
    build: buildEvidenceArtifact,
    count: (artifact) => artifact.payload.records.length,
    attach: (chain, artifact) => {
      chain.evidence = artifact;
    },
  }),

  adjudicate: defineStage({
    stageKey: "adjudicate",
    run: ({ chain, adapters, recordedAt, runConfig }) =>
      runAdjudicate(
        requireChain(
          chain.evidence,
          "Adjudicate requires validated Evidence and Prepare artifacts.",
        ),
        requireChain(
          chain.prepare,
          "Adjudicate requires validated Evidence and Prepare artifacts.",
        ),
        adapters.adjudicate,
        {
          recordedAt,
          concurrency: runConfig.modelConcurrency,
          evidence: runConfig.adjudicate.evidence,
        },
      ),
    build: buildAdjudicateArtifact,
    count: (artifact) => artifact.payload.records.length,
    attach: (chain, artifact) => {
      chain.adjudicate = artifact;
    },
  }),

  report: defineStage({
    stageKey: "report",
    run: ({ chain, recordedAt }) => {
      const missing = "Report requires the complete validated artifact chain.";
      return runReport(
        requireChain(chain.discover, missing),
        requireChain(chain.scope, missing),
        requireChain(chain.prepare, missing),
        requireChain(chain.evidence, missing),
        requireChain(chain.adjudicate, missing),
        { recordedAt },
      );
    },
    build: buildReportArtifact,
    writeAdditional: ({ runRoot, attemptStem, artifact, primaryPath }) => {
      const markdownPath = resolveReportMarkdownPath(runRoot, attemptStem);
      const written = writeReportArtifacts(primaryPath, markdownPath, artifact);
      return {
        paths: [written.markdownPath],
        reportArtifactPath: written.markdownPath,
      };
    },
    count: (artifact) => artifact.payload.recordTraces.length,
    attach: (chain, artifact) => {
      chain.report = artifact;
    },
  }),
};

/**
 * A mode switch starts from that mode's defaults (a portfolio's caps mean
 * nothing to `all`); portfolio flags then apply only to a portfolio, and the
 * CLI rejects them beside `all`.
 */
function buildCandidateSelectionFromCli(
  args: PipelineCliOverrides,
  base: AnalysisRunConfig["discover"]["candidateSelection"],
): AnalysisRunConfig["discover"]["candidateSelection"] {
  const mode = args.discoverCandidateSelectionMode ?? base.mode;
  if (mode === "all") {
    if (
      args.discoverMinFamilies != null ||
      args.discoverMaxFamilies != null ||
      args.discoverMaxPreparedRecords != null
    ) {
      throw new PipelineError(
        'Portfolio caps (--min-families, --max-families, --max-prepared-records) do not apply to candidate selection mode "all".',
      );
    }
    return base.mode === "all" ? base : defaultAllCandidatesPolicy;
  }
  const portfolio =
    base.mode === "adaptive_portfolio"
      ? base
      : RUN_CONFIG_DEFAULTS.discover.candidateSelection;
  return {
    ...portfolio,
    ...(args.discoverMinFamilies != null
      ? { minFamilies: args.discoverMinFamilies }
      : {}),
    ...(args.discoverMaxFamilies != null
      ? { maxFamilies: args.discoverMaxFamilies }
      : {}),
    ...(args.discoverMaxPreparedRecords != null
      ? { maxPreparedRecords: args.discoverMaxPreparedRecords }
      : {}),
  };
}

function buildConfigFromCli(
  args: PipelineCliOverrides,
  existing?: AnalysisRunConfig,
): AnalysisRunConfig {
  const base = existing ?? analysisRunConfigSchema.parse({});
  return analysisRunConfigSchema.parse({
    ...base,
    ...(args.forceRefresh != null ? { forceRefresh: args.forceRefresh } : {}),
    ...(args.stopAfterStage != null
      ? { stopAfterStage: args.stopAfterStage }
      : {}),
    ...(args.modelConcurrency != null
      ? { modelConcurrency: args.modelConcurrency }
      : {}),
    discover: {
      ...base.discover,
      ...(args.discoverNeighborhoodLimit != null
        ? { neighborhoodLimit: args.discoverNeighborhoodLimit }
        : {}),
      ...(args.discoverProbeBudget != null
        ? { probeBudget: args.discoverProbeBudget }
        : {}),
      ...(args.discoverFetchConcurrency != null
        ? { fetchConcurrency: args.discoverFetchConcurrency }
        : {}),
      candidateSelection: buildCandidateSelectionFromCli(
        args,
        base.discover.candidateSelection,
      ),
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
      ...(args.evidenceBm25CandidateLimit != null
        ? { bm25CandidateLimit: args.evidenceBm25CandidateLimit }
        : {}),
      ...(args.evidenceSelectionLimit != null
        ? { selectionLimit: args.evidenceSelectionLimit }
        : {}),
    },
    adjudicate: {
      ...base.adjudicate,
      ...(args.adjudicateModel != null ? { model: args.adjudicateModel } : {}),
      ...(args.adjudicateThinking != null
        ? { thinking: args.adjudicateThinking }
        : {}),
      ...(args.adjudicateEffort != null
        ? { effort: args.adjudicateEffort }
        : {}),
      ...(args.adjudicateEvidence != null
        ? { evidence: args.adjudicateEvidence }
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
      // Fetch concurrency changes wall time only, like modelConcurrency.
      return {
        forceRefresh: config.forceRefresh,
        discover: { ...config.discover, fetchConcurrency: undefined },
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
  provenanceStore: ReturnType<typeof createProvenanceStore>,
): {
  path: string;
  contentHash: string;
  sourceArtifact: ArtifactReference;
} {
  const path = resolveRunConfigPath(runRoot);
  const body = {
    role: "run-config",
    config,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  const sourceArtifact = provenanceStore.persist({
    role: "run-config",
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
    throw new PipelineError(
      `Cannot resume: stage ${stageKey} is not succeeded.`,
    );
  }
  if (!stage.primaryArtifactPath) {
    throw new PipelineError(
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
  chain.discover = loadArtifact("discover", discoverPath);
  if (chain.discover.runId !== runId) {
    throw new PipelineError(
      `Discover artifact runId mismatch (artifact=${chain.discover.runId}, run=${runId}).`,
    );
  }
  if (throughStage === "discover") return chain;

  const scopePath = loadSucceededArtifact(database, runId, "scope");
  chain.scope = loadArtifact("scope", scopePath);
  if (
    chain.scope.payload.discoverArtifact.artifactId !==
      chain.discover.artifactId ||
    chain.scope.payload.discoverArtifact.contentHash !==
      chain.discover.contentHash
  ) {
    throw new PipelineError(
      "Scope artifact does not match Discover lineage; refusing silent recomputation.",
    );
  }
  if (throughStage === "scope") return chain;

  const preparePath = loadSucceededArtifact(database, runId, "prepare");
  chain.prepare = loadArtifact("prepare", preparePath);
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
    throw new PipelineError(
      "Prepare artifact lineage mismatch; refusing silent recomputation.",
    );
  }
  if (throughStage === "prepare") return chain;

  const evidencePath = loadSucceededArtifact(database, runId, "evidence");
  chain.evidence = loadArtifact("evidence", evidencePath);
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
    throw new PipelineError(
      "Evidence artifact lineage mismatch; refusing silent recomputation.",
    );
  }
  if (throughStage === "evidence") return chain;

  const adjudicatePath = loadSucceededArtifact(database, runId, "adjudicate");
  chain.adjudicate = loadArtifact("adjudicate", adjudicatePath);
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
    throw new PipelineError(
      "Adjudicate artifact lineage mismatch; refusing silent recomputation.",
    );
  }
  if (throughStage === "adjudicate") return chain;

  const reportPath = loadSucceededArtifact(database, runId, "report");
  chain.report = loadArtifact("report", reportPath);
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
    throw new PipelineError(
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
  const stages = listRunStages(database, runId);
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
    });
    cursor = getNextStageKey(cursor);
  }
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export async function runPipeline(
  params: RunPipelineParams,
): Promise<{ runId: string; runRoot: string }> {
  const { args, config, database } = params;
  const now = params.now ?? (() => new Date());
  runMigrations(database);

  if (args.runId && args.input) {
    throw new PipelineError(
      "Pass either --run-id (resume) or --input (fresh DOI-first run), not both.",
    );
  }
  if (!args.runId && !args.input) {
    throw new PipelineError(
      "The pipeline requires --input dois.json (DOI-first) or --run-id for resume.",
    );
  }

  let run: AnalysisRun;
  let runConfig: AnalysisRunConfig;
  let seedDois: [string, ...string[]];
  let isResume = false;

  if (args.runId) {
    const existing = getAnalysisRun(database, args.runId);
    if (!existing) {
      throw new PipelineError(`Unknown run id: ${args.runId}`);
    }
    seedDois = readDoisFromFile(resolveDoiInputPath(existing.runRoot)) as [
      string,
      ...string[],
    ];
    runConfig = buildConfigFromCli(args, existing.config);
    if (compareStageKeys(runConfig.stopAfterStage, existing.targetStage) < 0) {
      throw new PipelineError(
        `Cannot shrink run target from ${existing.targetStage} to ${runConfig.stopAfterStage}; extend the target or start a new run.`,
      );
    }
    if (
      args.rerunFromStage &&
      compareStageKeys(args.rerunFromStage, runConfig.stopAfterStage) > 0
    ) {
      throw new PipelineError(
        `--rerun-from ${args.rerunFromStage} cannot be later than --stop-after ${runConfig.stopAfterStage}.`,
      );
    }
    if (seedDois.length > 1 && runConfig.scope.seedPdfPath) {
      throw new PipelineError("--seed-pdf is only valid for a single-DOI run.");
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
        throw new PipelineError(
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
      const rerunStage = assertStageKey(args.rerunFromStage, "--rerun-from");
      markDownstreamStagesStale(database, run.id, rerunStage);
    }
  } else {
    if (args.rerunFromStage) {
      throw new PipelineError("--rerun-from is only valid with --run-id.");
    }
    seedDois = readDoisFromFile(args.input!) as [string, ...string[]];
    const seedDoi = seedDois[0];
    if (seedDois.length > 1 && args.seedPdfPath) {
      throw new PipelineError(
        "--seed-pdf cannot represent multiple DOI seeds.",
      );
    }
    if (seedDois.length !== 1) {
      log(
        "pipeline",
        `Discover accepts multiple DOIs in the input artifact; run seedDoi tracking uses the first (${seedDoi}).`,
      );
    }
    const stopAfter = args.stopAfterStage
      ? assertStageKey(args.stopAfterStage, "--stop-after")
      : "report";
    runConfig = buildConfigFromCli({ ...args, stopAfterStage: stopAfter });
    const runId = randomUUID();
    const runRoot = resolve(process.cwd(), "data", "runs", runId);
    mkdirSync(runRoot, { recursive: true });
    mkdirSync(resolve(runRoot, "logs"), { recursive: true });
    for (const stage of stageDefinitions) {
      resolveStageDirectory(runRoot, stage.key);
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

  const stopAfter = assertStageKey(runConfig.stopAfterStage, "stopAfterStage");
  const tracker = new RunTracker(database, run.id);
  if (args.regenerateCodebook === true) {
    const firstToRun = firstIncompleteStage(database, run.id, stopAfter);
    if (
      firstToRun == null ||
      compareStageKeys(firstToRun, "scope") > 0 ||
      compareStageKeys(stopAfter, "scope") < 0
    ) {
      throw new PipelineError(
        "--regenerate-codebook needs Scope to run in this invocation; add --rerun-from scope (or discover).",
      );
    }
  }

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
    const provenanceStore = createProvenanceStore(run.runRoot);
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
      log("pipeline", "All stages through stopAfter already succeeded.");
      setRunStatus(database, run.id, "succeeded");
      return { runId: run.id, runRoot: run.runRoot };
    }

    const costs = createRunCostTracker(run.runRoot);
    const llmClient =
      params.llmClient ??
      createLLMClient({
        apiKey: params.apiKey ?? "",
        collector: costs.collector,
        database,
        // Without this the exact-result cache still serves stale completions
        // on a --force-refresh run while provenance claims it was bypassed.
        forceRefresh: runConfig.forceRefresh,
        ...(args.maxCostUsd != null
          ? {
              spendLimit: {
                maxUsd: args.maxCostUsd,
                spentUsd: costs.spentUsd,
              },
            }
          : {}),
        ...(args.batch === true ? { batch: {} } : {}),
      });
    const stageRunConfig: AnalysisRunConfig =
      args.batch === true
        ? { ...runConfig, modelConcurrency: BATCH_MODEL_CONCURRENCY }
        : runConfig;
    const adapters =
      params.adapters ??
      buildProductionAdapters({
        config,
        runConfig,
        llmClient,
        provenanceStore,
        forceRefresh: runConfig.forceRefresh,
        codebookStore: createSqliteSeedCodebookStore(database),
        regenerateCodebook: args.regenerateCodebook === true,
        runId: run.id,
        paperCache: {
          db: database,
          cachePolicy: runConfig.forceRefresh
            ? "force_refresh"
            : "prefer_cache",
        },
      });

    const doiProvenance = provenanceStore.persist({
      role: "doi-input",
      body: { dois: seedDois },
      stage: "discover",
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

      tracker.stageStart(stageKey);
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
        const runner = STAGE_RUNNERS[stageKey];
        const written = await runner.execute({
          runId: run.id,
          runRoot: run.runRoot,
          recordedAt,
          runConfig: stageRunConfig,
          seedDois,
          doiProvenance,
          configuration: {
            contentHash: configProvenance.contentHash,
            sourceArtifact: configProvenance.sourceArtifact,
          },
          adapters,
          chain,
        });
        completedCount = written.completedCount;
        const manifestPath = writeStageManifest(
          written.primaryPath,
          written.artifact,
          written.additionalPaths,
        );
        updateStageStatus(database, run.id, stageKey, "succeeded", {
          primaryArtifactPath: written.primaryPath,
          ...(written.reportArtifactPath
            ? { reportArtifactPath: written.reportArtifactPath }
            : {}),
          manifestPath,
          finishedAt: now().toISOString(),
          summary: written.summary,
        });

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
        });
        blockDownstream(
          database,
          run.id,
          stageKey,
          `Blocked: upstream stage ${stageKey} failed — ${message}`,
        );
        setRunStatus(database, run.id, "failed", stageKey);
        costs.write(llmClient.getLedger());
        throw error;
      }

      const spend = costs.write(llmClient.getLedger());
      const stageSpend = spend.attempt.byStage.find(
        (entry) => entry.stage === stageKey,
      );
      reporter.log(
        `Cost: ${formatUsd(stageSpend?.estimatedCostUsd ?? 0)} over ${String(stageSpend?.calls ?? 0)} model calls${stageSpend?.batchCalls ? ` (${String(stageSpend.batchCalls)} at batch price)` : ""}; run so far ${formatUsd(spend.run.totalEstimatedCostUsd)}`,
      );
    }

    const cost = costs.write(llmClient.getLedger()).run;
    setRunStatus(database, run.id, "succeeded");
    log(
      "pipeline",
      isResume
        ? `Resume complete for run ${run.id}`
        : `Pipeline complete for run ${run.id}`,
    );
    const reportPath = getRunStage(
      database,
      run.id,
      "report",
    )?.reportArtifactPath;
    log("pipeline", `Run root: ${run.runRoot}`);
    if (reportPath) log("pipeline", `Report: ${reportPath}`);
    log(
      "pipeline",
      `Estimated cost: $${cost.totalEstimatedCostUsd.toFixed(2)} over ${String(cost.totalCalls)} model calls`,
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
